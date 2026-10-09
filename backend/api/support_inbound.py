"""
support_inbound.py
------------------
Turns email sent to support@etymos.site into ticket messages. A background
thread logs into the mailbox over IMAP every SUPPORT_POLL_SECONDS and, for
each message in INBOX:

1. Claims it in support_inbound_log by Message-ID (once only, however many
   backend processes poll).
2. Skips our own mail and robots: vacation replies, bounces, mailing lists.
3. Finds the ticket: In-Reply-To/References against the Message-IDs we
   stored, then our own id format, then a "[#1042]" subject tag. A header
   match from an address that isn't the requester's is kept but flagged
   (sender_mismatch) and doesn't reopen the ticket; a subject tag alone
   only counts from the requester's own address, since anyone can type one.
4. Cuts the quoted history (support emails carry a reply marker line; the
   usual "On ... wrote:" headers are recognised too), keeps attachments the
   form would accept, stores the raw .eml.
5. Appends to the ticket, or opens a new one (unmatched email, or a reply to
   a closed ticket), and moves the email to the "Processed" folder.
   Emails that fail go to "Support-Failed" for a person to look at.

OneMail has no plus-addressing (tested 2026-10-08), so reply addresses carry
no per-ticket token; matching relies on the headers above.

Only mail received in the last SUPPORT_INBOUND_LOOKBACK_DAYS (default 2) is
read, so turning the poller on doesn't import an old mailbox.

The same loop closes resolved tickets after support.AUTO_CLOSE_AFTER.

Configuration: support_mail.py (SUPPORT_IMAP_*), plus
  SUPPORT_POLLER=off             disable the IMAP part
  SUPPORT_POLL_SECONDS=60
"""

from __future__ import annotations

import email
import hashlib
import html
import imaplib
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email import policy
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Optional

import notifications
import support
import support_mail
from email_templates import SUPPORT_REPLY_MARKER
from supabase_client import get_client

logger = logging.getLogger(__name__)

LOG = "support_inbound_log"
PROCESSED_FOLDER = "Processed"
FAILED_FOLDER = "Support-Failed"
BATCH = 25
MAX_RAW_BYTES = 25 * 1024 * 1024
STALE_CLAIM = timedelta(minutes=15)

# Message-IDs; characters PostgREST filters treat specially are excluded, so
# the ids can go into an in_() lookup as they are.
_ID_RE = re.compile(r"<[^<>\s,()\"\\]+>")
_SUBJECT_TAG_RE = re.compile(r"\[#(\d{3,9})\]")


# --- parsing ---------------------------------------------------------------------


@dataclass
class ParsedEmail:
    message_id: str
    subject: str
    from_address: str
    from_name: str
    references: list[str]  # In-Reply-To first, then References newest first
    text: str
    files: list[support.IncomingFile] = field(default_factory=list)
    auto_reason: Optional[str] = None
    sender_auth: str = "none"


def _header(msg: EmailMessage, name: str) -> str:
    try:
        return str(msg.get(name) or "").strip()
    except Exception:  # a malformed header the parser can't read
        return ""


_AUTO_SUBJECT_RE = re.compile(
    r"^(auto(matic)?[ -]?(reply|response)|out of (the )?office|undeliver|delivery status notification"
    r"|mail delivery (failed|subsystem)|returned mail|trả lời tự động|vắng mặt)",
    re.IGNORECASE,
)
_ROBOT_LOCAL_RE = re.compile(r"^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+.\-]|$)", re.IGNORECASE)


def auto_reason(msg: EmailMessage, from_address: str, subject: str) -> Optional[str]:
    auto = _header(msg, "Auto-Submitted").lower()
    if auto and auto != "no":
        return f"Auto-Submitted: {auto}"
    if _header(msg, "Precedence").lower() in ("bulk", "junk", "list", "auto_reply"):
        return "Precedence"
    for name in ("List-Id", "List-Unsubscribe", "X-Autoreply", "X-Autorespond"):
        if _header(msg, name):
            return name
    if msg.get_content_type() == "multipart/report":
        return "delivery report"
    if _header(msg, "Return-Path") == "<>":
        return "null return path"
    if _ROBOT_LOCAL_RE.match(from_address.split("@")[0]):
        return "robot sender"
    if _AUTO_SUBJECT_RE.match(subject):
        return "automatic subject"
    return None


def sender_auth(msg: EmailMessage) -> str:
    """Verdict of the topmost Authentication-Results header, which our own
    mail server adds. Senders can add their own further down, so only the
    first one counts. "none" when the server adds none."""
    results = msg.get_all("Authentication-Results") or []
    if not results:
        return "none"
    top = str(results[0]).lower()
    if "dmarc=pass" in top:
        return "pass"
    if "dmarc=fail" in top:
        return "fail"
    if "dkim=pass" in top or "spf=pass" in top:
        return "pass"
    if "dkim=fail" in top or "spf=fail" in top or "spf=softfail" in top:
        return "fail"
    return "none"


_HTML_QUOTE_RE = re.compile(
    r'<(div|blockquote)[^>]*(class="[^"]*(gmail_quote|yahoo_quoted|moz-cite-prefix)[^"]*"|id="(x_)?divRplyFwdMsg"|type="cite")[^>]*>.*',
    re.IGNORECASE | re.DOTALL,
)


def html_to_text(markup: str) -> str:
    markup = _HTML_QUOTE_RE.sub("", markup)
    markup = re.sub(r"(?is)<(script|style|head|title)[^>]*>.*?</\1>", "", markup)
    markup = re.sub(r"(?i)<br\s*/?>", "\n", markup)
    markup = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|blockquote)>", "\n", markup)
    markup = re.sub(r"<[^>]+>", "", markup)
    text = html.unescape(markup).replace("\xa0", " ")
    return re.sub(r"\n{3,}", "\n\n", text)


def _decode(part) -> str:
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        return payload.decode(part.get_content_charset() or "utf-8", errors="replace")


def body_and_files(msg: EmailMessage) -> tuple[str, list[support.IncomingFile]]:
    plain, rich, files = None, None, []
    for part in msg.walk():
        if part.is_multipart():
            continue
        disposition = part.get_content_disposition()
        filename = part.get_filename()
        ctype = part.get_content_type()
        if disposition == "attachment" or (filename and disposition != "inline") or (
            filename and not ctype.startswith("text/")
        ):
            data = part.get_payload(decode=True) or b""
            files.append(support.IncomingFile(filename or "attachment", ctype, data))
        elif ctype == "text/plain" and plain is None:
            plain = _decode(part)
        elif ctype == "text/html" and rich is None:
            rich = _decode(part)
    text = plain if plain and plain.strip() else html_to_text(rich or "")
    return text, files


def parse_email(raw: bytes) -> ParsedEmail:
    msg = email.message_from_bytes(raw, policy=policy.default)
    name, address = parseaddr(_header(msg, "From"))
    address = address.strip().lower()
    subject = re.sub(r"\s+", " ", _header(msg, "Subject")).strip()
    message_id = (_ID_RE.findall(_header(msg, "Message-ID")) or [None])[0]
    if message_id is None:
        message_id = f"<{hashlib.sha256(raw).hexdigest()}@no-message-id.invalid>"
    refs = _ID_RE.findall(_header(msg, "In-Reply-To")) + list(reversed(_ID_RE.findall(_header(msg, "References"))))
    text, files = body_and_files(msg)
    return ParsedEmail(
        message_id=message_id,
        subject=subject,
        from_address=address,
        from_name=name.strip(),
        references=list(dict.fromkeys(refs)),
        text=text,
        files=files,
        auto_reason=auto_reason(msg, address, subject),
        sender_auth=sender_auth(msg),
    )


# --- cutting the quoted history ---------------------------------------------------

_MARKER_PARTS = [p.strip() for p in SUPPORT_REPLY_MARKER.strip("#- ").split("/")]
_QUOTE_HEADER_RES = [
    re.compile(r"^on\b.{0,300}\bwrote:?$", re.IGNORECASE),  # Gmail, Apple Mail, Thunderbird
    re.compile(r"^vào\b.{0,300}\bđã viết:?$", re.IGNORECASE),  # Gmail in Vietnamese
    re.compile(r"^le\b.{0,300}\ba écrit\s?:?$", re.IGNORECASE),
    re.compile(r"^-{2,}\s*(original message|forwarded message|thư gốc)\s*-{2,}$", re.IGNORECASE),
    re.compile(r"^_{10,}$"),  # Outlook's separator before From:/Sent:
    re.compile(r"^(from|từ):\s.+", re.IGNORECASE),  # Outlook header block (checked with the next line)
]
_SIGNOFF_RES = [
    re.compile(r"^sent from my \w+", re.IGNORECASE),
    re.compile(r"^(get|download) outlook for", re.IGNORECASE),
    re.compile(r"^gửi từ .+ của tôi", re.IGNORECASE),
]


def _is_marker(line: str) -> bool:
    bare = line.lstrip("> ").strip()
    return any(part and part in bare for part in _MARKER_PARTS)


def _is_quote_header(lines: list[str], i: int) -> bool:
    line = lines[i].strip()
    joined = (line + " " + lines[i + 1].strip()) if i + 1 < len(lines) else line
    for rx in _QUOTE_HEADER_RES[:-1]:
        if rx.match(line) or rx.match(joined):
            return True
    if _QUOTE_HEADER_RES[-1].match(line):
        # Outlook: From: ... followed within a few lines by Sent:/Date:/To:
        following = " ".join(l.strip().lower() for l in lines[i + 1 : i + 4])
        return any(k in following for k in ("sent:", "date:", "đã gửi:", "ngày:", "to:", "subject:"))
    return False


def strip_reply(text: str) -> str:
    """The new part of a reply: everything above the reply marker, the
    "On ... wrote:" line, an Outlook header block or a signature delimiter,
    minus trailing quoted lines and "Sent from my phone" lines. Falls back to
    the whole text when that would leave nothing (e.g. bottom-posting)."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cut = len(lines)
    for i, line in enumerate(lines):
        # "-- " is the standard signature delimiter.
        if _is_marker(line) or line.rstrip() == "--" or _is_quote_header(lines, i):
            cut = i
            break
    kept = lines[:cut]
    while kept and (not kept[-1].strip() or kept[-1].lstrip().startswith(">")):
        kept.pop()
    while kept and any(rx.match(kept[-1].strip()) for rx in _SIGNOFF_RES):
        kept.pop()
        while kept and not kept[-1].strip():
            kept.pop()
    result = "\n".join(kept).strip()
    return result or text.strip()


# --- matching --------------------------------------------------------------------


def _messages_by_ids(client, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    return client.table(support.MESSAGES).select("ticket_id,email_message_id").in_("email_message_id", ids).execute().data or []


def account_addresses(client, ticket: dict) -> set[str]:
    """Addresses that count as the requester: the ticket's own, plus the
    owner's login and confirmed recovery address."""
    addresses = {ticket["requester_email"]}
    user_id = ticket.get("user_id")
    if user_id:
        rows = client.table("profiles").select("email").eq("id", user_id).limit(1).execute().data or []
        addresses |= {(r.get("email") or "").lower() for r in rows}
        rows = (
            client.table("recovery_emails").select("email,verified_at").eq("user_id", user_id).execute().data or []
        )
        addresses |= {r["email"].lower() for r in rows if r.get("verified_at")}
    addresses.discard("")
    return addresses


def find_ticket(client, parsed: ParsedEmail) -> tuple[Optional[dict], bool]:
    """(ticket, sender_matches). None when nothing ties the email to a
    ticket the sender may write to."""
    by_header: Optional[dict] = None
    found = {m["email_message_id"]: m["ticket_id"] for m in _messages_by_ids(client, parsed.references)}
    for ref in parsed.references:
        if ref in found:
            by_header = support.ticket_by_id(client, found[ref])
            break
        own = support_mail.OWN_MESSAGE_ID_RE.match(ref)
        if own:
            by_header = support.ticket_by_number(client, int(own.group(1)))
            break
    if by_header is not None:
        return by_header, parsed.from_address in account_addresses(client, by_header)

    tag = _SUBJECT_TAG_RE.search(parsed.subject)
    if tag:
        ticket = support.ticket_by_number(client, int(tag.group(1)))
        if ticket is not None and parsed.from_address in account_addresses(client, ticket):
            return ticket, True
    return None, False


# --- processing one email ------------------------------------------------------------


def _claim(client, parsed: ParsedEmail) -> bool:
    """True when this process should handle the email now."""
    row = {
        "message_id": parsed.message_id,
        "from_address": parsed.from_address[:254],
        "subject": parsed.subject[:300],
        "outcome": "processing",
    }
    claimed = client.table(LOG).upsert(row, on_conflict="message_id", ignore_duplicates=True).execute().data
    if claimed:
        return True
    existing = client.table(LOG).select("*").eq("message_id", parsed.message_id).limit(1).execute().data or []
    if existing and existing[0]["outcome"] == "processing":
        # Another process died halfway: take it over once the claim is old.
        updated = notifications._parse_ts(existing[0].get("updated_at"))
        if updated is not None and datetime.now(timezone.utc) - updated > STALE_CLAIM:
            client.table(LOG).update({"updated_at": support._iso()}).eq("message_id", parsed.message_id).execute()
            return True
    return False


def _finish(client, parsed: ParsedEmail, outcome: str, ticket: Optional[dict] = None, detail: str = "") -> str:
    client.table(LOG).update(
        {
            "outcome": outcome,
            "ticket_id": ticket["id"] if ticket else None,
            "detail": detail[:1000] or None,
            "updated_at": support._iso(),
        }
    ).eq("message_id", parsed.message_id).execute()
    return outcome


def _store_raw(client, ticket_id: str, raw: bytes) -> Optional[str]:
    if len(raw) > MAX_RAW_BYTES:
        return None
    path = f"{ticket_id}/raw/{uuid.uuid4().hex}.eml"
    try:
        client.storage.from_(support.BUCKET).upload(path, raw, file_options={"content-type": "message/rfc822"})
        return path
    except Exception:
        logger.exception("Couldn't store raw email for ticket %s", ticket_id)
        return None


def _own_addresses() -> set[str]:
    own = {support_mail.support_address()}
    for name in ("SUPPORT_SMTP_USER", "SMTP_USER"):
        if os.getenv(name):
            own.add(os.getenv(name).strip().lower())
    return own


def process(client, raw: bytes) -> str:
    """Handles one email; returns its outcome (or "skipped" when another
    process owns it)."""
    parsed = parse_email(raw)
    if not _claim(client, parsed):
        existing = client.table(LOG).select("outcome").eq("message_id", parsed.message_id).limit(1).execute().data
        return existing[0]["outcome"] if existing and existing[0]["outcome"] != "processing" else "skipped"

    if parsed.from_address in _own_addresses() or support_mail.OWN_MESSAGE_ID_RE.match(parsed.message_id):
        return _finish(client, parsed, "ignored_own")
    if parsed.auto_reason:
        return _finish(client, parsed, "ignored_auto", detail=parsed.auto_reason)
    if "@" not in parsed.from_address:
        return _finish(client, parsed, "ignored_auto", detail="no sender address")

    files, dropped = support.accept_files(parsed.files)
    body = support.clean_text(strip_reply(parsed.text), limit=support.MAX_BODY)
    if dropped:
        body += "\n\n[Attachments not kept (type or size not allowed): " + ", ".join(dropped)[:500] + "]"
    if not body.strip():
        body = "(empty message)"

    ticket, sender_ok = find_ticket(client, parsed)
    fields = {
        "email_message_id": parsed.message_id,
        "sender_auth": parsed.sender_auth,
        "sender_email": parsed.from_address,
    }

    if ticket is not None and ticket["status"] != "closed":
        ticket, message = support.add_requester_message(
            client,
            ticket,
            body=body,
            channel="email",
            author_id=ticket.get("user_id") if sender_ok else None,
            files=files,
            sender_mismatch=not sender_ok,
            **fields,
        )
        _attach_raw(client, message, ticket["id"], raw)
        support.alert_agents(ticket, message, is_new=False)
        return _finish(client, parsed, "appended", ticket)

    previous = ticket  # closed ticket being written to again, or None
    subject = support.clean_subject(parsed.subject) or "(no subject)"
    new_ticket, message = support.create_ticket(
        client,
        requester_email=parsed.from_address,
        requester_name=support.clean_subject(parsed.from_name)[: support.MAX_NAME] or None,
        user_id=previous.get("user_id") if previous and sender_ok else None,
        identity_verified=False,
        category=previous["category"] if previous else "other",
        subject=subject,
        body=body,
        source="email",
        channel="email",
        files=files,
        previous_ticket_id=previous["id"] if previous else None,
        **fields,
    )
    _attach_raw(client, message, new_ticket["id"], raw)
    support.send_acknowledgement(new_ticket, body)
    support.alert_agents(new_ticket, message, is_new=True)
    return _finish(client, parsed, "ticket_created", new_ticket, detail=f"after closed #{previous['number']}" if previous else "")


def _attach_raw(client, message: dict, ticket_id: str, raw: bytes) -> None:
    path = _store_raw(client, ticket_id, raw)
    if path:
        client.table(support.MESSAGES).update({"raw_email_path": path}).eq("id", message["id"]).execute()


# --- the mailbox ----------------------------------------------------------------------


def _move(imap: imaplib.IMAP4, uid: bytes, folder: str, can_move: bool) -> None:
    if can_move:
        typ, _ = imap.uid("MOVE", uid, folder)
        if typ == "OK":
            return
    typ, _ = imap.uid("COPY", uid, folder)
    if typ == "OK":
        imap.uid("STORE", uid, "+FLAGS", "(\\Deleted)")
        imap.expunge()


def poll_once(client=None) -> dict[str, int]:
    client = client or get_client()
    settings = support_mail.imap_settings()
    if client is None or settings is None:
        return {}
    host, user, password = settings
    lookback = max(1, int(os.getenv("SUPPORT_INBOUND_LOOKBACK_DAYS", "2")))
    since = (datetime.now(timezone.utc) - timedelta(days=lookback)).strftime("%d-%b-%Y")
    counts: dict[str, int] = {}
    with imaplib.IMAP4_SSL(host, 993, timeout=30) as imap:
        imap.login(user, password)
        for folder in (PROCESSED_FOLDER, FAILED_FOLDER):
            imap.create(folder)  # "already exists" is fine
        can_move = "MOVE" in imap.capabilities
        imap.select("INBOX")
        typ, data = imap.uid("SEARCH", None, "SINCE", since)
        if typ != "OK":
            return counts
        for uid in (data[0] or b"").split()[:BATCH]:
            typ, fetched = imap.uid("FETCH", uid, "(BODY.PEEK[])")
            raw = next((part[1] for part in fetched or [] if isinstance(part, tuple)), None)
            if typ != "OK" or raw is None:
                continue
            try:
                outcome = process(client, raw)
            except Exception as exc:
                logger.exception("Couldn't process support email uid=%s", uid)
                outcome = _record_failure(client, raw, exc)
            counts[outcome] = counts.get(outcome, 0) + 1
            if outcome == "skipped" or outcome == "processing":
                continue
            _move(imap, uid, FAILED_FOLDER if outcome == "failed" else PROCESSED_FOLDER, can_move)
    if any(k != "skipped" for k in counts):
        logger.info("Support inbox: %s", counts)
    return counts


def _record_failure(client, raw: bytes, exc: Exception) -> str:
    """Marks the email failed so it is moved aside for a person; if even that
    fails (database down), leaves it in INBOX to retry next time."""
    try:
        parsed = parse_email(raw)
        client.table(LOG).upsert(
            {
                "message_id": parsed.message_id,
                "from_address": parsed.from_address[:254],
                "subject": parsed.subject[:300],
                "outcome": "failed",
                "detail": f"{type(exc).__name__}: {exc}"[:1000],
                "updated_at": support._iso(),
            },
            on_conflict="message_id",
        ).execute()
        return "failed"
    except Exception:
        logger.exception("Couldn't record the failure either; will retry")
        return "processing"


# --- background loop --------------------------------------------------------------------

_thread: Optional[threading.Thread] = None


def poller_enabled() -> bool:
    return os.getenv("SUPPORT_POLLER", "on").lower() != "off" and support_mail.imap_settings() is not None


def start() -> None:
    """Background thread: read the support inbox and close stale resolved
    tickets every SUPPORT_POLL_SECONDS (default 60)."""
    global _thread
    if _thread is not None:
        return
    interval = max(30, int(os.getenv("SUPPORT_POLL_SECONDS", "60")))

    def loop() -> None:
        time.sleep(20)  # let the app finish starting
        while True:
            client = get_client()
            if client is not None:
                try:
                    support.close_stale_resolved(client)
                except Exception:
                    logger.exception("Closing stale support tickets failed")
                if poller_enabled():
                    try:
                        poll_once(client)
                    except Exception:
                        logger.exception("Support inbox poll failed")
            time.sleep(interval)

    _thread = threading.Thread(target=loop, name="support-inbox", daemon=True)
    _thread.start()
    logger.info("Support loop started (every %ss, inbox polling %s)", interval, "on" if poller_enabled() else "off")

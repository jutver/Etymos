"""
support.py
----------
Support tickets: the /contact form, "My requests", the guest view, and the
admin inbox. Tables: supabase/migrations/20261009000000_support.sql.

Requesters (signed in or not):
  POST /api/support/tickets                         open a ticket (form, files)
  GET  /api/support/tickets                         my tickets
  GET  /api/support/tickets/{number}                one of my tickets
  POST /api/support/tickets/{number}/messages       reply on the site
  GET  /api/support/guest/{token}                   a ticket by its email link
  POST /api/support/guest/{token}/messages          reply through that link

Admins:
  GET   /api/admin/support/summary                  counts for the nav badge
  GET   /api/admin/support/agents                   who tickets can be assigned to
  GET   /api/admin/support/tickets                  inbox (status, category, assignee, search)
  GET   /api/admin/support/tickets/{number}         everything, internal notes included
  POST  /api/admin/support/tickets/{number}/messages  reply (emailed) or internal note
  PATCH /api/admin/support/tickets/{number}         status, priority, assignee, category

"My tickets" are those opened while signed in, plus any opened from the
account's login address (guest form or email): signing in proves the
address. Guest and email tickets carry identity_verified=false, because a
From header can be forged and a guest can type anyone's address; agents
must not change an account on the strength of one.

Statuses: open (waiting on us), pending (waiting on the requester),
resolved, closed. A requester's message reopens an open/pending/resolved
ticket; a closed ticket stays closed and a new reply opens a new ticket that
points back to it. Resolved tickets close by themselves after
AUTO_CLOSE_AFTER (support_inbound.py runs close_stale_resolved).

Email replies come back through support_inbound.py, which uses
create_ticket / add_requester_message from here.
"""

# No `from __future__ import annotations`: slowapi wraps the limited routes,
# and FastAPI resolves string annotations against the wrapper's module.
import hashlib
import hmac
import logging
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

import notifications
import support_mail
from auth import AuthedUser, verify_supabase_jwt
from email_templates import (
    SUPPORT_CATEGORIES,
    support_agent_alert_email,
    support_agent_reply_email,
    support_received_email,
)
from rate_limit import ip_key, limiter
from recovery_email import normalize_email
from supabase_client import get_client

logger = logging.getLogger(__name__)

router = APIRouter()

TICKETS = "support_tickets"
MESSAGES = "support_messages"
ATTACHMENTS = "support_attachments"
BUCKET = "support-attachments"

CATEGORIES = tuple(SUPPORT_CATEGORIES)
STATUSES = ("open", "pending", "resolved", "closed")
MAX_SUBJECT = 200
MAX_BODY = 10_000
MAX_NAME = 120
MAX_FILES = 5
MAX_FILE_BYTES = 5 * 1024 * 1024
SIGNED_URL_SECONDS = 600
AUTO_CLOSE_AFTER = timedelta(days=7)
# Per requester address, whatever the IP: stops the form being used to send
# our acknowledgement email to someone else's inbox over and over.
TICKETS_PER_EMAIL_PER_HOUR = 3

RATE_LIMIT_SUPPORT_CREATE = os.getenv("RATE_LIMIT_SUPPORT_CREATE", "5/hour")
RATE_LIMIT_SUPPORT_REPLY = os.getenv("RATE_LIMIT_SUPPORT_REPLY", "30/hour")
RATE_LIMIT_SUPPORT_GUEST = os.getenv("RATE_LIMIT_SUPPORT_GUEST", "60/hour")

Status = Literal["open", "pending", "resolved", "closed"]


# --- small helpers ---------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or _now()).isoformat()


def _client():
    client = get_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Support is not configured on this server.")
    return client


def web_url() -> str:
    return (os.getenv("WEB_APP_URL") or "https://www.etymos.site").rstrip("/")


def admin_url() -> Optional[str]:
    return os.getenv("ADMIN_APP_URL", "").strip() or None


def clean_text(value: Optional[str], *, limit: int) -> str:
    """Trimmed, NULs and other control characters (except tab/newline)
    removed, Windows line endings folded."""
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
    return text[:limit] if len(text) > limit else text


def clean_subject(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", clean_text(value, limit=MAX_SUBJECT * 2))[:MAX_SUBJECT].strip()


# --- guest links ----------------------------------------------------------------


def _link_secret() -> Optional[bytes]:
    secret = os.getenv("SUPPORT_LINK_SECRET", "")
    return secret.encode("utf-8") if len(secret) >= 32 else None


def guest_token(ticket_id: str) -> Optional[str]:
    """`{ticket uuid hex}.{hmac}`; None when SUPPORT_LINK_SECRET is unset
    (emails then go out without a view link)."""
    secret = _link_secret()
    if secret is None:
        return None
    tid = uuid.UUID(ticket_id).hex
    sig = hmac.new(secret, f"support-link:{tid}".encode(), hashlib.sha256).hexdigest()[:40]
    return f"{tid}.{sig}"


def ticket_id_from_guest_token(token: str) -> Optional[str]:
    secret = _link_secret()
    match = re.fullmatch(r"([0-9a-f]{32})\.([0-9a-f]{40})", token or "")
    if secret is None or not match:
        return None
    tid, sig = match.groups()
    expected = hmac.new(secret, f"support-link:{tid}".encode(), hashlib.sha256).hexdigest()[:40]
    if not hmac.compare_digest(sig, expected):
        return None
    return str(uuid.UUID(tid))


def view_url(ticket: dict) -> Optional[str]:
    if ticket.get("user_id"):
        return f"{web_url()}/account/support/{ticket['number']}"
    token = guest_token(ticket["id"])
    return f"{web_url()}/support/t/{token}" if token else None


# --- attachments ----------------------------------------------------------------


@dataclass
class IncomingFile:
    filename: str
    content_type: str
    data: bytes


_SIGNATURES = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF-", "application/pdf"),
]


def sniff_type(data: bytes) -> Optional[str]:
    """The real type from the file's first bytes; the browser's or mail
    client's claimed type is ignored."""
    for magic, kind in _SIGNATURES:
        if data.startswith(magic):
            return kind
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def safe_filename(name: Optional[str], content_type: str) -> str:
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^\w.\- ()]+", "_", base, flags=re.UNICODE).strip(" ._")[:100]
    ext = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "application/pdf": ".pdf",
    }[content_type]
    if not base:
        base = "attachment"
    if not base.lower().endswith(ext) and not (ext == ".jpg" and base.lower().endswith(".jpeg")):
        base += ext
    return base


def validate_files(files: List[IncomingFile]) -> List[IncomingFile]:
    """Raises 400 for the form; the inbound poller filters instead
    (accept_files)."""
    if len(files) > MAX_FILES:
        raise HTTPException(status_code=400, detail="too_many_files")
    checked = []
    for f in files:
        if len(f.data) > MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail="file_too_large")
        kind = sniff_type(f.data)
        if kind is None:
            raise HTTPException(status_code=400, detail="file_type")
        checked.append(IncomingFile(safe_filename(f.filename, kind), kind, f.data))
    return checked


def accept_files(files: List[IncomingFile]) -> tuple[List[IncomingFile], List[str]]:
    """Inbound email: keep what the form would accept, name what was dropped."""
    kept, dropped = [], []
    for f in files:
        kind = sniff_type(f.data)
        if kind is None or len(f.data) > MAX_FILE_BYTES or len(kept) >= MAX_FILES:
            dropped.append(f.filename or "attachment")
            continue
        kept.append(IncomingFile(safe_filename(f.filename, kind), kind, f.data))
    return kept, dropped


async def read_uploads(files: Optional[List[UploadFile]]) -> List[IncomingFile]:
    out = []
    for upload in files or []:
        if not upload.filename:
            continue
        data = await upload.read(MAX_FILE_BYTES + 1)
        out.append(IncomingFile(upload.filename, upload.content_type or "", data))
        if len(out) > MAX_FILES:
            break
    return out


def _upload_files(client, ticket_id: str, message_id: str, files: List[IncomingFile]) -> List[dict]:
    rows = []
    for f in files:
        path = f"{ticket_id}/{uuid.uuid4().hex}-{f.filename}"
        try:
            client.storage.from_(BUCKET).upload(path, f.data, file_options={"content-type": f.content_type})
        except Exception:
            logger.exception("Couldn't store support attachment for ticket %s", ticket_id)
            continue
        rows.append(
            {
                "ticket_id": ticket_id,
                "message_id": message_id,
                "path": path,
                "filename": f.filename,
                "content_type": f.content_type,
                "size_bytes": len(f.data),
            }
        )
    if rows:
        rows = client.table(ATTACHMENTS).insert(rows).execute().data or rows
    return rows


def _signed_url(client, path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    try:
        signed = client.storage.from_(BUCKET).create_signed_url(path, SIGNED_URL_SECONDS)
        return (signed or {}).get("signedURL") or (signed or {}).get("signed_url")
    except Exception:
        logger.exception("Couldn't sign support attachment %s", path)
        return None


# --- reads ----------------------------------------------------------------------


def ticket_by_number(client, number: int) -> Optional[dict]:
    rows = client.table(TICKETS).select("*").eq("number", number).limit(1).execute().data
    return rows[0] if rows else None


def ticket_by_id(client, ticket_id: str) -> Optional[dict]:
    rows = client.table(TICKETS).select("*").eq("id", ticket_id).limit(1).execute().data
    return rows[0] if rows else None


def _messages(client, ticket_id: str) -> List[dict]:
    rows = client.table(MESSAGES).select("*").eq("ticket_id", ticket_id).order("created_at").execute().data
    return rows or []


def _attachments_by_message(client, ticket_id: str) -> dict:
    rows = client.table(ATTACHMENTS).select("*").eq("ticket_id", ticket_id).execute().data or []
    grouped: dict = {}
    for row in rows:
        grouped.setdefault(row["message_id"], []).append(row)
    return grouped


def thread_ids(client, ticket_id: str) -> List[str]:
    """Message-IDs on the ticket, oldest first, for In-Reply-To/References."""
    return [m["email_message_id"] for m in _messages(client, ticket_id) if m.get("email_message_id")]


def owns(ticket: dict, user: AuthedUser) -> bool:
    if ticket.get("user_id") and ticket["user_id"] == user.user_id:
        return True
    return bool(user.email) and ticket.get("requester_email") == user.email.lower()


# --- writes ---------------------------------------------------------------------


def _insert_message(client, ticket: dict, **fields) -> dict:
    row = {"ticket_id": ticket["id"], "internal": False, "created_at": _iso(), **fields}
    return client.table(MESSAGES).insert(row).execute().data[0]


def _update_ticket(client, ticket: dict, updates: dict) -> dict:
    updates = {**updates, "updated_at": _iso()}
    client.table(TICKETS).update(updates).eq("id", ticket["id"]).execute()
    return {**ticket, **updates}


def recent_ticket_count(client, email: str, since: datetime) -> int:
    rows = (
        client.table(TICKETS)
        .select("id")
        .eq("requester_email", email)
        .gte("created_at", since.isoformat())
        .execute()
        .data
    )
    return len(rows or [])


def create_ticket(
    client,
    *,
    requester_email: str,
    requester_name: Optional[str],
    user_id: Optional[str],
    identity_verified: bool,
    category: str,
    subject: str,
    body: str,
    source: str,
    channel: str,
    files: List[IncomingFile] = (),
    previous_ticket_id: Optional[str] = None,
    **message_fields,
) -> tuple[dict, dict]:
    now = _iso()
    ticket = (
        client.table(TICKETS)
        .insert(
            {
                "user_id": user_id,
                "requester_email": requester_email,
                "requester_name": requester_name or None,
                "identity_verified": identity_verified,
                "category": category,
                "subject": subject,
                "status": "open",
                "source": source,
                "previous_ticket_id": previous_ticket_id,
                "created_at": now,
                "updated_at": now,
                "last_user_message_at": now,
            }
        )
        .execute()
        .data[0]
    )
    message = _insert_message(
        client, ticket, author_type="user", author_id=user_id, body=body, channel=channel, **message_fields
    )
    _upload_files(client, ticket["id"], message["id"], list(files))
    return ticket, message


def add_requester_message(
    client, ticket: dict, *, body: str, channel: str, author_id: Optional[str], files: List[IncomingFile] = (), **message_fields
) -> tuple[dict, dict]:
    """The requester wrote again. Reopens the ticket unless the message came
    from a different sender (support_inbound flags those for the agent)."""
    message = _insert_message(
        client, ticket, author_type="user", author_id=author_id, body=body, channel=channel, **message_fields
    )
    _upload_files(client, ticket["id"], message["id"], list(files))
    updates = {"last_user_message_at": _iso()}
    if not message_fields.get("sender_mismatch") and ticket["status"] in ("pending", "resolved"):
        updates.update(status="open", resolved_at=None)
    ticket = _update_ticket(client, ticket, updates)
    return ticket, message


def send_acknowledgement(ticket: dict, body: str) -> None:
    """Background task after a new ticket. The email's Message-ID is kept on
    a system note, so a reply to it threads into the ticket."""
    client = get_client()
    if client is None or not support_mail.is_configured():
        return
    message_id = support_mail.new_message_id(ticket["number"])
    try:
        support_mail.send(
            to=ticket["requester_email"],
            content=support_received_email(
                number=ticket["number"], subject=ticket["subject"], body=body, view_url=view_url(ticket)
            ),
            message_id=message_id,
            references=thread_ids(client, ticket["id"]),
            auto_reply=True,
            ticket_number=ticket["number"],
        )
    except Exception:
        logger.exception("Couldn't send the acknowledgement for ticket #%s", ticket["number"])
        return
    try:
        _insert_message(
            client,
            ticket,
            author_type="system",
            body=f"Confirmation email sent to {ticket['requester_email']}.",
            internal=True,
            channel="email",
            email_message_id=message_id,
        )
    except Exception:
        logger.exception("Sent the acknowledgement for #%s but couldn't record it", ticket["number"])


def alert_recipients(client) -> List[str]:
    configured = [e.strip().lower() for e in os.getenv("SUPPORT_ALERT_EMAILS", "").split(",") if e.strip()]
    recipients = configured or [e.lower() for e in notifications.admin_recipients(client)]
    # Never the support mailbox itself: the poller would read the alert back
    # in as a new ticket.
    return [e for e in dict.fromkeys(recipients) if e != support_mail.support_address()]


def alert_agents(ticket: dict, message: dict, *, is_new: bool) -> None:
    """Background task: tell the team about a new ticket or reply."""
    client = get_client()
    if client is None:
        return
    requester = ticket["requester_email"]
    if ticket.get("requester_name"):
        requester = f"{ticket['requester_name']} <{requester}>"
    kind = "support_new" if is_new else "support_reply"
    for to in alert_recipients(client):
        notifications.deliver(
            kind,
            f"{message['id']}:{to}",
            to,
            lambda: support_agent_alert_email(
                number=ticket["number"],
                subject=ticket["subject"],
                body=message["body"],
                requester=requester,
                category=ticket["category"],
                is_new=is_new,
                admin_url=admin_url(),
            ),
            client=client,
        )


def add_agent_message(
    client,
    ticket: dict,
    *,
    agent_id: str,
    body: str,
    internal: bool,
    files: List[IncomingFile],
    set_status: Optional[str],
) -> tuple[dict, dict]:
    """A public reply is emailed before the ticket changes; if the email
    can't be sent the message is removed again and the agent sees an error."""
    message_id = None if internal else support_mail.new_message_id(ticket["number"])
    message = _insert_message(
        client,
        ticket,
        author_type="agent",
        author_id=agent_id,
        body=body,
        internal=internal,
        channel="admin",
        email_message_id=message_id,
    )
    attachments = _upload_files(client, ticket["id"], message["id"], files)

    if not internal:
        new_status = set_status or "pending"
        try:
            support_mail.send(
                to=ticket["requester_email"],
                content=support_agent_reply_email(
                    number=ticket["number"],
                    subject=ticket["subject"],
                    body=body,
                    view_url=view_url(ticket),
                    status=new_status,
                    attachment_count=len(files),
                ),
                message_id=message_id,
                references=[i for i in thread_ids(client, ticket["id"]) if i != message_id],
                auto_reply=False,
                attachments=[support_mail.OutgoingFile(f.filename, f.content_type, f.data) for f in files],
                ticket_number=ticket["number"],
            )
        except Exception:
            logger.exception("Couldn't email the reply on ticket #%s", ticket["number"])
            for a in attachments:
                try:
                    client.storage.from_(BUCKET).remove([a["path"]])
                except Exception:
                    logger.exception("Couldn't remove attachment %s", a["path"])
            client.table(MESSAGES).delete().eq("id", message["id"]).execute()
            raise HTTPException(status_code=502, detail="send_failed")

    updates: dict = {}
    if not internal:
        updates["last_agent_message_at"] = _iso()
        updates.update(_status_updates(ticket, set_status or "pending"))
    elif set_status:
        updates.update(_status_updates(ticket, set_status))
    if not ticket.get("assigned_to"):
        updates["assigned_to"] = agent_id
    ticket = _update_ticket(client, ticket, updates) if updates else ticket
    return ticket, message


def _status_updates(ticket: dict, status: str) -> dict:
    if status == ticket["status"]:
        return {}
    updates: dict = {"status": status}
    if status == "resolved":
        updates["resolved_at"] = _iso()
    elif status == "closed":
        updates["closed_at"] = _iso()
    else:
        updates.update(resolved_at=None, closed_at=None)
    return updates


def close_stale_resolved(client, now: Optional[datetime] = None) -> int:
    cutoff = ((now or _now()) - AUTO_CLOSE_AFTER).isoformat()
    rows = client.table(TICKETS).select("id").eq("status", "resolved").lte("resolved_at", cutoff).execute().data or []
    for row in rows:
        client.table(TICKETS).update(
            {"status": "closed", "closed_at": _iso(now), "updated_at": _iso(now)}
        ).eq("id", row["id"]).execute()
    return len(rows)


# --- shapes returned to the apps -------------------------------------------------


def _public_attachment(client, a: dict) -> dict:
    return {
        "id": a["id"],
        "filename": a["filename"],
        "content_type": a["content_type"],
        "size_bytes": a["size_bytes"],
        "url": _signed_url(client, a["path"]),
    }


def public_ticket(ticket: dict) -> dict:
    return {
        "number": ticket["number"],
        "subject": ticket["subject"],
        "category": ticket["category"],
        "status": ticket["status"],
        "created_at": ticket["created_at"],
        "updated_at": ticket["updated_at"],
        "last_agent_message_at": ticket.get("last_agent_message_at"),
    }


def public_conversation(client, ticket: dict) -> dict:
    attachments = _attachments_by_message(client, ticket["id"])
    messages = [
        {
            "id": m["id"],
            "from": "support" if m["author_type"] == "agent" else "you",
            "body": m["body"],
            "channel": m["channel"],
            "created_at": m["created_at"],
            "attachments": [_public_attachment(client, a) for a in attachments.get(m["id"], [])],
        }
        for m in _messages(client, ticket["id"])
        if not m.get("internal") and m["author_type"] != "system"
    ]
    return {**public_ticket(ticket), "messages": messages}


_PROFILE_FIELDS = (
    "id",
    "email",
    "display_name",
    "role",
    "plan_tier",
    "billing_cycle",
    "plan_expires_at",
    "standard_credits",
    "premium_credits",
    "student_verified",
    "created_at",
    "banned_permanent",
    "banned_until",
    "deletion_requested_at",
)


def _profiles_by_id(client, ids) -> dict:
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    rows = client.table("profiles").select("*").in_("id", ids).execute().data or []
    return {r["id"]: r for r in rows}


def _requester_account(client, ticket: dict) -> Optional[dict]:
    """The account behind the ticket: its owner, or for guest/email tickets
    the account using the same login address (not proof of identity)."""
    if ticket.get("user_id"):
        row = _profiles_by_id(client, [ticket["user_id"]]).get(ticket["user_id"])
    else:
        rows = client.table("profiles").select("*").eq("email", ticket["requester_email"]).limit(1).execute().data
        row = rows[0] if rows else None
    if not row:
        return None
    return {k: row.get(k) for k in _PROFILE_FIELDS}


def _person(profile: Optional[dict]) -> Optional[dict]:
    if not profile:
        return None
    return {"id": profile["id"], "email": profile.get("email"), "name": profile.get("display_name")}


def admin_ticket_row(ticket: dict, profiles: dict) -> dict:
    return {
        **{k: ticket.get(k) for k in (
            "id", "number", "subject", "category", "status", "priority", "source", "user_id",
            "requester_email", "requester_name", "identity_verified", "previous_ticket_id",
            "created_at", "updated_at", "last_user_message_at", "last_agent_message_at",
            "resolved_at", "closed_at",
        )},
        "assignee": _person(profiles.get(ticket.get("assigned_to"))),
    }


def admin_conversation(client, ticket: dict) -> dict:
    messages = _messages(client, ticket["id"])
    attachments = _attachments_by_message(client, ticket["id"])
    profiles = _profiles_by_id(client, [ticket.get("assigned_to")] + [m.get("author_id") for m in messages])
    previous = ticket_by_id(client, ticket["previous_ticket_id"]) if ticket.get("previous_ticket_id") else None
    return {
        **admin_ticket_row(ticket, profiles),
        "previous_ticket_number": previous["number"] if previous else None,
        "account": _requester_account(client, ticket),
        "messages": [
            {
                "id": m["id"],
                "author_type": m["author_type"],
                "author": _person(profiles.get(m.get("author_id"))),
                "body": m["body"],
                "internal": m.get("internal", False),
                "channel": m["channel"],
                "sender_email": m.get("sender_email"),
                "sender_auth": m.get("sender_auth"),
                "sender_mismatch": m.get("sender_mismatch", False),
                "raw_email_url": _signed_url(client, m.get("raw_email_path")),
                "created_at": m["created_at"],
                "attachments": [_public_attachment(client, a) for a in attachments.get(m["id"], [])],
            }
            for m in messages
        ],
    }


# --- auth helpers ----------------------------------------------------------------

_optional_bearer = HTTPBearer(auto_error=False)


async def optional_user(
    request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Depends(_optional_bearer)
) -> Optional[AuthedUser]:
    if credentials is None or not credentials.credentials:
        return None
    return await verify_supabase_jwt(request, credentials)


def require_admin(user: AuthedUser = Depends(verify_supabase_jwt)) -> AuthedUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admins only.")
    return user


def _validated(subject: Optional[str], body: str, category: Optional[str] = None) -> tuple[str, str, str]:
    clean_body = clean_text(body, limit=MAX_BODY + 1)
    if not clean_body:
        raise HTTPException(status_code=400, detail="invalid_body")
    if len(clean_body) > MAX_BODY:
        raise HTTPException(status_code=400, detail="body_too_long")
    clean_subj = clean_subject(subject) if subject is not None else ""
    if subject is not None and not clean_subj:
        raise HTTPException(status_code=400, detail="invalid_subject")
    if category is not None and category not in CATEGORIES:
        raise HTTPException(status_code=400, detail="invalid_category")
    return clean_subj, clean_body, category or "other"


# --- requester routes -------------------------------------------------------------


@router.post("/api/support/tickets")
@limiter.limit(RATE_LIMIT_SUPPORT_CREATE, key_func=ip_key)
async def open_ticket(
    request: Request,
    background: BackgroundTasks,
    category: str = Form(...),
    subject: str = Form(...),
    body: str = Form(...),
    email: Optional[str] = Form(None),
    name: Optional[str] = Form(None),
    # Hidden field real people never fill in.
    website: Optional[str] = Form(None),
    files: Optional[List[UploadFile]] = File(None),
    user: Optional[AuthedUser] = Depends(optional_user),
):
    if website:
        raise HTTPException(status_code=400, detail="invalid_request")
    subject, body, category = _validated(subject, body, category)
    if user is not None:
        requester = (user.email or "").lower()
        if not requester:
            raise HTTPException(status_code=400, detail="invalid_email")
    else:
        requester = normalize_email(email or "")
        if requester is None:
            raise HTTPException(status_code=400, detail="invalid_email")
    clean_name = clean_subject(name)[:MAX_NAME] or None
    incoming = validate_files(await read_uploads(files))

    def work():
        client = _client()
        if recent_ticket_count(client, requester, _now() - timedelta(hours=1)) >= TICKETS_PER_EMAIL_PER_HOUR:
            raise HTTPException(status_code=429, detail="too_many_requests")
        return create_ticket(
            client,
            requester_email=requester,
            requester_name=clean_name,
            user_id=user.user_id if user else None,
            identity_verified=user is not None,
            category=category,
            subject=subject,
            body=body,
            source="form",
            channel="web",
            files=incoming,
        )

    ticket, message = await run_in_threadpool(work)
    background.add_task(send_acknowledgement, ticket, body)
    background.add_task(alert_agents, ticket, message, is_new=True)
    return {"number": ticket["number"], "signed_in": user is not None}


@router.get("/api/support/tickets")
def my_tickets(user: AuthedUser = Depends(verify_supabase_jwt)):
    client = _client()
    rows = client.table(TICKETS).select("*").eq("user_id", user.user_id).execute().data or []
    if user.email:
        rows += client.table(TICKETS).select("*").eq("requester_email", user.email.lower()).execute().data or []
    unique = {r["id"]: r for r in rows}.values()
    items = sorted(unique, key=lambda r: r["updated_at"], reverse=True)
    return {"items": [public_ticket(t) for t in items]}


def _own_ticket(client, number: int, user: AuthedUser) -> dict:
    ticket = ticket_by_number(client, number)
    if ticket is None or not owns(ticket, user):
        raise HTTPException(status_code=404, detail="not_found")
    return ticket


@router.get("/api/support/tickets/{number}")
def my_ticket(number: int, user: AuthedUser = Depends(verify_supabase_jwt)):
    client = _client()
    return public_conversation(client, _own_ticket(client, number, user))


async def _reply_as_requester(
    background: BackgroundTasks, ticket_lookup, body: str, files, author_id: Optional[str]
) -> dict:
    _, body, _ = _validated(None, body)
    incoming = validate_files(await read_uploads(files))

    def work():
        client = _client()
        ticket = ticket_lookup(client)
        if ticket["status"] == "closed":
            raise HTTPException(status_code=409, detail="closed")
        ticket, message = add_requester_message(
            client, ticket, body=body, channel="web", author_id=author_id, files=incoming
        )
        return ticket, message, public_conversation(client, ticket)

    ticket, message, conversation = await run_in_threadpool(work)
    background.add_task(alert_agents, ticket, message, is_new=False)
    return conversation


@router.post("/api/support/tickets/{number}/messages")
@limiter.limit(RATE_LIMIT_SUPPORT_REPLY)
async def reply_to_my_ticket(
    request: Request,
    number: int,
    background: BackgroundTasks,
    body: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
    user: AuthedUser = Depends(verify_supabase_jwt),
):
    return await _reply_as_requester(
        background, lambda client: _own_ticket(client, number, user), body, files, user.user_id
    )


def _guest_ticket(client, token: str) -> dict:
    ticket_id = ticket_id_from_guest_token(token)
    ticket = ticket_by_id(client, ticket_id) if ticket_id else None
    if ticket is None:
        raise HTTPException(status_code=404, detail="not_found")
    return ticket


@router.get("/api/support/guest/{token}")
@limiter.limit(RATE_LIMIT_SUPPORT_GUEST, key_func=ip_key)
def guest_ticket(request: Request, token: str):
    client = _client()
    return public_conversation(client, _guest_ticket(client, token))


@router.post("/api/support/guest/{token}/messages")
@limiter.limit(RATE_LIMIT_SUPPORT_REPLY, key_func=ip_key)
async def reply_as_guest(
    request: Request,
    token: str,
    background: BackgroundTasks,
    body: str = Form(...),
    files: Optional[List[UploadFile]] = File(None),
):
    return await _reply_as_requester(background, lambda client: _guest_ticket(client, token), body, files, None)


# --- admin routes -----------------------------------------------------------------


def _count(client, **filters) -> int:
    query = client.table(TICKETS).select("id", count="exact")
    for column, value in filters.items():
        query = query.is_(column, "null") if value is None else query.eq(column, value)
    res = query.limit(1).execute()
    return res.count if res.count is not None else len(res.data or [])


@router.get("/api/admin/support/summary")
def admin_summary(admin: AuthedUser = Depends(require_admin)):
    client = _client()
    counts = {s: _count(client, status=s) for s in STATUSES}
    return {
        "counts": counts,
        "unassigned_open": _count(client, status="open", assigned_to=None),
        "mine_open": _count(client, status="open", assigned_to=admin.user_id),
    }


@router.get("/api/admin/support/agents")
def admin_agents(_: AuthedUser = Depends(require_admin)):
    rows = _client().table("profiles").select("*").eq("role", "admin").execute().data or []
    return {"items": sorted((_person(r) for r in rows), key=lambda p: (p["name"] or p["email"] or "").lower())}


_SEARCH_SAFE = re.compile(r"[^\w@.+\- ]", re.UNICODE)


@router.get("/api/admin/support/tickets")
def admin_tickets(
    status: Optional[str] = None,
    category: Optional[str] = None,
    assigned: Optional[str] = None,
    q: Optional[str] = None,
    page: int = 1,
    page_size: int = 30,
    admin: AuthedUser = Depends(require_admin),
):
    client = _client()
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    query = client.table(TICKETS).select("*", count="exact")
    if status in STATUSES:
        query = query.eq("status", status)
    if category in CATEGORIES:
        query = query.eq("category", category)
    if assigned == "me":
        query = query.eq("assigned_to", admin.user_id)
    elif assigned == "unassigned":
        query = query.is_("assigned_to", "null")
    elif assigned:
        try:
            query = query.eq("assigned_to", str(uuid.UUID(assigned)))
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid_assignee")
    term = (q or "").strip().lstrip("#")
    if term.isdigit():
        query = query.eq("number", int(term))
    elif term:
        safe = _SEARCH_SAFE.sub(" ", term).strip()[:80]
        if safe:
            query = query.or_(f"subject.ilike.*{safe}*,requester_email.ilike.*{safe}*,requester_name.ilike.*{safe}*")
    # Open tickets: whoever has waited longest first. Elsewhere: newest activity.
    if status == "open":
        query = query.order("last_user_message_at")
    else:
        query = query.order("updated_at", desc=True)
    start = (page - 1) * page_size
    res = query.range(start, start + page_size - 1).execute()
    rows = res.data or []
    profiles = _profiles_by_id(client, [r.get("assigned_to") for r in rows])
    return {
        "items": [admin_ticket_row(r, profiles) for r in rows],
        "total": res.count if res.count is not None else len(rows),
        "page": page,
        "page_size": page_size,
    }


def _admin_ticket(client, number: int) -> dict:
    ticket = ticket_by_number(client, number)
    if ticket is None:
        raise HTTPException(status_code=404, detail="not_found")
    return ticket


@router.get("/api/admin/support/tickets/{number}")
def admin_ticket(number: int, _: AuthedUser = Depends(require_admin)):
    client = _client()
    return admin_conversation(client, _admin_ticket(client, number))


@router.post("/api/admin/support/tickets/{number}/messages")
async def admin_reply(
    number: int,
    body: str = Form(...),
    internal: bool = Form(False),
    set_status: Optional[str] = Form(None),
    files: Optional[List[UploadFile]] = File(None),
    admin: AuthedUser = Depends(require_admin),
):
    _, body, _ = _validated(None, body)
    if set_status is not None and set_status not in STATUSES:
        raise HTTPException(status_code=400, detail="invalid_status")
    incoming = validate_files(await read_uploads(files))

    def work():
        client = _client()
        if not internal and not support_mail.is_configured():
            raise HTTPException(status_code=503, detail="Email sending is not configured on this server.")
        ticket = _admin_ticket(client, number)
        ticket, _ = add_agent_message(
            client,
            ticket,
            agent_id=admin.user_id,
            body=body,
            internal=internal,
            files=incoming,
            set_status=set_status,
        )
        return admin_conversation(client, ticket)

    return await run_in_threadpool(work)


class TicketPatch(BaseModel):
    status: Optional[Status] = None
    priority: Optional[Literal["normal", "high"]] = None
    category: Optional[Literal["billing", "account", "checks", "bug", "other"]] = None
    # "" unassigns.
    assigned_to: Optional[str] = Field(default=None, max_length=64)


@router.patch("/api/admin/support/tickets/{number}")
def admin_update_ticket(number: int, patch: TicketPatch, _: AuthedUser = Depends(require_admin)):
    client = _client()
    ticket = _admin_ticket(client, number)
    updates: dict = {}
    if patch.status is not None:
        updates.update(_status_updates(ticket, patch.status))
    if patch.priority is not None:
        updates["priority"] = patch.priority
    if patch.category is not None:
        updates["category"] = patch.category
    if patch.assigned_to is not None:
        if patch.assigned_to == "":
            updates["assigned_to"] = None
        else:
            try:
                agent_id = str(uuid.UUID(patch.assigned_to))
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid_assignee")
            agent = _profiles_by_id(client, [agent_id]).get(agent_id)
            if not agent or agent.get("role") != "admin":
                raise HTTPException(status_code=400, detail="invalid_assignee")
            updates["assigned_to"] = agent_id
    if updates:
        ticket = _update_ticket(client, ticket, updates)
    return admin_conversation(client, ticket)

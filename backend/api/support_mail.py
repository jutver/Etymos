"""
support_mail.py
---------------
Outgoing support email: the acknowledgement for a new ticket and agents'
replies. Unlike mailer.send_email, these are threaded conversations, so this
module builds the message itself:

- From "Etymos Support <support@etymos.site>", logged in to SMTP as the
  support mailbox (Zimbra may refuse a From that isn't the logged-in user).
  Without SUPPORT_SMTP_* it falls back to the noreply login with
  Reply-To: support@, which threads just as well.
- Message-ID <support.{number}.{uuid}@etymos.site>, stored on the message
  row. In-Reply-To / References list the ticket's earlier ids, so mail
  clients thread the conversation and the inbound poller can match the
  user's reply to the ticket.
- Attachments go in the email when they fit (MAX_EMAIL_ATTACHMENT_BYTES).
- After sending, a copy is appended to the mailbox's Sent folder over IMAP
  (best effort), so the whole thread is visible in OneMail webmail too.

Configuration (backend .env):
  SUPPORT_EMAIL           default support@etymos.site
  SUPPORT_SMTP_USER       usually the same as SUPPORT_EMAIL
  SUPPORT_SMTP_PASSWORD
  SUPPORT_IMAP_HOST       default SMTP_HOST
  SUPPORT_IMAP_USER       default SUPPORT_SMTP_USER
  SUPPORT_IMAP_PASSWORD   default SUPPORT_SMTP_PASSWORD
"""

from __future__ import annotations

import imaplib
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from typing import Optional

import mailer
from email_templates import EmailContent, render_email, render_text

logger = logging.getLogger(__name__)

MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024
OWN_MESSAGE_ID_RE = re.compile(r"<support\.(\d+)\.[0-9a-f]{32}@", re.IGNORECASE)


@dataclass
class OutgoingFile:
    filename: str
    content_type: str
    data: bytes


def support_address() -> str:
    return (os.getenv("SUPPORT_EMAIL") or "support@etymos.site").strip().lower()


def _smtp_login() -> tuple[str, str, bool]:
    """(user, password, is_support_mailbox)."""
    user = os.getenv("SUPPORT_SMTP_USER")
    password = os.getenv("SUPPORT_SMTP_PASSWORD")
    if user and password:
        return user, password, True
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    if user and password:
        return user, password, False
    raise mailer.MailerNotConfigured("Neither SUPPORT_SMTP_* nor SMTP_USER / SMTP_PASSWORD is set.")


def is_configured() -> bool:
    try:
        _smtp_login()
    except mailer.MailerNotConfigured:
        return False
    return bool(os.getenv("SMTP_HOST"))


def imap_settings() -> Optional[tuple[str, str, str]]:
    host = os.getenv("SUPPORT_IMAP_HOST") or os.getenv("SMTP_HOST")
    user = os.getenv("SUPPORT_IMAP_USER") or os.getenv("SUPPORT_SMTP_USER")
    password = os.getenv("SUPPORT_IMAP_PASSWORD") or os.getenv("SUPPORT_SMTP_PASSWORD")
    if host and user and password:
        return host, user, password
    return None


def new_message_id(number: int) -> str:
    domain = support_address().split("@")[-1]
    return f"<support.{number}.{uuid.uuid4().hex}@{domain}>"


def build_message(
    *,
    to: str,
    content: EmailContent,
    message_id: str,
    references: list[str],
    auto_reply: bool,
    sender_login: str,
    from_support_mailbox: bool,
    attachments: list[OutgoingFile] = (),
    ticket_number: Optional[int] = None,
) -> EmailMessage:
    support = support_address()
    msg = EmailMessage()
    msg["Subject"] = content.subject
    msg["From"] = formataddr(("Etymos Support", support if from_support_mailbox else sender_login))
    msg["To"] = to
    msg["Reply-To"] = support
    msg["Message-ID"] = message_id
    if references:
        refs = references[-20:]
        msg["In-Reply-To"] = refs[-1]
        msg["References"] = " ".join(refs)
    if auto_reply:
        # RFC 3834: tells other robots (vacation responders) not to answer.
        msg["Auto-Submitted"] = "auto-replied"
    if ticket_number is not None:
        msg["X-Etymos-Ticket"] = str(ticket_number)
    msg.set_content(render_text(content))
    msg.add_alternative(render_email(content), subtype="html")

    total = 0
    for f in attachments:
        total += len(f.data)
        if total > MAX_EMAIL_ATTACHMENT_BYTES:
            break
        maintype, _, subtype = f.content_type.partition("/")
        msg.add_attachment(f.data, maintype=maintype, subtype=subtype or "octet-stream", filename=f.filename)
    return msg


def send(
    *,
    to: str,
    content: EmailContent,
    message_id: str,
    references: list[str],
    auto_reply: bool,
    attachments: list[OutgoingFile] = (),
    ticket_number: Optional[int] = None,
) -> None:
    user, password, is_support = _smtp_login()
    msg = build_message(
        to=to,
        content=content,
        message_id=message_id,
        references=references,
        auto_reply=auto_reply,
        sender_login=user,
        from_support_mailbox=is_support,
        attachments=attachments,
        ticket_number=ticket_number,
    )
    mailer.send_message(msg, user=user, password=password)
    logger.info("Sent support email %s", message_id)
    _append_to_sent(msg)


def _append_to_sent(msg: EmailMessage) -> None:
    """Copy into the support mailbox's Sent folder so webmail shows both
    sides of the thread. Best effort: the email has already gone out."""
    settings = imap_settings()
    if settings is None or os.getenv("SUPPORT_APPEND_SENT", "on").lower() == "off":
        return
    host, user, password = settings
    try:
        with imaplib.IMAP4_SSL(host, 993, timeout=20) as imap:
            imap.login(user, password)
            imap.append("Sent", "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
    except Exception:
        logger.warning("Couldn't copy support email to the Sent folder", exc_info=True)

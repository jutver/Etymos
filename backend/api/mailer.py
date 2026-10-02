"""
mailer.py
---------
Sends the backend's own transactional email over SMTP (the iNET OneMail
mailbox, the same one Supabase Auth sends through). Supabase-owned emails
(confirm signup, reset via primary email, ...) do NOT go through here.

Configuration (backend .env):
  SMTP_HOST      e.g. mail.etymos.site
  SMTP_PORT      465 (implicit TLS, default) or 587 (STARTTLS)
  SMTP_USER      full mailbox address, e.g. noreply@etymos.site
  SMTP_PASSWORD
  SMTP_FROM      optional display form, default "Etymos <SMTP_USER>"
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import make_msgid

from email_templates import EmailContent, Lang, render_email, render_text

logger = logging.getLogger(__name__)


class MailerNotConfigured(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_USER") and os.getenv("SMTP_PASSWORD"))


def send_email(to: str, content: EmailContent, lang: Lang) -> None:
    host = os.getenv("SMTP_HOST")
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASSWORD")
    if not (host and user and password):
        raise MailerNotConfigured("SMTP_HOST / SMTP_USER / SMTP_PASSWORD are not set.")
    port = int(os.getenv("SMTP_PORT", "465"))
    sender = os.getenv("SMTP_FROM") or f"Etymos <{user}>"

    msg = EmailMessage()
    msg["Subject"] = content.subject
    msg["From"] = sender
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain=user.split("@")[-1])
    msg.set_content(render_text(content, lang))
    msg.add_alternative(render_email(content, lang), subtype="html")

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=20) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=20) as smtp:
            smtp.starttls(context=context)
            smtp.login(user, password)
            smtp.send_message(msg)
    logger.info("Sent '%s' email", content.subject)

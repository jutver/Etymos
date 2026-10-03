"""
email_templates.py
------------------
One HTML layout for every email Etymos sends, so Supabase's auth emails
(confirm signup, password reset, ...) and the backend's own emails
(recovery-email verification, reset via recovery email) look identical.

- The backend renders it at send time (`render_email`).
- `scripts/build_email_templates.py` renders it once with Supabase's Go
  template placeholders (`{{ .ConfirmationURL }}`, ...) and writes
  `supabase/templates/*.html` for pasting into the Supabase dashboard.

Email-client constraints drive the markup: table layout, inline styles, no
SVG (Gmail drops it), no web fonts, a hidden preheader for the inbox
preview line, and a "bulletproof" table button that survives Outlook.
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field
from typing import Optional

APP_URL = "https://www.etymos.site"
LOGO_URL = f"{APP_URL}/assets/logo/etymos-mark-email.png"
SUPPORT_EMAIL = "support@etymos.site"
LINK_TTL_MINUTES = 30

# Brand tokens (apps/web/src/styles/globals.css).
NAVY = "#142b4a"
BRAND = "#1d4ed8"
INK = "#3f4b5f"
MUTED = "#7a8699"
LINE = "#e3e8f2"
PAGE = "#f3f6fb"
TINT = "#eef3ff"

FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"


@dataclass
class EmailContent:
    """Copy for one email. Values are inserted as-is, so callers must pass
    already-escaped text (see `esc`)."""

    subject: str
    preheader: str
    heading: str
    paragraphs: list[str]
    button_label: Optional[str] = None
    button_url: Optional[str] = None
    code: Optional[str] = None
    code_label: Optional[str] = None
    notes: list[str] = field(default_factory=list)


esc = html.escape

FALLBACK_LABEL = "Button not working? Copy this link into your browser:"
FOOTER = "This is an automated email from Etymos — please don't reply. Need help? Contact"
TAGLINE = "Academic plagiarism checking"


def expiry_note() -> str:
    return f"This link expires in <strong>{LINK_TTL_MINUTES} minutes</strong>."


def _button(label: str, url: str) -> str:
    return f"""
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 8px">
  <tr>
    <td align="center" bgcolor="{BRAND}" style="border-radius:10px">
      <a href="{url}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:{FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:10px">{label}</a>
    </td>
  </tr>
</table>"""


def _code(label: Optional[str], code: str) -> str:
    caption = (
        f'<p style="margin:0 0 8px;font-family:{FONT};font-size:13px;color:{MUTED}">{label}</p>' if label else ""
    )
    return f"""
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 4px">
  <tr>
    <td style="padding:16px 20px;background:{TINT};border-radius:10px">
      {caption}
      <p style="margin:0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:26px;font-weight:700;letter-spacing:8px;color:{NAVY}">{code}</p>
    </td>
  </tr>
</table>"""


def render_email(content: EmailContent) -> str:
    body = "".join(
        f'<p style="margin:0 0 14px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK}">{p}</p>'
        for p in content.paragraphs
    )
    if content.button_label and content.button_url:
        body += _button(content.button_label, content.button_url)
    if content.code:
        body += _code(content.code_label, content.code)
    notes = "".join(
        f'<p style="margin:14px 0 0;font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED}">{n}</p>'
        for n in content.notes
    )
    fallback = ""
    if content.button_url:
        fallback = f"""
<tr>
  <td style="padding:20px 40px 0">
    <p style="margin:0 0 6px;font-family:{FONT};font-size:12px;line-height:1.5;color:{MUTED}">{FALLBACK_LABEL}</p>
    <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.5;word-break:break-all"><a href="{content.button_url}" style="color:{BRAND};text-decoration:underline">{content.button_url}</a></p>
  </td>
</tr>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>{content.subject}</title>
</head>
<body style="margin:0;padding:0;background:{PAGE};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">{content.preheader}&#8203;&#8204;&#8203;&#8204;&#8203;&#8204;&#8203;&#8204;</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="{PAGE}" style="background:{PAGE}">
  <tr>
    <td align="center" style="padding:40px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">
        <tr>
          <td style="padding:0 8px 20px">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="vertical-align:middle;padding-right:10px"><img src="{LOGO_URL}" width="40" height="34" alt="" style="display:block;border:0;outline:none"></td>
                <td style="vertical-align:middle;font-family:{FONT};font-size:21px;font-weight:700;letter-spacing:-0.3px;color:{NAVY}">Etymos</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td bgcolor="#ffffff" style="background:#ffffff;border:1px solid {LINE};border-radius:16px;border-top:4px solid {BRAND}">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding:36px 40px 0">
                  <h1 style="margin:0 0 16px;font-family:{FONT};font-size:23px;line-height:1.3;font-weight:700;letter-spacing:-0.3px;color:{NAVY}">{content.heading}</h1>
                  {body}
                  {notes}
                </td>
              </tr>
              {fallback}
              <tr><td style="padding:32px 40px 0"><div style="height:1px;background:{LINE};line-height:1px;font-size:0">&nbsp;</div></td></tr>
              <tr>
                <td style="padding:18px 40px 32px">
                  <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{FOOTER} <a href="mailto:{SUPPORT_EMAIL}" style="color:{BRAND};text-decoration:none">{SUPPORT_EMAIL}</a>.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0;font-family:{FONT};font-size:12px;color:{MUTED}">
            <a href="{APP_URL}" style="color:{MUTED};text-decoration:none">Etymos</a> &middot; {TAGLINE}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
"""


def render_text(content: EmailContent) -> str:
    """Plain-text alternative: spam filters penalise HTML-only mail, and some
    readers (and screen-reader setups) prefer text."""
    import re

    def strip(s: str) -> str:
        return html.unescape(re.sub(r"<[^>]+>", "", s))

    lines = [strip(content.heading), ""]
    lines += [strip(p) for p in content.paragraphs]
    if content.button_url:
        lines += ["", f"{strip(content.button_label or '')}: {content.button_url}"]
    if content.code:
        lines += ["", f"{strip(content.code_label or '')} {content.code}".strip()]
    if content.notes:
        lines += [""] + [strip(n) for n in content.notes]
    lines += ["", "—", f"Etymos · {APP_URL} · {SUPPORT_EMAIL}"]
    return "\n".join(lines)


# --- Backend-sent emails --------------------------------------------------


def code_expiry_note() -> str:
    return f"The code is valid for <strong>{LINK_TTL_MINUTES} minutes</strong> and works once. Never share it with anyone."


def recovery_confirm_code_email(*, account_email: str, code: str) -> EmailContent:
    a = f"<strong>{esc(account_email)}</strong>"
    return EmailContent(
        subject=f"{code} is your Etymos recovery email code",
        preheader="Enter this code on your Etymos profile page to confirm your recovery email.",
        heading="Confirm your recovery email",
        paragraphs=[
            f"The Etymos account {a} just chose this address as its recovery email. Enter the code below in the confirmation window on your profile page.",
        ],
        code=esc(code),
        code_label="Your confirmation code:",
        notes=[code_expiry_note(), "If you didn't request this, ignore this email — nothing will change."],
    )


def recovery_reset_code_email(*, account_emails: list[str], code: str) -> EmailContent:
    many = len(account_emails) > 1
    names = ", ".join(f"<strong>{esc(e)}</strong>" for e in account_emails)
    target = (
        f"an Etymos account through this recovery email, which is linked to {len(account_emails)} accounts: {names}"
        if many
        else f"the account {names}"
    )
    return EmailContent(
        subject=f"{code} is your Etymos account recovery code",
        preheader="Enter this code to choose a new password for your Etymos account.",
        heading="Recover your account",
        paragraphs=[
            f"We received a request to recover {target}. Enter the code below on the recovery page"
            + (", choose the account," if many else "")
            + " and set a new password.",
        ],
        code=esc(code),
        code_label="Your recovery code:",
        notes=[code_expiry_note(), "If you didn't ask for this, ignore this email — your account is still safe."],
    )

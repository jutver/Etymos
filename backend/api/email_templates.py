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
from typing import Literal, Optional

Lang = Literal["vi", "en"]

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
    """Copy for one email in one language. Values are inserted as-is, so
    callers must pass already-escaped text (see `esc`)."""

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

_CHROME = {
    "vi": {
        "fallback": "Nút không hoạt động? Sao chép liên kết này vào trình duyệt:",
        "footer": "Email này được gửi tự động từ Etymos — vui lòng không trả lời. Cần hỗ trợ? Liên hệ",
        "tagline": "Kiểm tra đạo văn học thuật",
    },
    "en": {
        "fallback": "Button not working? Copy this link into your browser:",
        "footer": "This is an automated email from Etymos — please don't reply. Need help? Contact",
        "tagline": "Academic plagiarism checking",
    },
}


def expiry_note(lang: Lang) -> str:
    if lang == "vi":
        return f"Liên kết này sẽ hết hạn sau <strong>{LINK_TTL_MINUTES} phút</strong>."
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


def render_email(content: EmailContent, lang: Lang) -> str:
    chrome = _CHROME[lang]
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
    <p style="margin:0 0 6px;font-family:{FONT};font-size:12px;line-height:1.5;color:{MUTED}">{chrome["fallback"]}</p>
    <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.5;word-break:break-all"><a href="{content.button_url}" style="color:{BRAND};text-decoration:underline">{content.button_url}</a></p>
  </td>
</tr>"""

    return f"""<!DOCTYPE html>
<html lang="{lang}">
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
                  <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{chrome["footer"]} <a href="mailto:{SUPPORT_EMAIL}" style="color:{BRAND};text-decoration:none">{SUPPORT_EMAIL}</a>.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 8px 0;font-family:{FONT};font-size:12px;color:{MUTED}">
            <a href="{APP_URL}" style="color:{MUTED};text-decoration:none">Etymos</a> &middot; {chrome["tagline"]}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
"""


def render_text(content: EmailContent, lang: Lang) -> str:
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


def recovery_verify_email(lang: Lang, *, account_email: str, url: str) -> EmailContent:
    a = f"<strong>{esc(account_email)}</strong>"
    if lang == "vi":
        return EmailContent(
            subject="Xác nhận email khôi phục của bạn",
            preheader="Xác nhận địa chỉ này để dùng làm email khôi phục cho tài khoản Etymos.",
            heading="Xác nhận email khôi phục",
            paragraphs=[
                f"Tài khoản Etymos {a} vừa chọn địa chỉ này làm email khôi phục.",
                "Sau khi xác nhận, bạn có thể dùng email này để đặt lại mật khẩu nếu không truy cập được email chính.",
            ],
            button_label="Xác nhận email khôi phục",
            button_url=url,
            notes=[expiry_note(lang), "Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email — sẽ không có gì thay đổi."],
        )
    return EmailContent(
        subject="Confirm your recovery email",
        preheader="Confirm this address as the recovery email for your Etymos account.",
        heading="Confirm your recovery email",
        paragraphs=[
            f"The Etymos account {a} just chose this address as its recovery email.",
            "Once confirmed, you can use it to reset your password if you lose access to your main email.",
        ],
        button_label="Confirm recovery email",
        button_url=url,
        notes=[expiry_note(lang), "If you didn't request this, ignore this email — nothing will change."],
    )


def recovery_reset_email(lang: Lang, *, account_email: str, url: str) -> EmailContent:
    a = f"<strong>{esc(account_email)}</strong>"
    if lang == "vi":
        return EmailContent(
            subject="Đặt lại mật khẩu Etymos",
            preheader="Dùng liên kết này để đặt mật khẩu mới cho tài khoản Etymos.",
            heading="Đặt lại mật khẩu",
            paragraphs=[
                f"Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản {a}. Email này được gửi tới địa chỉ khôi phục bạn đã xác nhận.",
            ],
            button_label="Đặt mật khẩu mới",
            button_url=url,
            notes=[expiry_note(lang), "Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn sẽ không thay đổi."],
        )
    return EmailContent(
        subject="Reset your Etymos password",
        preheader="Use this link to choose a new password for your Etymos account.",
        heading="Reset your password",
        paragraphs=[
            f"We received a request to reset the password for {a}. We sent it to the recovery address you confirmed.",
        ],
        button_label="Choose a new password",
        button_url=url,
        notes=[expiry_note(lang), "If you didn't ask for this, ignore this email — your password won't change."],
    )

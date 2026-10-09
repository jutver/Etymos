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
    """Copy for one email. `subject` and `preheader` are plain text (escaped
    when rendered); every other field is HTML, so callers must escape user
    data in it (see `esc`)."""

    subject: str
    preheader: str
    heading: str
    paragraphs: list[str]
    button_label: Optional[str] = None
    button_url: Optional[str] = None
    code: Optional[str] = None
    code_label: Optional[str] = None
    notes: list[str] = field(default_factory=list)
    # Label/value rows (receipts, alerts), shown under the paragraphs.
    details: list[tuple[str, str]] = field(default_factory=list)
    # A quoted message (support emails), shown in a tinted box after the
    # paragraphs. HTML, like paragraphs.
    quote: Optional[str] = None
    quote_label: Optional[str] = None
    # Plain-text line above the logo. Support emails put the reply marker
    # here so the inbound poller can cut the quoted history.
    top_line: Optional[str] = None
    # Replaces the "automated email, please don't reply" footer (HTML).
    footer: Optional[str] = None


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


def _quote(label: Optional[str], quote: str) -> str:
    caption = (
        f'<p style="margin:0 0 8px;font-family:{FONT};font-size:12px;font-weight:600;letter-spacing:0.4px;text-transform:uppercase;color:{MUTED}">{label}</p>'
        if label
        else ""
    )
    return f"""
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 6px">
  <tr>
    <td style="padding:16px 20px;background:{TINT};border-radius:10px;border-left:3px solid {BRAND}">
      {caption}
      <div style="font-family:{FONT};font-size:14px;line-height:1.6;color:{INK}">{quote}</div>
    </td>
  </tr>
</table>"""


def _details(rows: list[tuple[str, str]]) -> str:
    cells = "".join(
        f"""<tr>
  <td style="padding:9px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;color:{MUTED}">{label}</td>
  <td align="right" style="padding:9px 0;border-bottom:1px solid {LINE};font-family:{FONT};font-size:14px;font-weight:600;color:{NAVY}">{value}</td>
</tr>"""
        for label, value in rows
    )
    return f"""
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 6px">
  {cells}
</table>"""


def render_email(content: EmailContent) -> str:
    body = "".join(
        f'<p style="margin:0 0 14px;font-family:{FONT};font-size:15px;line-height:1.65;color:{INK}">{p}</p>'
        for p in content.paragraphs
    )
    if content.details:
        body += _details(content.details)
    if content.quote:
        body += _quote(content.quote_label, content.quote)
    if content.button_label and content.button_url:
        body += _button(content.button_label, content.button_url)
    if content.code:
        body += _code(content.code_label, content.code)
    notes = "".join(
        f'<p style="margin:14px 0 0;font-family:{FONT};font-size:13px;line-height:1.6;color:{MUTED}">{n}</p>'
        for n in content.notes
    )
    top_line = ""
    if content.top_line:
        top_line = f'<p style="margin:0;padding:12px 16px 0;text-align:center;font-family:{FONT};font-size:12px;color:{MUTED}">{esc(content.top_line)}</p>'
    footer = content.footer or (
        f'{FOOTER} <a href="mailto:{SUPPORT_EMAIL}" style="color:{BRAND};text-decoration:none">{SUPPORT_EMAIL}</a>.'
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
<title>{esc(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:{PAGE};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">{esc(content.preheader)}&#8203;&#8204;&#8203;&#8204;&#8203;&#8204;&#8203;&#8204;</div>{top_line}
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
                  <p style="margin:0;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED}">{footer}</p>
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
        return html.unescape(re.sub(r"<[^>]+>", "", re.sub(r"<br\s*/?>", "\n", s)))

    lines = [content.top_line, ""] if content.top_line else []
    lines += [strip(content.heading), ""]
    lines += [strip(p) for p in content.paragraphs]
    if content.details:
        lines += [""] + [f"{strip(k)}: {strip(v)}" for k, v in content.details]
    if content.quote:
        quoted = strip(content.quote)
        lines += [""] + ([strip(content.quote_label)] if content.quote_label else []) + quoted.splitlines()
    if content.button_url:
        lines += ["", f"{strip(content.button_label or '')}: {content.button_url}"]
    if content.code:
        lines += ["", f"{strip(content.code_label or '')} {content.code}".strip()]
    if content.notes:
        lines += [""] + [strip(n) for n in content.notes]
    if content.footer:
        lines += ["", strip(content.footer)]
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


# --- Account and billing notifications (backend/api/notifications.py) -----
#
# Every value passed in is plain text; these functions escape it.


def _when(dt: str) -> str:
    return esc(dt)


def password_changed_email(*, account_email: str, changed_at: str) -> EmailContent:
    return EmailContent(
        subject="Your Etymos password was changed",
        preheader="If this wasn't you, reset your password now.",
        heading="Your password was changed",
        paragraphs=[
            f"The password for <strong>{esc(account_email)}</strong> was changed on {_when(changed_at)}.",
            "If you did this, there's nothing else to do. If you didn't, reset your password right away and check that your recovery email is still yours.",
        ],
        button_label="Reset password",
        button_url=f"{APP_URL}/forgot-password",
        notes=["For your security, every device that was signed in has been signed out."],
    )


def recovery_email_added_email(*, account_email: str, recovery_email: str) -> EmailContent:
    return EmailContent(
        subject="A recovery email was added to your Etymos account",
        preheader=f"{recovery_email} can now be used to recover your account.",
        heading="Recovery email added",
        paragraphs=[
            f"<strong>{esc(recovery_email)}</strong> is now the recovery email for <strong>{esc(account_email)}</strong>. "
            "If you ever lose access to your login email, a code sent there lets you set a new password.",
            "If you didn't add it, someone may have access to your account: change your password and remove this address from your profile.",
        ],
        button_label="Review your profile",
        button_url=f"{APP_URL}/account/profile",
    )


def recovery_email_removed_email(*, account_email: str, old_email: str, new_email: Optional[str]) -> EmailContent:
    change = (
        f"was replaced with <strong>{esc(new_email)}</strong> (waiting for confirmation)"
        if new_email
        else "was removed"
    )
    return EmailContent(
        subject="Your Etymos recovery email was changed",
        preheader="If this wasn't you, secure your account now.",
        heading="Recovery email changed",
        paragraphs=[
            f"The recovery email <strong>{esc(old_email)}</strong> for <strong>{esc(account_email)}</strong> {change}. "
            "It can no longer be used to recover the account.",
            "If you didn't do this, change your password right away and set your recovery email again.",
        ],
        button_label="Review your profile",
        button_url=f"{APP_URL}/account/profile",
    )


def payment_receipt_email(
    *, item: str, amount: str, order_code: str, paid_at: str, result: str
) -> EmailContent:
    return EmailContent(
        subject=f"Payment received: {item}",
        preheader=f"We received {amount} for {item}.",
        heading="Payment received",
        paragraphs=[f"Thank you! {esc(result)}"],
        details=[
            ("Item", esc(item)),
            ("Amount paid", esc(amount)),
            ("Order code", esc(order_code)),
            ("Paid on", _when(paid_at)),
        ],
        button_label="View payment history",
        button_url=f"{APP_URL}/account/payments",
        notes=["Keep this email as your receipt."],
    )


def plan_expiring_email(*, plan_name: str, ends_at: str, days_left: int, cycle: str) -> EmailContent:
    when = "tomorrow" if days_left <= 1 else f"in {days_left} days"
    term = "year" if cycle == "annual" else "month"
    return EmailContent(
        subject=f"Your Etymos {plan_name} plan ends {when}",
        preheader=f"Renew before {ends_at} to keep your plan.",
        heading=f"Your {esc(plan_name)} plan ends {when}",
        paragraphs=[
            f"Your {esc(plan_name)} plan is active until <strong>{_when(ends_at)}</strong>. After that your account moves to the Free plan.",
            f"Renew any time before then: another {term} is added to the end of your current term, so you don't lose any days.",
        ],
        button_label="Renew plan",
        button_url=f"{APP_URL}/account/plan",
        notes=["Plans are paid by bank transfer, so nothing is charged automatically."],
    )


def plan_ended_email(*, ended_at: str) -> EmailContent:
    return EmailContent(
        subject="Your Etymos plan has ended",
        preheader="Your account is now on the Free plan.",
        heading="Your plan has ended",
        paragraphs=[
            f"Your paid plan ended on {_when(ended_at)}, and your account is now on the Free plan. "
            "Your documents and reports are still there, and any credits you bought are unaffected.",
            "Pick a plan again whenever you need more checks.",
        ],
        button_label="Choose a plan",
        button_url=f"{APP_URL}/pricing",
    )


def verification_result_email(*, approved: bool) -> EmailContent:
    if approved:
        return EmailContent(
            subject="You're verified as a student on Etymos",
            preheader="You can now choose the Standard plan.",
            heading="Student status verified",
            paragraphs=[
                "Good news: we've verified your student status. You can now choose the Standard plan for students.",
            ],
            button_label="See plans",
            button_url=f"{APP_URL}/pricing",
        )
    return EmailContent(
        subject="We couldn't verify your student status",
        preheader="Please send a clearer document and try again.",
        heading="Student verification wasn't approved",
        paragraphs=[
            "We couldn't verify your student status from the document you sent. This usually happens when the "
            "document is unclear, expired, or doesn't show your name and school.",
            "You can send a new document at any time.",
        ],
        button_label="Try again",
        button_url=f"{APP_URL}/verify-student",
        notes=[f"Questions? Write to {SUPPORT_EMAIL}."],
    )


def account_deleted_email(*, account_email: str) -> EmailContent:
    return EmailContent(
        subject="Your Etymos account has been deleted",
        preheader="Your account and its documents are gone.",
        heading="Your account has been deleted",
        paragraphs=[
            f"The Etymos account <strong>{esc(account_email)}</strong> has been deleted, together with its documents and reports. This can't be undone.",
            "Payment records are kept for accounting. You're welcome to sign up again any time.",
        ],
        notes=[f"If you didn't ask for this, contact {SUPPORT_EMAIL} right away."],
    )


def admin_transfer_alert_email(
    *, amount: str, status_label: str, note: str, content: str, reference: str, received_at: str, admin_url: Optional[str]
) -> EmailContent:
    return EmailContent(
        subject=f"[Etymos admin] Transfer needs attention: {amount} ({status_label})",
        preheader=note or status_label,
        heading="A transfer needs attention",
        paragraphs=[
            f"SePay reported a transfer that couldn't be settled automatically: <strong>{esc(status_label)}</strong>. {esc(note)}",
            "Link it to the order it paid for, or mark it resolved once the money is refunded or explained.",
        ],
        details=[
            ("Amount", esc(amount)),
            ("Transfer content", esc(content) or "—"),
            ("Bank reference", esc(reference) or "—"),
            ("Received", _when(received_at)),
        ],
        button_label="Open Revenue → Transactions" if admin_url else None,
        button_url=f"{admin_url.rstrip('/')}/revenue/transactions" if admin_url else None,
    )


# --- Support (backend/api/support.py) --------------------------------------

# Above the logo of every email sent from support@. The inbound poller cuts a
# reply at this line, so whatever the user typed above it is kept and the
# quoted history below it is dropped.
SUPPORT_REPLY_MARKER = "##- Please type your reply above this line / Vui lòng trả lời phía trên dòng này -##"

SUPPORT_CATEGORIES = {
    "billing": "Billing and payments",
    "account": "Account and login",
    "checks": "Checks and reports",
    "bug": "Something isn't working",
    "other": "Other",
}


def support_subject(number: int, subject: str) -> str:
    return f"[#{number}] {subject}"


def text_to_html(text: str) -> str:
    """User or agent text for an email body: escaped, line breaks kept."""
    return esc(text.strip()).replace("\r\n", "\n").replace("\n", "<br>")


def _support_footer(view_url: Optional[str]) -> str:
    view = (
        f' or <a href="{esc(view_url)}" style="color:{BRAND};text-decoration:none">view the conversation</a>'
        if view_url
        else ""
    )
    return f"Reply to this email to add to your request{view}. Please keep the ticket number in the subject."


def support_received_email(*, number: int, subject: str, body: str, view_url: Optional[str]) -> EmailContent:
    return EmailContent(
        subject=support_subject(number, subject),
        preheader=f"We got your request #{number}. Our team will reply by email.",
        top_line=SUPPORT_REPLY_MARKER,
        heading="We got your request",
        paragraphs=[
            f"Thanks for contacting Etymos. Your request is <strong>#{number}</strong>, and our team will reply to this email address, usually within one business day.",
            "If you have anything to add, such as screenshots or more detail, just reply to this email.",
        ],
        quote=text_to_html(body),
        quote_label="Your message",
        button_label="View your request" if view_url else None,
        button_url=view_url,
        footer=_support_footer(view_url),
    )


def support_agent_reply_email(
    *, number: int, subject: str, body: str, view_url: Optional[str], status: str, attachment_count: int = 0
) -> EmailContent:
    notes = []
    if attachment_count:
        notes.append(f"{attachment_count} attachment{'s' if attachment_count != 1 else ''} included.")
    if status == "resolved":
        notes.append("We've marked this request as resolved. If you still need help, just reply and it will reopen.")
    return EmailContent(
        subject=support_subject(number, subject),
        preheader=body.strip().splitlines()[0][:140] if body.strip() else f"New reply on request #{number}",
        top_line=SUPPORT_REPLY_MARKER,
        heading=f"Reply to your request #{number}",
        paragraphs=[text_to_html(body)],
        notes=notes,
        button_label="View conversation" if view_url else None,
        button_url=view_url,
        footer=_support_footer(view_url),
    )


def support_agent_alert_email(
    *, number: int, subject: str, body: str, requester: str, category: str, is_new: bool, admin_url: Optional[str]
) -> EmailContent:
    what = "New support request" if is_new else "New reply on a support request"
    return EmailContent(
        subject=f"[Etymos support] {what} #{number}: {subject}",
        preheader=body.strip()[:140],
        heading=f"{what} #{number}",
        paragraphs=[f"<strong>{esc(subject)}</strong>"],
        details=[
            ("From", esc(requester)),
            ("Category", esc(SUPPORT_CATEGORIES.get(category, category))),
        ],
        quote=text_to_html(body[:4000]),
        button_label="Open in admin" if admin_url else None,
        button_url=f"{admin_url.rstrip('/')}/support/{number}" if admin_url else None,
    )

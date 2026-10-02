"""
Builds the Supabase Auth email templates from backend/api/email_templates.py,
so Supabase's emails and the backend's own emails share one design.

    python backend/scripts/build_email_templates.py            # writes supabase/templates/
    python backend/scripts/build_email_templates.py --preview  # also writes filled-in previews

Each template holds a Vietnamese and an English version and picks one with
Go template logic on `.Data.locale` (user_metadata.locale, kept in sync with
the app's language by the web app's AuthProvider). Vietnamese is the
fallback, matching the product default. `printf "%v"` keeps the comparison
safe for users with no `locale` at all.

Paste each file into Supabase dashboard → Authentication → Emails →
Templates, with the matching subject from supabase/templates/subjects.txt.

Only the flows the app supports have templates: signup confirmation and
password reset. Email change, invites, magic links and reauthentication
aren't offered anywhere in the app, so they keep Supabase's defaults.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "api"))

from email_templates import LINK_TTL_MINUTES, EmailContent, expiry_note, render_email  # noqa: E402

OUT = ROOT / "supabase" / "templates"

EMAIL = "<strong>{{ .Email }}</strong>"
URL = "{{ .ConfirmationURL }}"
CODE = "{{ .Token }}"


def code_expiry(lang: str) -> str:
    if lang == "vi":
        return f"Liên kết và mã này sẽ hết hạn sau <strong>{LINK_TTL_MINUTES} phút</strong>."
    return f"This link and code expire in <strong>{LINK_TTL_MINUTES} minutes</strong>."


def templates(lang: str) -> dict[str, EmailContent]:
    vi = lang == "vi"
    return {
        "confirm_signup": EmailContent(
            subject="Xác nhận email Etymos · Confirm your Etymos email",
            preheader="Xác nhận email để kích hoạt tài khoản Etymos." if vi else "Confirm your email to activate your Etymos account.",
            heading="Xác nhận địa chỉ email" if vi else "Confirm your email address",
            paragraphs=[
                f"Chào mừng bạn đến với Etymos! Nhấn nút bên dưới để xác nhận {EMAIL} và kích hoạt tài khoản."
                if vi
                else f"Welcome to Etymos! Click the button below to confirm {EMAIL} and activate your account."
            ],
            button_label="Xác nhận email" if vi else "Confirm email",
            button_url=URL,
            code=CODE,
            code_label="Hoặc nhập mã này trên trang xác minh:" if vi else "Or enter this code on the verification page:",
            notes=[
                code_expiry(lang),
                "Nếu bạn không đăng ký Etymos, hãy bỏ qua email này." if vi else "If you didn't sign up for Etymos, you can ignore this email.",
            ],
        ),
        "recovery": EmailContent(
            subject="Đặt lại mật khẩu Etymos · Reset your Etymos password",
            preheader="Dùng liên kết này để đặt mật khẩu mới." if vi else "Use this link to choose a new password.",
            heading="Đặt lại mật khẩu" if vi else "Reset your password",
            paragraphs=[
                f"Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản {EMAIL}. Nhấn nút bên dưới để chọn mật khẩu mới."
                if vi
                else f"We received a request to reset the password for {EMAIL}. Click the button below to choose a new one."
            ],
            button_label="Đặt mật khẩu mới" if vi else "Choose a new password",
            button_url=URL,
            notes=[
                expiry_note(lang),
                "Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn sẽ không thay đổi."
                if vi
                else "If you didn't ask for this, ignore this email — your password won't change.",
            ],
        ),
    }


def build() -> dict[str, str]:
    vi, en = templates("vi"), templates("en")
    out = {}
    for name in vi:
        out[name] = (
            '{{ if eq (printf "%v" .Data.locale) "en" }}'
            + render_email(en[name], "en")
            + "{{ else }}"
            + render_email(vi[name], "vi")
            + "{{ end }}\n"
        )
    return out


SAMPLE = {
    "{{ .Email }}": "minh.nguyen@example.com",
    "{{ .ConfirmationURL }}": "https://fwswvwyeqctxbqxnukrc.supabase.co/auth/v1/verify?token=pkce_3f9a2c&type=recovery&redirect_to=https://www.etymos.site/reset-password",
    "{{ .Token }}": "482913",
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    built = build()
    subjects = ["Paste each line's subject into the Subject field of that Supabase email template.", ""]
    for name, html in built.items():
        (OUT / f"{name}.html").write_text(html, encoding="utf-8")
        subjects.append(f"{name}: {templates('vi')[name].subject}")
    (OUT / "subjects.txt").write_text("\n".join(subjects) + "\n", encoding="utf-8")
    print(f"Wrote {len(built)} templates to {OUT.relative_to(ROOT)}")

    if "--preview" in sys.argv:
        preview_dir = Path(sys.argv[sys.argv.index("--preview") + 1]) if len(sys.argv) > sys.argv.index("--preview") + 1 else OUT / "preview"
        preview_dir.mkdir(parents=True, exist_ok=True)
        for lang in ("vi", "en"):
            for name, content in templates(lang).items():
                html = render_email(content, lang)
                for k, v in SAMPLE.items():
                    html = html.replace(k, v)
                (preview_dir / f"{name}.{lang}.html").write_text(html, encoding="utf-8")
        print(f"Wrote previews to {preview_dir}")


if __name__ == "__main__":
    main()

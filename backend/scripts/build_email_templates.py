"""
Builds the Supabase Auth email templates from backend/api/email_templates.py,
so Supabase's emails and the backend's own emails share one design.

    python backend/scripts/build_email_templates.py            # writes supabase/templates/
    python backend/scripts/build_email_templates.py --preview  # also writes filled-in previews

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

from email_templates import EmailContent, expiry_note, render_email  # noqa: E402

OUT = ROOT / "supabase" / "templates"

EMAIL = "<strong>{{ .Email }}</strong>"
URL = "{{ .ConfirmationURL }}"


def templates() -> dict[str, EmailContent]:
    return {
        "confirm_signup": EmailContent(
            subject="Confirm your Etymos email",
            preheader="Confirm your email to activate your Etymos account.",
            heading="Confirm your email address",
            paragraphs=[f"Welcome to Etymos! Click the button below to confirm {EMAIL} and activate your account."],
            button_label="Confirm email",
            button_url=URL,
            notes=[
                expiry_note(),
                "If you didn't sign up for Etymos, you can ignore this email.",
            ],
        ),
        "recovery": EmailContent(
            subject="Reset your Etymos password",
            preheader="Use this link to choose a new password.",
            heading="Reset your password",
            paragraphs=[
                f"We received a request to reset the password for {EMAIL}. Click the button below to choose a new one."
            ],
            button_label="Choose a new password",
            button_url=URL,
            notes=[expiry_note(), "If you didn't ask for this, ignore this email — your password won't change."],
        ),
    }


SAMPLE = {
    "{{ .Email }}": "minh.nguyen@example.com",
    "{{ .ConfirmationURL }}": "https://fwswvwyeqctxbqxnukrc.supabase.co/auth/v1/verify?token=pkce_3f9a2c&type=recovery&redirect_to=https://www.etymos.site/reset-password",
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    built = templates()
    subjects = ["Paste each line's subject into the Subject field of that Supabase email template.", ""]
    for name, content in built.items():
        (OUT / f"{name}.html").write_text(render_email(content), encoding="utf-8")
        subjects.append(f"{name}: {content.subject}")
    (OUT / "subjects.txt").write_text("\n".join(subjects) + "\n", encoding="utf-8")
    print(f"Wrote {len(built)} templates to {OUT.relative_to(ROOT)}")

    if "--preview" in sys.argv:
        i = sys.argv.index("--preview")
        preview_dir = Path(sys.argv[i + 1]) if len(sys.argv) > i + 1 else OUT / "preview"
        preview_dir.mkdir(parents=True, exist_ok=True)
        for name, content in built.items():
            html = render_email(content)
            for k, v in SAMPLE.items():
                html = html.replace(k, v)
            (preview_dir / f"{name}.html").write_text(html, encoding="utf-8")
        print(f"Wrote previews to {preview_dir}")


if __name__ == "__main__":
    main()

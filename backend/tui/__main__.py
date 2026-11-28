"""CLI entrypoint for `python -m tui` / `bash backend/scripts/tui.sh`."""
from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

from .app import EtymosTuiApp
from .auth import AuthError, RemoteAuthManager
from .models import LOG_SOURCE_ORDER, LogSourceId
from .providers.local import LocalDashboardProvider
from .providers.remote import RemoteDashboardProvider

DEFAULT_REMOTE_URL = "https://api.etymos.site"
DEFAULT_LOCAL_URL = "http://127.0.0.1:8000"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="etymos-tui",
        description="Dynamic reactive terminal dashboard for Etymos live stats & logs.",
    )
    parser.add_argument(
        "--mode",
        choices=("local", "remote"),
        default=None,
        help="Operating mode (default: local on server, or remote if --remote/--url is provided).",
    )
    parser.add_argument(
        "--remote",
        nargs="?",
        const=DEFAULT_REMOTE_URL,
        default=None,
        metavar="URL",
        help=f"Run in Remote Streaming Mode against URL (default when flag bare: {DEFAULT_REMOTE_URL}).",
    )
    parser.add_argument(
        "--url",
        default=None,
        metavar="URL",
        help="Alias for --remote URL.",
    )
    parser.add_argument(
        "--api-url",
        default=os.getenv("ETYMOS_LOCAL_API_URL", DEFAULT_LOCAL_URL),
        help=f"Loopback API URL in local mode (default: {DEFAULT_LOCAL_URL}).",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Admin aal2 JWT bearer token (or set ETYMOS_ADMIN_TOKEN).",
    )
    parser.add_argument(
        "--supabase-url",
        default=None,
        help="Supabase URL for --login password+MFA authentication.",
    )
    parser.add_argument(
        "--supabase-anon-key",
        default=None,
        help="Supabase anon/publishable key for --login password+MFA authentication.",
    )
    parser.add_argument(
        "--login",
        action="store_true",
        help="Prompt for admin email, password, and authenticator TOTP code for remote mode.",
    )
    parser.add_argument(
        "--logout",
        action="store_true",
        help="Clear cached remote TUI session file and exit.",
    )
    parser.add_argument(
        "--refresh",
        type=float,
        default=1.5,
        help="Live telemetry push/poll interval in seconds (1.0..30.0, default: 1.5).",
    )
    parser.add_argument(
        "--log-source",
        choices=LOG_SOURCE_ORDER,
        default="live",
        help="Initial log pane source (default: live).",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Use monochrome high-contrast styling (also respects NO_COLOR=1).",
    )
    return parser


def resolve_mode_and_url(args: argparse.Namespace) -> tuple[str, str]:
    remote_url = args.remote or args.url or os.getenv("ETYMOS_API_URL")
    if args.mode == "remote":
        return "remote", (remote_url or DEFAULT_REMOTE_URL).rstrip("/")
    if args.mode == "local":
        return "local", (args.api_url or DEFAULT_LOCAL_URL).rstrip("/")
    if remote_url:
        return "remote", remote_url.rstrip("/")
    return "local", (args.api_url or DEFAULT_LOCAL_URL).rstrip("/")


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    auth_mgr = RemoteAuthManager()

    if args.logout:
        removed = auth_mgr.clear_cached_session()
        print("Cleared cached remote TUI session." if removed else "No cached remote TUI session found.")
        return 0

    mode, target_url = resolve_mode_and_url(args)
    refresh = max(1.0, min(30.0, float(args.refresh)))
    initial_source: LogSourceId = args.log_source

    if mode == "remote":
        try:
            session = auth_mgr.resolve_token(
                api_url=target_url,
                explicit_token=args.token,
                supabase_url=args.supabase_url,
                supabase_anon_key=args.supabase_anon_key,
                force_login=bool(args.login),
            )
        except AuthError as exc:
            print(f"Authentication failed: {exc}", file=sys.stderr)
            return 2
        provider = RemoteDashboardProvider(
            api_url=target_url,
            session=session,
            auth_manager=auth_mgr,
            refresh_interval=refresh,
            supabase_anon_key=args.supabase_anon_key,
        )
    else:
        provider = LocalDashboardProvider(
            api_url=target_url,
            refresh_interval=refresh,
        )

    app = EtymosTuiApp(
        provider,
        initial_log_source=initial_source,
        no_color=bool(args.no_color),
    )
    try:
        result = app.run()
        return int(result) if isinstance(result, int) else app.exit_code_result
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

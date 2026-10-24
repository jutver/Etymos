"""
Read-only count of re-checks whose text picked up highlight numbers.

Before the fix in PLAN.md (Live-test fixes, Phase 1) the editor drew each
highlight's source number as a <sup> and read the text back with innerText, so
Save & re-check stored "…best results.41" as the document's new text. This
script lists every re-check (document_checks row) whose checked text has more
badge-shaped digits than the text it replaced, and whether it is still the
document's current check. It changes nothing.

    cd backend
    set -a; source .env; set +a
    .venv/bin/python scripts/audit_recheck_badge_digits.py            # summary + table
    .venv/bin/python scripts/audit_recheck_badge_digits.py --examples # plus a few snippets each
"""
from __future__ import annotations

import argparse
import os
import re
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)
os.chdir(BACKEND_DIR)

from api.supabase_client import get_client  # noqa: E402

# A 1-3 digit run glued to the end of a word or sentence: "results.41",
# "1998).18", "o62n" is caught as "o62". Real footnote markers look the same,
# which is why the count is compared with the text the check replaced.
BADGE = re.compile(r"(?<=[^\W\d_]|[.)\]])\d{1,3}(?=\s|$|[^\W\d_])")

PAGE = 200


def badge_count(text: str | None) -> int:
    return len(BADGE.findall(text or ""))


def examples(text: str, limit: int = 3) -> list[str]:
    out = []
    for m in BADGE.finditer(text):
        out.append(text[max(0, m.start() - 25):m.end() + 5].replace("\n", " "))
        if len(out) == limit:
            break
    return out


def all_checks(client) -> list[dict]:
    rows, start = [], 0
    while True:
        page = (
            client.table("document_checks")
            .select("id, document_id, kind, created_at, similarity_score, previous_score, baseline_text, previous_text")
            .order("created_at")
            .range(start, start + PAGE - 1)
            .execute()
            .data
            or []
        )
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        start += PAGE


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--examples", action="store_true", help="show a few suspected digits per check")
    parser.add_argument("--min-added", type=int, default=3, help="digits added before a check counts (default 3)")
    args = parser.parse_args()

    client = get_client()
    if client is None:
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; source backend/.env first.", file=sys.stderr)
        return 1

    checks = all_checks(client)
    newest = {}
    for row in checks:
        newest[row["document_id"]] = row["id"]  # ordered by created_at

    affected = []
    for row in checks:
        added = badge_count(row["baseline_text"]) - badge_count(row["previous_text"])
        if added >= args.min_added:
            affected.append((row, added))

    documents = {row["document_id"] for row, _ in affected}
    current = {row["document_id"] for row, _ in affected if newest[row["document_id"]] == row["id"]}
    print(f"Re-checks scanned:       {len(checks)}")
    print(f"Re-checks with digits:   {len(affected)} (>= {args.min_added} badge-shaped digits added)")
    print(f"Documents affected:      {len(documents)}")
    print(f"  ...still on that check: {len(current)} (their current text has the digits)")
    print()

    for row, added in affected:
        is_current = "current" if newest[row["document_id"]] == row["id"] else "superseded"
        print(
            f"{row['created_at'][:19]}  doc {row['document_id']}  check {row['id']}  {row['kind']:<12} "
            f"+{added:<4} digits  score {row['previous_score']} -> {row['similarity_score']}  {is_current}"
        )
        if args.examples:
            for snippet in examples(row["baseline_text"] or ""):
                print(f"      …{snippet}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())

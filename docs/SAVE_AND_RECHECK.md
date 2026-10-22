# Save & re-check

In the Report page's **Edit** view, **Save & re-check** saves the editor as a
new version, then runs the full check on only the paragraphs that changed.
Unchanged paragraphs keep their matches. The score is computed again over
the whole document with the same formula a fresh check uses, so it is exact.
Plain **Save** is still a free, unchecked draft, and the quick check
(`useQuickCheck.ts`) still gives free estimates while typing.

## Setup

1. Apply `supabase/migrations/20261021000000_document_checks.sql`. It adds:
   - the `document_checks` table (re-check history; written only by the backend)
   - `plan_definitions.recheck_free_limit` / `recheck_change_limit`
   - an activity log trigger (`document.rechecked`)
2. Restart the backend. Optional env vars:
   - `RATE_LIMIT_RECHECK` (default `20/hour`)
   - `RATE_LIMIT_RECHECK_QUOTE` (default `120/hour`, also used by restore)

Without the migration, quotes and re-checks fail with a 503 ("Re-check isn't
available right now"), and nothing is charged.

## Pricing rules (`backend/api/recheck_quota.py`)

A re-check is **free** when both hold, using the document's effective tier
(the higher of the owner's plan and `documents.unlocked_tier`):

| Tier | Free re-checks | Change limit |
|---|---|---|
| Free | 3 | under 30% |
| Standard (`student`) | 6 | under 50% |
| Premium (`professional`) | 10 | under 65% |

- **Change** = added or replaced words compared with the baseline, divided
  by the baseline's word count. Pure deletions are free. It is cumulative.
- **Baseline** = the text of the last paid re-check, or the original upload.
  A re-check replaces the stored passages, so the upload's text is kept on the
  first re-check's row (`previous_text`).
- A **paid** re-check (1 check from plan / Standard / Premium credits) becomes
  the new baseline and resets both counters. A credit also unlocks its tier
  for the document, as on a new check.
- Admins edit the limits in **Pricing → Plans & packs**.
- The server prices every re-check again and answers **409** if the cost
  differs from what the user confirmed. Charging happens only after success.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/reports/{id}/recheck/quote` `{blocks}` | What a re-check would cost. Read-only. |
| `POST /api/reports/{id}/recheck` `{blocks, version_id, expected_cost, balance_source?}` | Starts the job (202 `{job_id, quote}`). 409 `cost_changed` / `already_running`, 402 no quota. |
| `POST /api/reports/{id}/checks/{check_id}/restore` | Makes an earlier re-check's result current again (Version History). Free. |

`blocks` is the editor's `[{block_id, text}]` in reading order; `block_id` is
the `document_passages` id the editor rendered (`data-block-id`).

## How the re-check runs (`backend/recheck.py`)

1. Build the edited document from the blocks (one paragraph per block;
   images, heading levels and list types are kept from the stored passages).
2. A block is changed when its text differs from its passage.
3. Matches in unchanged blocks are found again by their sentence text and
   moved to the new offsets.
4. Runs of changed blocks go through metadata → search → rank → download →
   match → verify → cited-sources filter, with the report's earlier sources
   added to the candidate pool.
5. Merge, score with `final_report_builder.coverage_score`, record a
   `document_checks` row, then overwrite the report under the same id
   (`report_store.replace_report`: score and status only on `documents`, so a
   renamed title is kept).
6. AI detection and explanations run again over the whole edited document
   (`report_enrichment`, as on a fresh check). If AI detection can't run, the
   previous result is kept and marked `stale`, and no AI score is recorded.

## Version History

Each saved version shows:

- **% changed** since the version before it (same measure as pricing),
  computed by the web app at save time (`document_versions.changed_ratio`).
  Older versions without it are compared with the version below them.
- For a re-checked version: **similarity** and **AI-writing** scores with
  how far each moved since the check before it (green ▼ = lower, red ▲ =
  higher), from `document_checks.previous_score` / `previous_ai_score`.
  Drafts aren't checked, so they show no scores. AI scores are hidden on the
  Free tier, where AI detection is locked.

## Known limits

- Passage ids are new after a re-check, so a draft saved before it restores
  as a whole-HTML swap rather than block by block.
- Changed text under ~80 characters is too short to chunk and isn't searched.
- Pasted-text reports are one block, so any edit re-searches the whole text
  (the price still follows the measured change).
- Versions kept only in the browser (`localDocumentVersions.ts`) can't be
  re-checked; the user is asked to try saving again.

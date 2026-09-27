-- Inline formatting (bold/italic) kept from the original file, so a
-- document reopened from history renders the same <strong>/<em> the live
-- Report flow shows. Mirrors DocPassage.textMarks
-- (packages/shared/src/types.ts) and the backend block "marks" built by
-- backend/extractor.py's compute_text_marks.
--
-- Shape: a JSON array of {"start": int, "end": int, "style": "bold"|"italic"}
-- with offsets into this row's `text`. Nullable and additive: rows without
-- inline formatting (and every row saved before this migration) stay null
-- and render plain, exactly as before. backend/api/report_store.py retries
-- the insert without this column if it is missing, so applying this
-- migration is required only for formatting to survive a reload.

alter table public.document_passages
  add column text_marks jsonb;

comment on column public.document_passages.text_marks is
  'Inline bold/italic ranges [{start, end, style}] with offsets into text - see DocPassage.textMarks (packages/shared/src/types.ts).';

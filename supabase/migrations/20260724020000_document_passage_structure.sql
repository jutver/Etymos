-- Adds Document-view structure metadata to document_passages, mirroring the
-- optional fields added to DocPassage (packages/shared/src/types.ts) and to
-- backend/document_model.py's document.blocks: block type (heading/list
-- item/table/paragraph/...), heading level, list marker type, source page
-- (for real page-break rendering), and table grid contents.
--
-- All columns are nullable and additive — existing rows (and the flat
-- {id, document_id, text, severity, match_id, sort_order} shape callers
-- already read) are unaffected.
--
-- NOTE: as of this migration, nothing in the codebase INSERTs into
-- document_passages — the live Report flow builds passages client-side in
-- apps/web/src/screens/Analyzing/index.tsx from the backend's report JSON
-- (report.document.blocks) and never persists them to Supabase; the table
-- is only ever read back for a document reloaded from history
-- (apps/web/src/lib/documentsQueries.ts's fetchCheckedDocument), where it
-- currently returns rows with these columns null. This migration is
-- forward-looking groundwork for whichever change adds that INSERT path,
-- not something that changes any running behaviour by itself.

alter table public.document_passages
  add column block_type text check (
    block_type in ('title', 'heading', 'paragraph', 'list_item', 'table', 'image')
  ),
  add column level smallint check (level between 1 and 3),
  add column list_type text check (list_type in ('bullet', 'number')),
  add column page integer,
  add column table_rows jsonb;

comment on column public.document_passages.block_type is
  'Document-view rendering kind — see DocPassage.blockType (packages/shared/src/types.ts) and document_model.py block "type".';
comment on column public.document_passages.level is
  'Heading level 1-3; meaningful only when block_type = ''heading''.';
comment on column public.document_passages.list_type is
  'Bullet vs. numbered; meaningful only when block_type = ''list_item''.';
comment on column public.document_passages.page is
  '1-based source page (PDF page, or a synthetic bucket for .docx — see backend/extract_docx.py). Drives real page-break rendering.';
comment on column public.document_passages.table_rows is
  'Grid contents as a JSON array of string arrays (rows of cells); meaningful only when block_type = ''table''.';

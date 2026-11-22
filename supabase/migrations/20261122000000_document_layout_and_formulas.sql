-- Adds additive multi-column layout, sequential list numbering, mathematical
-- formula blocks / inline formulas (`document_passages`), and document-level
-- extraction provenance (`documents.extraction_meta`).
--
-- All columns and constraints are strictly additive and nullable so legacy
-- reports and pre-migration workers remain 100% compatible.

alter table public.document_passages
  drop constraint if exists document_passages_block_type_check;

alter table public.document_passages
  add constraint document_passages_block_type_check check (
    block_type in ('title', 'heading', 'paragraph', 'list_item', 'table', 'image', 'formula')
  );

alter table public.document_passages
  add column if not exists layout_band integer,
  add column if not exists column_role text check (column_role in ('full', 'left', 'right')),
  add column if not exists column_count smallint check (column_count in (1, 2)),
  add column if not exists list_number integer check (list_number >= 1),
  add column if not exists list_depth smallint check (list_depth between 0 and 4),
  add column if not exists formula_latex text,
  add column if not exists equation_number text,
  add column if not exists inline_formulas jsonb;

alter table public.documents
  add column if not exists extraction_meta jsonb;

comment on column public.document_passages.layout_band is
  '0-based horizontal band index within source page; drives multi-column Document view grouping.';
comment on column public.document_passages.column_role is
  'Column assignment within layout_band (full, left, right); null defaults to full.';
comment on column public.document_passages.column_count is
  'Active column count in layout_band (1 or 2); null defaults to 1.';
comment on column public.document_passages.list_number is
  '1-based item number when block_type = ''list_item'' and list_type = ''number''.';
comment on column public.document_passages.list_depth is
  '0..4 indentation depth for nested list items.';
comment on column public.document_passages.formula_latex is
  'Validated LaTeX representation when block_type = ''formula''.';
comment on column public.document_passages.equation_number is
  'Optional display equation label such as ''(1)'' or ''(3a)''.';
comment on column public.document_passages.inline_formulas is
  'JSON array of {start, end, latex} inline formula spans relative to passage text.';
comment on column public.documents.extraction_meta is
  'JSON provenance from the v2 hybrid PDF extraction pipeline (pipeline_version, document_mode, pages, counts, warnings).';

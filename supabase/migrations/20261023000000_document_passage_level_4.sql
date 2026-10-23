-- Heading levels go one deeper: the PDF extractor now reads a document's
-- outline from its numbering ("3" -> 2, "3.1" -> 3, "3.1.2" -> 4; see
-- backend/extractor.py's _assign_heading_levels), so document_passages.level
-- takes 1-4 instead of 1-3.
--
-- A "title" passage also uses level now: 1 for the main title, 2 for a
-- subtitle. Both fit the widened range.
--
-- Until this runs, backend/api/report_store.py stores a level-4 heading as
-- level 3, so saving a report never fails on it.

alter table public.document_passages
  drop constraint if exists document_passages_level_check;

alter table public.document_passages
  add constraint document_passages_level_check check (level between 1 and 4);

comment on column public.document_passages.level is
  'Heading level 1-4 when block_type = ''heading''; for block_type = ''title'', 1 is the main title and 2 a subtitle.';

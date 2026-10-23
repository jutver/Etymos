-- Where each match sits on the uploaded PDF's pages, so the Original view
-- draws its highlight from coordinates instead of searching the page text
-- for the matched sentence (see backend/pdf_geometry.py).
--
-- A JSON array of boxes in PDF points from the page's top-left corner:
--   [{"page": 3, "x0": 85.0, "y0": 120.6, "x1": 510.2, "y1": 131.6}, ...]
-- Null for matches checked before this existed, on pages the PDF rotates,
-- and for .docx uploads: the viewer then falls back to text search.
--
-- Until this runs, backend/api/report_store.py saves matches without it.

alter table public.document_matches
  add column if not exists pdf_rects jsonb;

comment on column public.document_matches.pdf_rects is
  'Boxes of the match on the uploaded PDF, [{page, x0, y0, x1, y1}] in PDF points; null when unknown.';

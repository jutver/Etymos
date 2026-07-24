-- Adds `image_url` to document_passages: the Supabase Storage URL for an
-- extracted image, mirroring the optional field added to DocPassage
-- (packages/shared/src/types.ts) and to backend/document_model.py's
-- document.blocks. Layered on top of
-- 20260724020000_document_passage_structure.sql, whose `block_type` check
-- constraint already allows 'image' — this migration only adds the column
-- that carries the uploaded image's URL for that block type.
--
-- Nullable and additive, like every other structure column on this table:
-- existing rows, and any block_type other than 'image', are unaffected.
-- Populated by backend/api/report_store.py's _extract_and_upload_images()
-- (uploads to the `documents` Storage bucket under
-- `{user_id}/{report_id}/images/{n}.{ext}`, reusing the bucket's existing
-- owner-scoped RLS policies rather than a new bucket).

alter table public.document_passages
  add column image_url text;

comment on column public.document_passages.image_url is
  'Supabase Storage URL for an extracted image; meaningful only when block_type = ''image''. Null when extraction/upload failed or Storage was not configured (best-effort — never blocks the plagiarism-check pipeline).';

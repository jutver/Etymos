-- Student verification evidence: photos only (JPG, PNG, WebP), up to 2 MB.
-- Storage rejects anything else at upload, so the limit holds even for a
-- request that skips the web page's own check (apps/web VerifyStudent).
-- Files already uploaded (PDFs included) are untouched and stay viewable.

update storage.buckets
set file_size_limit = 2097152,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'student-verification';

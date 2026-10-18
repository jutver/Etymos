-- Admins may read the support-attachments bucket, so the admin app can open
-- a ticket's attachments and original emails itself: it reads the ticket
-- from the database and signs a file's link when an admin clicks it,
-- instead of the backend signing every file each time a ticket loads.
--
-- Admins could already open all of these through the backend; requesters
-- still can't reach the bucket (20261009000000_support.sql), and every write
-- still goes through the service-role backend.

create policy "support_attachments_bucket_select_admin"
  on storage.objects for select
  using (bucket_id = 'support-attachments' and public.is_admin(auth.uid()));

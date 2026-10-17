-- Announcements overhaul: three kinds instead of one left-aligned top bar.
--
--   banner       Top bar, centred. Optional icon and a countdown to a moment
--                (a sale ending, say); the bar hides once the countdown ends.
--   popup        Dialog shown once per visitor: title, text, image, or any mix.
--   maintenance  Locks the site with a "come back later" screen from
--                starts_at (null = now) until an admin switches it off.
--                ends_at is ignored for this kind. Admins can still use the site.
--
-- Existing rows become banners. Images live in the public
-- `announcement-images` bucket (path: {uuid}.{ext}); only admins write there.

alter table public.announcements
  add column kind text not null default 'banner'
    check (kind in ('banner', 'popup', 'maintenance')),
  add column title text,
  add column icon text,
  add column countdown_to timestamptz,
  add column image_path text,
  add column updated_at timestamptz not null default now();

alter table public.announcements alter column message set default '';

alter table public.announcements
  add constraint announcements_banner_has_message
    check (kind <> 'banner' or length(btrim(message)) > 0),
  add constraint announcements_popup_has_content
    check (kind <> 'popup' or length(btrim(message)) > 0 or length(btrim(coalesce(title, ''))) > 0 or image_path is not null);

create trigger announcements_set_updated_at
  before update on public.announcements
  for each row execute function public.set_updated_at();

create index announcements_active_kind_idx
  on public.announcements (kind, created_at desc)
  where is_active;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'announcement-images',
  'announcement-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- Public bucket: anyone can read by URL. Writes are admin-only.
create policy "announcement_images_admin_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'announcement-images' and public.is_admin(auth.uid()));

create policy "announcement_images_admin_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'announcement-images' and public.is_admin(auth.uid()))
  with check (bucket_id = 'announcement-images' and public.is_admin(auth.uid()));

create policy "announcement_images_admin_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'announcement-images' and public.is_admin(auth.uid()));

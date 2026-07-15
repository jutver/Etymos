-- Ops/config panel tables. Public SELECT (feature flags and active
-- announcements can gate/inform the customer-facing app too); writes are
-- admin-only.

create table public.feature_flags (
  key text primary key,
  label text not null,
  description text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

alter table public.feature_flags enable row level security;

create policy "feature_flags_select_all"
  on public.feature_flags for select
  using (true);

create policy "feature_flags_write_admin_only"
  on public.feature_flags for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger feature_flags_set_updated_at
  before update on public.feature_flags
  for each row execute function public.set_updated_at();

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'success', 'error')),
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

create policy "announcements_select_all"
  on public.announcements for select
  using (true);

create policy "announcements_write_admin_only"
  on public.announcements for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

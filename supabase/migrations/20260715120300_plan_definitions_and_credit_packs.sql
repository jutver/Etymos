-- Moves apps/web/src/lib/mockData.ts's PLANS/CREDIT_PACKS arrays into editable
-- rows, so the admin ops/config panel has something real to manage. Public
-- SELECT is intentional: the customer-facing Pricing page reads these too.

create table public.plan_definitions (
  id text primary key check (id in ('free', 'student', 'professional')),
  name text not null,
  tagline text,
  price_monthly numeric not null default 0,
  price_annual numeric not null default 0,
  audience text,
  most_popular boolean not null default false,
  requires_verification boolean not null default false,
  features text[] not null default '{}',
  doc_limit integer,
  word_limit integer,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.plan_definitions enable row level security;

create policy "plan_definitions_select_all"
  on public.plan_definitions for select
  using (true);

create policy "plan_definitions_write_admin_only"
  on public.plan_definitions for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger plan_definitions_set_updated_at
  before update on public.plan_definitions
  for each row execute function public.set_updated_at();

create table public.credit_packs (
  id text primary key check (id in ('pack-standard', 'pack-premium')),
  label text not null,
  description text,
  checks integer not null,
  price numeric not null,
  badge text,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.credit_packs enable row level security;

create policy "credit_packs_select_all"
  on public.credit_packs for select
  using (true);

create policy "credit_packs_write_admin_only"
  on public.credit_packs for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create trigger credit_packs_set_updated_at
  before update on public.credit_packs
  for each row execute function public.set_updated_at();

-- profiles table, admin-role helper, and auto-provisioning trigger.
-- This is the foundation every other admin-portal table's RLS policy depends on.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  plan_tier text not null default 'free' check (plan_tier in ('free', 'student', 'professional')),
  billing_cycle text check (billing_cycle in ('monthly', 'annual')),
  credits integer not null default 0,
  checks_used_this_period integer not null default 0,
  plan_period_start timestamptz not null default now(),
  student_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- SECURITY DEFINER helper function. Policies on `profiles` itself cannot
-- subquery `profiles` directly (infinite RLS recursion) — this function
-- executes with definer privileges, outside the calling policy's RLS
-- evaluation, and is the pattern every other table's admin policy reuses.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = uid and role = 'admin'
  );
$$;

create policy "profiles_select_self_or_admin"
  on public.profiles for select
  using (auth.uid() = id or public.is_admin(auth.uid()));

create policy "profiles_update_self_or_admin"
  on public.profiles for update
  using (auth.uid() = id or public.is_admin(auth.uid()));

-- No INSERT policy: rows are only ever created by the trigger below
-- (which runs as SECURITY DEFINER and bypasses RLS), never directly by clients.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

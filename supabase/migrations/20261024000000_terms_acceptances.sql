-- Terms of Service consent. Every signed-in user must accept the current
-- version of the Terms (apps/web/src/lib/terms.ts TERMS_VERSION) before using
-- the web app; publishing a new version asks everyone again.
--
-- One row per user per version accepted, kept as the consent record. Users
-- can read their own rows but only add them through accept_terms(), so the
-- acceptance time is always the server's clock.

create table public.terms_acceptances (
  user_id uuid not null references public.profiles(id) on delete cascade,
  version text not null check (version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);

alter table public.terms_acceptances enable row level security;

create policy "terms_acceptances_select_self_or_admin"
  on public.terms_acceptances for select
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- Accepting the same version twice keeps the first acceptance time.
create or replace function public.accept_terms(p_version text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_accepted_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  insert into public.terms_acceptances (user_id, version)
  values (auth.uid(), p_version)
  on conflict (user_id, version) do nothing;

  select accepted_at into v_accepted_at
  from public.terms_acceptances
  where user_id = auth.uid() and version = p_version;
  return v_accepted_at;
end;
$$;

revoke execute on function public.accept_terms(text) from public, anon;
grant execute on function public.accept_terms(text) to authenticated;

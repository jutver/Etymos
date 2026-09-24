-- First-party product analytics: an append-only event log written by the web
-- app, plus one admin-only RPC that aggregates it for the admin portal's
-- "Activity" screen (DAU/WAU/MAU, funnel, feature usage, top pages).
--
-- Purely additive: no existing table, policy or function is changed.
--
-- Why a table + RPC instead of aggregating in the browser like the main
-- Dashboard does: the event table grows with every page view, so the numbers
-- must be computed in SQL (indexed range scans) rather than by pulling rows
-- into the admin app.
--
-- Privacy: events carry only a route pattern (`/report/:id`, never raw ids),
-- an event name and a small properties bag. Document text is never sent.

create table public.user_events (
  id bigint generated always as identity primary key,
  -- Null for a visitor who is not signed in yet (landing/pricing page views).
  -- Cascades so deleting an account (delete_account / admin force-delete)
  -- is never blocked by, and also removes, that user's activity trail.
  user_id uuid references public.profiles(id) on delete cascade,
  -- Random per browser tab session; lets us count anonymous visitors and
  -- approximate session length without any cookie.
  session_id text not null check (char_length(session_id) between 8 and 64),
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_]{1,47}$'),
  path text check (char_length(path) <= 200),
  properties jsonb not null default '{}'::jsonb check (pg_column_size(properties) <= 2048),
  created_at timestamptz not null default now()
);

create index user_events_created_at_idx on public.user_events (created_at);
create index user_events_user_created_idx on public.user_events (user_id, created_at) where user_id is not null;
create index user_events_name_created_idx on public.user_events (event_name, created_at);

alter table public.user_events enable row level security;

-- Anyone may append an event, but only as themselves (or anonymously). There
-- is deliberately no UPDATE/DELETE policy: the log is append-only.
create policy "user_events_insert_self_or_anon"
  on public.user_events for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- Only admins can read raw events (the RPC below is SECURITY DEFINER but
-- re-checks is_admin itself, so it does not widen this).
create policy "user_events_select_admin_only"
  on public.user_events for select
  using (public.is_admin(auth.uid()));

-- Aggregated activity for [p_start, p_end] (inclusive, UTC days), matching the
-- day bucketing the main Dashboard already uses.
--
--   dau / wau / mau      distinct signed-in users active on p_end / in the 7 /
--                        30 days ending on p_end (independent of p_start)
--   stickiness           average daily actives over those 30 days / mau
--   active_users         distinct signed-in users with any event in range
--   returning_users      of those, users active on 2+ different days
--   sessions             distinct session_id in range (includes anonymous)
--   avg_session_minutes  first->last event per session, sessions with 2+
--                        events only, each capped at 120 min so an idle
--                        background tab cannot skew the average
--   series               per-day distinct users and sessions
--   funnel               distinct visitors/users per product step in range
--   features             non-page_view events by count and distinct users
--   top_pages            most viewed route patterns
create or replace function public.admin_activity_summary(p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_month_from timestamptz;
  v_week_from date;
  v_dau integer;
  v_wau integer;
  v_mau integer;
  v_user_days integer;
  v_stickiness numeric;
  v_active_users integer;
  v_returning integer;
  v_events integer;
  v_sessions integer;
  v_avg_session numeric;
  v_series jsonb;
  v_funnel jsonb;
  v_features jsonb;
  v_pages jsonb;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_end < p_start then
    raise exception 'p_end must be on or after p_start' using errcode = '22023';
  end if;
  if p_end - p_start > 400 then
    raise exception 'date range too large (max 400 days)' using errcode = '22023';
  end if;

  v_from := p_start::timestamp at time zone 'UTC';
  v_to := (p_end + 1)::timestamp at time zone 'UTC';
  v_month_from := (p_end - 29)::timestamp at time zone 'UTC';
  v_week_from := p_end - 6;

  -- Rolling active-user windows anchored on p_end.
  select
    count(distinct user_id) filter (where day = p_end),
    count(distinct user_id) filter (where day >= v_week_from),
    count(distinct user_id),
    count(distinct (user_id, day))
  into v_dau, v_wau, v_mau, v_user_days
  from (
    select user_id, (created_at at time zone 'UTC')::date as day
    from public.user_events
    where user_id is not null and created_at >= v_month_from and created_at < v_to
  ) w;

  v_stickiness := case when v_mau > 0 then round((v_user_days / 30.0) / v_mau, 4) else 0 end;

  select count(*), count(*) filter (where active_days >= 2)
  into v_active_users, v_returning
  from (
    select user_id, count(distinct (created_at at time zone 'UTC')::date) as active_days
    from public.user_events
    where user_id is not null and created_at >= v_from and created_at < v_to
    group by user_id
  ) u;

  select count(*), count(distinct session_id)
  into v_events, v_sessions
  from public.user_events
  where created_at >= v_from and created_at < v_to;

  select coalesce(round(avg(least(extract(epoch from (last_at - first_at)) / 60.0, 120))::numeric, 1), 0)
  into v_avg_session
  from (
    select min(created_at) as first_at, max(created_at) as last_at, count(*) as n
    from public.user_events
    where created_at >= v_from and created_at < v_to
    group by session_id
  ) s
  where n >= 2;

  select coalesce(jsonb_agg(jsonb_build_object('date', s.day, 'users', s.users, 'sessions', s.sessions) order by s.day), '[]'::jsonb)
  into v_series
  from (
    select d.day, count(distinct e.user_id) as users, count(distinct e.session_id) as sessions
    from (select g::date as day from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g) d
    left join public.user_events e
      on e.created_at >= (d.day::timestamp at time zone 'UTC')
     and e.created_at < ((d.day + 1)::timestamp at time zone 'UTC')
    group by d.day
  ) s;

  with ev as (
    select user_id, session_id, event_name
    from public.user_events
    where created_at >= v_from and created_at < v_to
  )
  select jsonb_build_array(
    jsonb_build_object('step', 'visited',
      'count', (select count(distinct session_id) from ev where event_name = 'page_view')),
    jsonb_build_object('step', 'signed_up',
      'count', (select count(*) from public.profiles p where p.created_at >= v_from and p.created_at < v_to)),
    jsonb_build_object('step', 'check_started',
      'count', (select count(distinct user_id) from ev where event_name = 'check_started')),
    jsonb_build_object('step', 'report_viewed',
      'count', (select count(distinct user_id) from ev where event_name = 'report_viewed')),
    jsonb_build_object('step', 'engaged',
      'count', (select count(distinct user_id) from ev
                where event_name in ('rewrite_opened', 'source_comparison_opened', 'report_exported'))),
    jsonb_build_object('step', 'purchase_requested',
      'count', (select count(distinct user_id) from ev where event_name = 'purchase_requested'))
  )
  into v_funnel;

  select coalesce(jsonb_agg(jsonb_build_object('event', f.event_name, 'events', f.events, 'users', f.users) order by f.events desc), '[]'::jsonb)
  into v_features
  from (
    select event_name, count(*) as events, count(distinct user_id) as users
    from public.user_events
    where created_at >= v_from and created_at < v_to and event_name <> 'page_view'
    group by event_name
  ) f;

  select coalesce(jsonb_agg(jsonb_build_object('path', p.path, 'views', p.views) order by p.views desc), '[]'::jsonb)
  into v_pages
  from (
    select path, count(*) as views
    from public.user_events
    where created_at >= v_from and created_at < v_to and event_name = 'page_view' and path is not null
    group by path
    order by views desc
    limit 8
  ) p;

  return jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'events_total', v_events,
    'sessions', v_sessions,
    'active_users', v_active_users,
    'returning_users', v_returning,
    'dau', v_dau,
    'wau', v_wau,
    'mau', v_mau,
    'stickiness', v_stickiness,
    'avg_session_minutes', v_avg_session,
    'series', v_series,
    'funnel', v_funnel,
    'features', v_features,
    'top_pages', v_pages
  );
end;
$$;

revoke all on function public.admin_activity_summary(date, date) from public;
grant execute on function public.admin_activity_summary(date, date) to authenticated;

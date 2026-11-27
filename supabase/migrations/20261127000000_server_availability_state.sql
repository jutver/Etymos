-- Tracks external availability state for backend services so Supabase pg_cron
-- + pg_net probes and the external GitHub Actions monitor share one durable
-- incident timeline, deduplicating "Server Down" / "Server Back Online" alerts
-- across brief restarts (~20-40s auto-deploys) and host flapping.

create table if not exists public.server_availability_state (
  service_name text primary key,
  health_url text not null,
  status text not null default 'up' check (status in ('up', 'degraded', 'down')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  consecutive_successes integer not null default 0 check (consecutive_successes >= 0),
  first_failure_at timestamptz,
  down_since timestamptz,
  down_alert_sent_at timestamptz,
  recovered_at timestamptz,
  current_incident_id text,
  pending_recovery_incident_id text,
  pending_recovery_down_since timestamptz,
  pending_recovery_at timestamptz,
  last_checked_at timestamptz,
  last_http_status integer,
  last_error text,
  last_probe_request_id bigint,
  last_dispatch_at timestamptz,
  last_alert_at timestamptz,
  flapping_transitions integer not null default 0 check (flapping_transitions >= 0),
  flapping_window_started_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.server_availability_state (service_name, health_url, status)
values ('etymos-api', 'https://api.etymos.site/api/health', 'up')
on conflict (service_name) do nothing;

alter table public.server_availability_state enable row level security;

drop policy if exists "server_availability_state_select_admin" on public.server_availability_state;
create policy "server_availability_state_select_admin"
  on public.server_availability_state for select
  using (public.is_admin(auth.uid()));

revoke insert, update, delete on public.server_availability_state from anon, authenticated;

-- Two-phase non-blocking health probe driven by pg_cron + pg_net:
-- 1. Reads the completed net._http_response row for last_probe_request_id.
-- 2. Updates status / outage confirmation (>= 3 failures AND >= 120s elapsed).
-- 3. Reads Vault secrets (github_monitor_repo, github_monitor_token) and
--    dispatches .github/workflows/uptime-monitor.yml only on confirmed Down,
--    Recovery, or pending alert retry (single-owner flapping counters are read
--    here and mutated exclusively by uptime_monitor.py).
-- 4. Enqueues the next non-blocking net.http_get probe for the following tick.
create or replace function public.check_backend_availability_tick(
  p_service_name text default 'etymos-api'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_row public.server_availability_state%rowtype;
  v_http_status integer;
  v_http_body text;
  v_timed_out boolean;
  v_error_msg text;
  v_probe_found boolean := false;
  v_healthy boolean := false;
  v_symptom text := null;
  v_next_req_id bigint := null;
  v_dispatch_req_id bigint := null;
  v_action text := 'noop';
  v_should_dispatch boolean := false;
  v_flapping_suppressed boolean := false;
  v_repo text := null;
  v_token text := null;
  v_payload jsonb;
begin
  if to_regclass('net._http_response') is null then
    return jsonb_build_object(
      'service', p_service_name,
      'status', 'unknown',
      'action', 'skipped_no_pg_net',
      'consecutive_failures', 0,
      'next_probe_request_id', null
    );
  end if;

  select *
  into v_row
  from public.server_availability_state
  where service_name = p_service_name
  for update;

  if not found then
    return jsonb_build_object(
      'service', p_service_name,
      'status', 'unknown',
      'action', 'service_not_found',
      'consecutive_failures', 0,
      'next_probe_request_id', null
    );
  end if;

  -- Phase A: evaluate the probe enqueued on the previous tick.
  if v_row.last_probe_request_id is not null then
    execute 'select status_code, content, timed_out, error_msg from net._http_response where id = $1 limit 1'
      into v_http_status, v_http_body, v_timed_out, v_error_msg
      using v_row.last_probe_request_id;
    v_probe_found := found;

    if not v_probe_found then
      -- If the queued probe is recent (< 20s), let it finish before queuing another.
      if v_row.updated_at is not null and (v_now - v_row.updated_at) < interval '20 seconds' then
        return jsonb_build_object(
          'service', v_row.service_name,
          'status', v_row.status,
          'action', 'pending_probe',
          'consecutive_failures', v_row.consecutive_failures,
          'next_probe_request_id', v_row.last_probe_request_id
        );
      end if;
    else
      if coalesce(v_timed_out, false) then
        v_healthy := false;
        v_symptom := 'Health check timed out after 10s.';
      elsif v_error_msg is not null and length(btrim(v_error_msg)) > 0 then
        v_healthy := false;
        v_symptom := left('Connection failed: ' || btrim(v_error_msg), 500);
      elsif v_http_status = 200 and coalesce(v_http_body, '') ~ '"status"[[:space:]]*:[[:space:]]*"ok"' then
        v_healthy := true;
        v_symptom := null;
      elsif v_http_status = 530 or coalesce(v_http_body, '') ~* '1033' then
        v_healthy := false;
        v_symptom := left('Cloudflare Tunnel offline (HTTP ' || coalesce(v_http_status::text, '530') || ' / error 1033) — supervisord or cloudflared may not be running.', 500);
      elsif v_http_status in (502, 503, 504) then
        v_healthy := false;
        v_symptom := left('Backend API unreachable behind tunnel (HTTP ' || v_http_status::text || ') — uvicorn may still be starting or stopped.', 500);
      else
        v_healthy := false;
        v_symptom := left('Unexpected health response (HTTP ' || coalesce(v_http_status::text, 'unknown') || ').', 500);
      end if;

      v_row.last_checked_at := v_now;
      v_row.last_http_status := v_http_status;
      v_row.last_error := v_symptom;

      if v_healthy then
        if v_row.status = 'down' then
          v_row.status := 'up';
          v_row.recovered_at := v_now;
          v_row.consecutive_successes := 1;
          v_row.consecutive_failures := 0;
          if v_row.down_alert_sent_at is not null and v_row.current_incident_id is not null then
            v_row.pending_recovery_incident_id := v_row.current_incident_id;
            v_row.pending_recovery_down_since := coalesce(v_row.down_since, v_row.first_failure_at, v_now);
            v_row.pending_recovery_at := v_now;
            v_should_dispatch := true;
            v_action := 'dispatched_recovery';
          end if;
          v_row.first_failure_at := null;
          v_row.down_since := null;
          v_row.down_alert_sent_at := null;
          v_row.current_incident_id := null;
        else
          v_row.status := 'up';
          v_row.consecutive_failures := 0;
          v_row.consecutive_successes := v_row.consecutive_successes + 1;
          v_row.first_failure_at := null;
          v_row.down_since := null;
          v_row.last_error := null;
          if v_row.pending_recovery_incident_id is not null then
            v_should_dispatch := true;
            v_action := 'dispatched_retry';
          end if;
        end if;
      else
        v_row.consecutive_successes := 0;
        v_row.consecutive_failures := v_row.consecutive_failures + 1;
        if v_row.first_failure_at is null then
          v_row.first_failure_at := v_now;
        end if;

        if v_row.status = 'down' then
          if v_row.down_alert_sent_at is null then
            v_should_dispatch := true;
            v_action := 'dispatched_retry';
          end if;
        elsif v_row.consecutive_failures >= 3 and (v_now - v_row.first_failure_at) >= interval '120 seconds' then
          v_row.status := 'down';
          v_row.down_since := v_row.first_failure_at;
          v_row.down_alert_sent_at := null;
          v_row.current_incident_id := coalesce(v_row.current_incident_id, gen_random_uuid()::text);
          v_should_dispatch := true;
          v_action := 'dispatched_down';
        else
          v_row.status := 'degraded';
        end if;
      end if;
    end if;
  else
    v_action := 'enqueued_initial_probe';
  end if;

  -- Phase B: trigger GitHub Actions workflow_dispatch on confirmed transition or retry.
  if v_should_dispatch then
    -- Read-only flapping gate (counters are owned exclusively by uptime_monitor.py).
    if v_row.flapping_window_started_at is not null
       and (v_now - v_row.flapping_window_started_at) <= interval '1800 seconds'
       and v_row.flapping_transitions >= 4
       and v_row.last_alert_at is not null
       and (v_now - v_row.last_alert_at) < interval '900 seconds' then
      v_flapping_suppressed := true;
      v_action := 'suppressed_flapping';
    elsif v_row.last_dispatch_at is null or (v_now - v_row.last_dispatch_at) >= interval '45 seconds' then
      if to_regclass('vault.decrypted_secrets') is not null then
        execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'github_monitor_repo' limit 1$q$
          into v_repo;
        execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'github_monitor_token' limit 1$q$
          into v_token;
      end if;

      if coalesce(btrim(v_repo), '') <> '' and coalesce(btrim(v_token), '') <> '' then
        v_payload := jsonb_build_object(
          'ref', 'main',
          'inputs', jsonb_build_object(
            'trigger_source', 'supabase_pg_cron',
            'service', v_row.service_name
          )
        );
        execute 'select net.http_post(url => $1, headers => $2, body => $3)'
          into v_dispatch_req_id
          using
            'https://api.github.com/repos/' || btrim(v_repo) || '/actions/workflows/uptime-monitor.yml/dispatches',
            jsonb_build_object(
              'Accept', 'application/vnd.github+json',
              'Authorization', 'Bearer ' || btrim(v_token),
              'Content-Type', 'application/json',
              'User-Agent', 'etymos-supabase-uptime-monitor'
            ),
            v_payload;
        v_row.last_dispatch_at := v_now;
      else
        v_action := 'vault_not_configured';
      end if;
    end if;
  end if;

  -- Phase C: enqueue next non-blocking probe.
  execute 'select net.http_get(url => $1, timeout_milliseconds => 10000)'
    into v_next_req_id
    using v_row.health_url;

  update public.server_availability_state
  set
    status = v_row.status,
    consecutive_failures = v_row.consecutive_failures,
    consecutive_successes = v_row.consecutive_successes,
    first_failure_at = v_row.first_failure_at,
    down_since = v_row.down_since,
    down_alert_sent_at = v_row.down_alert_sent_at,
    recovered_at = v_row.recovered_at,
    current_incident_id = v_row.current_incident_id,
    pending_recovery_incident_id = v_row.pending_recovery_incident_id,
    pending_recovery_down_since = v_row.pending_recovery_down_since,
    pending_recovery_at = v_row.pending_recovery_at,
    last_checked_at = v_row.last_checked_at,
    last_http_status = v_row.last_http_status,
    last_error = v_row.last_error,
    last_probe_request_id = v_next_req_id,
    last_dispatch_at = v_row.last_dispatch_at,
    updated_at = v_now
  where service_name = v_row.service_name;

  return jsonb_build_object(
    'service', v_row.service_name,
    'status', v_row.status,
    'action', v_action,
    'consecutive_failures', v_row.consecutive_failures,
    'next_probe_request_id', v_next_req_id
  );
end;
$$;

revoke all on function public.check_backend_availability_tick(text) from public, anon, authenticated;

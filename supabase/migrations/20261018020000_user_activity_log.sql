-- User activities log: one row for everything that happens to a user's
-- account, shown in the admin portal's user panel.
--
-- Unlike audit_log (admin actions written by the admin app) and user_events
-- (page-view analytics written by the browser, so a client could forge it),
-- this log is written by the database itself: AFTER triggers on the tables
-- that hold account state. Whatever path makes a change — the web app, the
-- Python backend, an admin, the SePay webhook or the plan-expiry cron job —
-- it is recorded the same way, and no client can write or edit an entry.
--
-- Recorded:
--   account       signed up, signed in, password / email changed, profile
--                 edits, role and access changes, ban / unban, deletion
--                 requested / cancelled
--   plan          plan / billing cycle / end date changed, plan expired,
--                 plan allowance used / reset
--   credits       standard / premium credit balances, from -> to
--   purchase      order started, paid, declined, cancelled
--   document      uploaded, check completed / failed, renamed, moved to a
--                 project, trashed, restored, deleted, version saved,
--                 moderation changes
--   security      recovery email added / changed / verified / removed,
--                 password reset requested
--   verification  student verification submitted / approved / rejected
--   support       ticket opened, status changed, message sent / received
--
-- Who did it (actor_kind) comes from the request's auth.uid(): the user
-- themselves, an admin, or 'system' (backend service role, webhook, cron).
--
-- Logging never blocks the change it describes: every write goes through
-- log_user_activity(), which swallows its own errors.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.user_activity_log (
  id bigint generated always as identity primary key,
  -- Cascades so deleting an account also removes its trail, like user_events.
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- auth.uid() of whoever made the change; null for system changes.
  actor_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'admin', 'system')),
  category text not null check (
    category in ('account', 'plan', 'credits', 'purchase', 'document', 'security', 'verification', 'support')
  ),
  action text not null check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- What it was about, as shown in the log: a document title, ticket subject...
  subject text,
  -- Id of the row it was about (document, order, ticket...).
  ref_id text,
  -- Action-specific details, typically {from, to} pairs.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index user_activity_log_user_created_idx on public.user_activity_log (user_id, created_at desc, id desc);
create index user_activity_log_user_category_idx on public.user_activity_log (user_id, category, created_at desc);

alter table public.user_activity_log enable row level security;

create policy "user_activity_log_select_admin_only"
  on public.user_activity_log for select
  using (public.is_admin(auth.uid()));

-- No insert/update/delete policy, and no table privileges beyond reading:
-- only the SECURITY DEFINER functions below write here.
revoke insert, update, delete, truncate on public.user_activity_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Writer
-- ---------------------------------------------------------------------------

-- Set (transaction-locally) by functions that shuffle rows internally, such as
-- settle_checking_document, so the row triggers stay quiet and the function
-- logs one meaningful entry itself.
create or replace function public.activity_log_suppressed()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('etymos.suppress_activity_log', true), '') = 'on'
$$;

create or replace function public.log_user_activity(
  p_user_id uuid,
  p_category text,
  p_action text,
  p_subject text default null,
  p_ref_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_kind text;
begin
  if p_user_id is null then
    return;
  end if;
  -- The account is being deleted (a cascade from auth.users through
  -- profiles): there is nothing left to attach the entry to.
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return;
  end if;

  v_actor := auth.uid();
  v_kind := case
    when v_actor is null then 'system'
    when v_actor = p_user_id then 'user'
    when public.is_admin(v_actor) then 'admin'
    else 'user'
  end;

  insert into public.user_activity_log (user_id, actor_id, actor_kind, category, action, subject, ref_id, metadata)
  values (p_user_id, v_actor, v_kind, p_category, p_action, p_subject, p_ref_id, coalesce(p_metadata, '{}'::jsonb));
exception when others then
  raise warning 'user_activity_log: could not record % for %: %', p_action, p_user_id, sqlerrm;
end;
$$;

revoke all on function public.log_user_activity(uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- {from, to} for one changed value.
create or replace function public.activity_change(p_from anyelement, p_to anyelement)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('from', to_jsonb(p_from), 'to', to_jsonb(p_to))
$$;

-- ---------------------------------------------------------------------------
-- 3. profiles: account, plan and credits
-- ---------------------------------------------------------------------------

create or replace function public.log_profile_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan_meta jsonb := '{}'::jsonb;
  v_profile_meta jsonb := '{}'::jsonb;
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_user_activity(new.id, 'account', 'account.created', new.email, null,
      jsonb_build_object('plan_tier', new.plan_tier));
    return null;
  end if;

  -- Plan: tier, billing cycle and end date, as one entry.
  if new.plan_tier is distinct from old.plan_tier then
    v_plan_meta := v_plan_meta || jsonb_build_object('plan_tier', public.activity_change(old.plan_tier, new.plan_tier));
  end if;
  if new.billing_cycle is distinct from old.billing_cycle then
    v_plan_meta := v_plan_meta || jsonb_build_object('billing_cycle', public.activity_change(old.billing_cycle, new.billing_cycle));
  end if;
  if new.plan_expires_at is distinct from old.plan_expires_at then
    v_plan_meta := v_plan_meta || jsonb_build_object('plan_expires_at', public.activity_change(old.plan_expires_at, new.plan_expires_at));
  end if;
  if v_plan_meta <> '{}'::jsonb then
    perform public.log_user_activity(
      new.id, 'plan',
      -- Dropped to Free because the paid term ran out (expire_lapsed_plans).
      case
        when new.plan_tier = 'free' and old.plan_tier <> 'free'
             and old.plan_expires_at is not null and old.plan_expires_at <= now()
          then 'plan.expired'
        else 'plan.changed'
      end,
      null, null, v_plan_meta);
  end if;

  -- Plan allowance: checks used this period (counts up on use, resets to 0).
  if new.checks_used_this_period is distinct from old.checks_used_this_period then
    perform public.log_user_activity(
      new.id, 'plan',
      case when new.checks_used_this_period < old.checks_used_this_period then 'plan.usage_reset' else 'plan.usage' end,
      null, null,
      public.activity_change(old.checks_used_this_period, new.checks_used_this_period));
  end if;

  -- Credit balances, one entry per balance.
  if new.standard_credits is distinct from old.standard_credits then
    perform public.log_user_activity(new.id, 'credits', 'credits.changed', null, null,
      jsonb_build_object('balance', 'standard')
        || public.activity_change(old.standard_credits, new.standard_credits)
        || jsonb_build_object('delta', new.standard_credits - old.standard_credits));
  end if;
  if new.premium_credits is distinct from old.premium_credits then
    perform public.log_user_activity(new.id, 'credits', 'credits.changed', null, null,
      jsonb_build_object('balance', 'premium')
        || public.activity_change(old.premium_credits, new.premium_credits)
        || jsonb_build_object('delta', new.premium_credits - old.premium_credits));
  end if;

  if new.student_verified is distinct from old.student_verified then
    perform public.log_user_activity(new.id, 'verification',
      case when new.student_verified then 'verification.granted' else 'verification.revoked' end);
  end if;

  if new.role is distinct from old.role then
    perform public.log_user_activity(new.id, 'account', 'account.role_changed', null, null,
      public.activity_change(old.role, new.role));
  end if;

  if new.access_status is distinct from old.access_status then
    perform public.log_user_activity(new.id, 'account', 'account.access_changed', null, null,
      public.activity_change(old.access_status, new.access_status)
        || jsonb_build_object('note', new.access_note));
  end if;

  -- Ban: any change to the ban fields is either a ban (or a new ban term) or a lift.
  if new.banned_permanent is distinct from old.banned_permanent
     or new.banned_until is distinct from old.banned_until
     or new.ban_reason is distinct from old.ban_reason then
    if new.banned_permanent or new.banned_until is not null then
      perform public.log_user_activity(new.id, 'account', 'account.banned', null, null,
        jsonb_build_object('permanent', new.banned_permanent, 'until', new.banned_until, 'reason', new.ban_reason));
    else
      perform public.log_user_activity(new.id, 'account', 'account.unbanned');
    end if;
  end if;

  if new.deletion_requested_at is distinct from old.deletion_requested_at then
    perform public.log_user_activity(new.id, 'account',
      case when new.deletion_requested_at is not null then 'account.deletion_requested' else 'account.deletion_cancelled' end);
  end if;

  if new.display_name is distinct from old.display_name then
    v_profile_meta := v_profile_meta || jsonb_build_object('display_name', public.activity_change(old.display_name, new.display_name));
  end if;
  if new.email is distinct from old.email then
    v_profile_meta := v_profile_meta || jsonb_build_object('email', public.activity_change(old.email, new.email));
  end if;
  if v_profile_meta <> '{}'::jsonb then
    perform public.log_user_activity(new.id, 'account', 'account.profile_updated', null, null, v_profile_meta);
  end if;

  return null;
end;
$$;

create trigger profiles_log_activity
  after insert or update on public.profiles
  for each row execute function public.log_profile_activity();

-- ---------------------------------------------------------------------------
-- 4. documents
-- ---------------------------------------------------------------------------

create or replace function public.log_document_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- The backend's own report row (service role, already completed) is the
    -- result of a check the user started with a "checking" placeholder;
    -- settle_checking_document logs that check's outcome once.
    if auth.uid() is null and new.check_state <> 'checking' then
      return null;
    end if;
    perform public.log_user_activity(new.user_id, 'document', 'document.uploaded',
      coalesce(new.title, new.file_name), new.id::text,
      jsonb_build_object('file_name', new.file_name, 'language', new.language,
                         'project', new.project, 'word_count', new.word_count));
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.log_user_activity(old.user_id, 'document', 'document.deleted',
      coalesce(old.title, old.file_name), old.id::text,
      jsonb_build_object('was_trashed', old.is_trashed, 'check_state', old.check_state));
    return null;
  end if;

  v_title := coalesce(new.title, new.file_name);

  if new.check_state is distinct from old.check_state and old.check_state = 'checking' then
    if new.check_state = 'completed' then
      perform public.log_user_activity(new.user_id, 'document', 'document.check_completed', v_title, new.id::text,
        jsonb_build_object('similarity_score', new.similarity_score, 'status', new.status, 'word_count', new.word_count));
    elsif new.check_state = 'failed' then
      perform public.log_user_activity(new.user_id, 'document', 'document.check_failed', v_title, new.id::text,
        jsonb_build_object('error', new.check_error));
    end if;
  end if;

  if new.title is distinct from old.title then
    perform public.log_user_activity(new.user_id, 'document', 'document.renamed', v_title, new.id::text,
      public.activity_change(old.title, new.title));
  end if;

  if new.project is distinct from old.project then
    perform public.log_user_activity(new.user_id, 'document', 'document.moved', v_title, new.id::text,
      public.activity_change(old.project, new.project));
  end if;

  if new.is_trashed is distinct from old.is_trashed then
    perform public.log_user_activity(new.user_id, 'document',
      case when new.is_trashed then 'document.trashed' else 'document.restored' end,
      v_title, new.id::text);
  end if;

  if new.moderation_status is distinct from old.moderation_status then
    perform public.log_user_activity(new.user_id, 'document', 'document.moderated', v_title, new.id::text,
      public.activity_change(old.moderation_status, new.moderation_status)
        || jsonb_build_object('notes', new.moderation_notes));
  end if;

  return null;
end;
$$;

create trigger documents_log_activity
  after insert or update or delete on public.documents
  for each row execute function public.log_document_activity();

create or replace function public.log_document_version_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.documents;
begin
  if public.activity_log_suppressed() then
    return null;
  end if;
  select * into v_doc from public.documents where id = new.document_id;
  if found then
    perform public.log_user_activity(v_doc.user_id, 'document', 'document.version_saved',
      coalesce(v_doc.title, v_doc.file_name), v_doc.id::text,
      jsonb_build_object('label', new.label, 'word_count', new.word_count));
  end if;
  return null;
end;
$$;

create trigger document_versions_log_activity
  after insert on public.document_versions
  for each row execute function public.log_document_version_activity();

-- Settles a "checking" placeholder once its check is done, replacing the web
-- app's former update-then-delete pair (which would have logged a rename and
-- a deletion for every check) with one atomic step and one log entry.
--
-- When the backend persisted its own report row (p_report_id), the
-- placeholder's user-facing fields and the results move onto that row and the
-- placeholder is deleted; otherwise the placeholder itself is completed.
-- SECURITY DEFINER so it can write the log entry; it checks ownership itself
-- the way documents' RLS would (owner or admin; the service role passes).
-- Returns the id of the row that now holds the result.
create or replace function public.settle_checking_document(
  p_placeholder_id uuid,
  p_report_id uuid,
  p_results jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_placeholder public.documents;
  v_target uuid;
  v_result public.documents;
begin
  select * into v_placeholder from public.documents
  where id = p_placeholder_id
    and (v_caller is null or user_id = v_caller or public.is_admin(v_caller));
  if not found then
    -- Already settled by an earlier attempt that moved it onto the report row.
    if p_report_id is not null and exists (
      select 1 from public.documents
      where id = p_report_id and (v_caller is null or user_id = v_caller or public.is_admin(v_caller))
    ) then
      return p_report_id;
    end if;
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;

  -- Only the same user's report row can absorb the placeholder.
  if p_report_id is not null and p_report_id <> p_placeholder_id
     and exists (select 1 from public.documents where id = p_report_id and user_id = v_placeholder.user_id) then
    v_target := p_report_id;
  else
    v_target := p_placeholder_id;
  end if;

  perform set_config('etymos.suppress_activity_log', 'on', true);

  update public.documents d
  set check_state = 'completed',
      check_error = null,
      title = case when v_target = p_placeholder_id then d.title else v_placeholder.title end,
      file_name = case when v_target = p_placeholder_id then d.file_name else v_placeholder.file_name end,
      language = case when v_target = p_placeholder_id then d.language else v_placeholder.language end,
      project = case when v_target = p_placeholder_id then d.project else v_placeholder.project end,
      status = coalesce(p_results ->> 'status', d.status),
      similarity_score = coalesce((p_results ->> 'similarity_score')::numeric, d.similarity_score),
      similarity_score_free = coalesce((p_results ->> 'similarity_score')::numeric, d.similarity_score_free),
      word_count = coalesce((p_results ->> 'word_count')::integer, d.word_count),
      web_sources_scanned = coalesce((p_results ->> 'web_sources_scanned')::integer, d.web_sources_scanned),
      academic_sources_scanned = coalesce((p_results ->> 'academic_sources_scanned')::integer, d.academic_sources_scanned)
  where d.id = v_target
  returning * into v_result;

  if v_target <> p_placeholder_id then
    delete from public.documents where id = p_placeholder_id;
  end if;

  perform set_config('etymos.suppress_activity_log', '', true);

  -- Only the first settle of a check is news; a retry of an already settled
  -- placeholder (reconciliation after a reload) stays quiet.
  if v_placeholder.check_state = 'checking' then
    perform public.log_user_activity(v_result.user_id, 'document', 'document.check_completed',
      coalesce(v_result.title, v_result.file_name), v_result.id::text,
      jsonb_build_object('similarity_score', v_result.similarity_score, 'status', v_result.status,
                         'word_count', v_result.word_count));
  end if;

  return v_result.id;
end;
$$;

revoke all on function public.settle_checking_document(uuid, uuid, jsonb) from public, anon;
grant execute on function public.settle_checking_document(uuid, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. checkout_events: purchases
-- ---------------------------------------------------------------------------

create or replace function public.log_checkout_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  v_meta := jsonb_build_object(
    'kind', new.kind, 'plan_tier', new.plan_tier, 'billing_cycle', new.billing_cycle,
    'pack_id', new.pack_id, 'quantity', new.quantity, 'amount', new.amount,
    'currency', new.currency, 'payment_method', new.payment_method, 'payment_code', new.payment_code);

  if tg_op = 'INSERT' then
    perform public.log_user_activity(new.user_id, 'purchase',
      case when new.status = 'success' then 'purchase.completed' else 'purchase.started' end,
      null, new.id::text, v_meta);
    return null;
  end if;

  if new.status is distinct from old.status then
    perform public.log_user_activity(new.user_id, 'purchase',
      case new.status
        when 'success' then 'purchase.completed'
        when 'declined' then 'purchase.declined'
        when 'cancelled' then 'purchase.cancelled'
        else 'purchase.status_changed'
      end,
      null, new.id::text,
      v_meta || jsonb_build_object('status', public.activity_change(old.status, new.status),
                                   'paid_amount', new.paid_amount, 'review_note', new.review_note));
  end if;

  return null;
end;
$$;

create trigger checkout_events_log_activity
  after insert or update on public.checkout_events
  for each row execute function public.log_checkout_activity();

-- ---------------------------------------------------------------------------
-- 6. recovery_emails: security
-- ---------------------------------------------------------------------------

create or replace function public.log_recovery_email_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_user_activity(new.user_id, 'security', 'security.recovery_email_added', new.email);
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.log_user_activity(old.user_id, 'security', 'security.recovery_email_removed', old.email);
    return null;
  end if;

  if new.email is distinct from old.email then
    perform public.log_user_activity(new.user_id, 'security', 'security.recovery_email_changed', new.email, null,
      public.activity_change(old.email, new.email));
  end if;

  if new.verified_at is not null and old.verified_at is null then
    perform public.log_user_activity(new.user_id, 'security', 'security.recovery_email_verified', new.email);
  end if;

  -- A new reset code was issued (each request replaces the hash).
  if new.reset_code_hash is not null and new.reset_code_hash is distinct from old.reset_code_hash then
    perform public.log_user_activity(new.user_id, 'security', 'security.password_reset_requested', new.email);
  end if;

  return null;
end;
$$;

create trigger recovery_emails_log_activity
  after insert or update or delete on public.recovery_emails
  for each row execute function public.log_recovery_email_activity();

-- ---------------------------------------------------------------------------
-- 7. student_verification_requests
-- ---------------------------------------------------------------------------

create or replace function public.log_student_verification_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_user_activity(new.user_id, 'verification', 'verification.submitted', null, new.id::text);
  elsif new.status is distinct from old.status then
    perform public.log_user_activity(new.user_id, 'verification',
      case new.status
        when 'approved' then 'verification.approved'
        when 'rejected' then 'verification.rejected'
        else 'verification.reopened'
      end,
      null, new.id::text);
  end if;
  return null;
end;
$$;

create trigger student_verification_requests_log_activity
  after insert or update on public.student_verification_requests
  for each row execute function public.log_student_verification_activity();

-- ---------------------------------------------------------------------------
-- 8. support
-- ---------------------------------------------------------------------------

create or replace function public.log_support_ticket_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.activity_log_suppressed() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.log_user_activity(new.user_id, 'support', 'support.ticket_opened', new.subject, new.id::text,
      jsonb_build_object('number', new.number, 'category', new.category, 'source', new.source));
  elsif new.status is distinct from old.status then
    perform public.log_user_activity(new.user_id, 'support', 'support.ticket_status_changed', new.subject, new.id::text,
      jsonb_build_object('number', new.number) || public.activity_change(old.status, new.status));
  end if;
  return null;
end;
$$;

create trigger support_tickets_log_activity
  after insert or update on public.support_tickets
  for each row execute function public.log_support_ticket_activity();

create or replace function public.log_support_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ticket public.support_tickets;
begin
  if public.activity_log_suppressed() or new.internal then
    return null;
  end if;
  select * into v_ticket from public.support_tickets where id = new.ticket_id;
  if not found then
    return null;
  end if;
  -- A ticket's first message is the request itself; "ticket opened" covers it.
  if not exists (select 1 from public.support_messages where ticket_id = new.ticket_id and id <> new.id) then
    return null;
  end if;
  if new.author_type = 'user' then
    perform public.log_user_activity(v_ticket.user_id, 'support', 'support.message_sent', v_ticket.subject,
      v_ticket.id::text, jsonb_build_object('number', v_ticket.number, 'channel', new.channel));
  elsif new.author_type = 'agent' then
    perform public.log_user_activity(v_ticket.user_id, 'support', 'support.reply_received', v_ticket.subject,
      v_ticket.id::text, jsonb_build_object('number', v_ticket.number, 'channel', new.channel));
  end if;
  return null;
end;
$$;

create trigger support_messages_log_activity
  after insert on public.support_messages
  for each row execute function public.log_support_message_activity();

-- ---------------------------------------------------------------------------
-- 9. auth.users: sign-ins and credential changes
-- ---------------------------------------------------------------------------

-- Supabase Auth updates these columns itself; a trigger is the only way to
-- see sign-ins without touching the auth flow. log_user_activity never
-- raises, so this cannot break a sign-in.
create or replace function public.log_auth_user_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
    perform public.log_user_activity(new.id, 'account', 'account.signed_in', null, null,
      jsonb_build_object('provider', new.raw_app_meta_data ->> 'provider'));
  end if;
  if new.encrypted_password is distinct from old.encrypted_password and old.encrypted_password is not null then
    perform public.log_user_activity(new.id, 'security', 'security.password_changed');
  end if;
  if new.email is distinct from old.email then
    perform public.log_user_activity(new.id, 'security', 'security.login_email_changed', new.email, null,
      public.activity_change(old.email, new.email));
  end if;
  return null;
exception when others then
  return null;
end;
$$;

revoke all on function public.log_auth_user_activity() from public, anon, authenticated;

-- Only where auth.users has the columns this reads (it does on Supabase; the
-- local test stub may not).
do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'auth' and table_name = 'users'
        and column_name in ('last_sign_in_at', 'encrypted_password', 'email', 'raw_app_meta_data')) = 4 then
    create trigger on_auth_user_activity
      after update on auth.users
      for each row execute function public.log_auth_user_activity();
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Backfill what earlier rows already tell us
-- ---------------------------------------------------------------------------

-- Marked {"backfilled": true}: the time is when it happened, but who did it
-- is a best guess (the user for their own actions, system for outcomes).
insert into public.user_activity_log (user_id, actor_id, actor_kind, category, action, subject, ref_id, metadata, created_at)
select b.*
from (
select id as user_id, null::uuid as actor_id, 'system' as actor_kind, 'account' as category, 'account.created' as action,
       email as subject, null::text as ref_id,
       jsonb_build_object('backfilled', true) as metadata, created_at
from public.profiles
union all
select user_id, user_id, 'user', 'document', 'document.uploaded', coalesce(title, file_name), id::text,
       jsonb_build_object('backfilled', true, 'file_name', file_name, 'word_count', word_count), uploaded_at
from public.documents
union all
select user_id, null, 'system', 'document', 'document.check_completed', coalesce(title, file_name), id::text,
       jsonb_build_object('backfilled', true, 'similarity_score', similarity_score, 'status', status), uploaded_at
from public.documents where check_state = 'completed' and status is not null
union all
select user_id, user_id, 'user', 'purchase', 'purchase.started', null, id::text,
       jsonb_build_object('backfilled', true, 'kind', kind, 'plan_tier', plan_tier, 'billing_cycle', billing_cycle,
                          'pack_id', pack_id, 'quantity', quantity, 'amount', amount, 'currency', currency), created_at
from public.checkout_events
union all
select user_id, null, 'system', 'purchase',
       case status when 'success' then 'purchase.completed' when 'declined' then 'purchase.declined' else 'purchase.cancelled' end,
       null, id::text,
       jsonb_build_object('backfilled', true, 'kind', kind, 'plan_tier', plan_tier, 'billing_cycle', billing_cycle,
                          'pack_id', pack_id, 'quantity', quantity, 'amount', amount, 'currency', currency,
                          'paid_amount', paid_amount),
       coalesce(paid_at, reviewed_at, created_at)
from public.checkout_events where status <> 'pending'
union all
select user_id, user_id, 'user', 'security', 'security.recovery_email_added', email, null,
       jsonb_build_object('backfilled', true), created_at
from public.recovery_emails
union all
select user_id, user_id, 'user', 'security', 'security.recovery_email_verified', email, null,
       jsonb_build_object('backfilled', true), verified_at
from public.recovery_emails where verified_at is not null
union all
select user_id, user_id, 'user', 'verification', 'verification.submitted', null, id::text,
       jsonb_build_object('backfilled', true), created_at
from public.student_verification_requests
union all
select user_id, reviewed_by, 'admin', 'verification',
       case status when 'approved' then 'verification.approved' else 'verification.rejected' end, null, id::text,
       jsonb_build_object('backfilled', true), reviewed_at
from public.student_verification_requests where status <> 'pending' and reviewed_at is not null
union all
select user_id, user_id, 'user', 'support', 'support.ticket_opened', subject, id::text,
       jsonb_build_object('backfilled', true, 'number', number, 'category', category), created_at
from public.support_tickets where user_id is not null
) b
where b.created_at is not null
  and exists (select 1 from public.profiles p where p.id = b.user_id);

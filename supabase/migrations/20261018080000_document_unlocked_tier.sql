-- Per-document plan tier, so a credit can unlock one report's paid features
-- without a subscription.
--
-- The Report screen gates Semantic Detection, explanations, AI-content
-- detection, PDF export (Standard) and AI Rewrite (Premium) on the user's plan.
-- A document's own tier now counts too: the screen uses whichever of the two is
-- higher. `unlocked_tier` gets set in two ways:
--   - a check paid for with a Standard/Premium credit is stamped with that tier
--     when the backend saves it (report_store.save_report);
--   - the user spends a credit on an existing report from the paywall
--     (unlock_document_with_credit below, via POST /api/documents/{id}/unlock).
--
-- documents_all_self_or_admin lets owners update their own rows (rename, trash,
-- project...), so without the trigger below anyone could grant themselves a
-- tier straight from the browser. Same pattern as
-- prevent_profile_self_privilege_escalation for profiles' credit columns.

alter table public.documents
  add column unlocked_tier text check (unlocked_tier in ('student', 'professional'));

create or replace function public.prevent_document_tier_self_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' or public.is_admin(auth.uid()) then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.unlocked_tier is not null)
     or (tg_op = 'UPDATE' and new.unlocked_tier is distinct from old.unlocked_tier)
  then
    raise exception 'Not allowed to modify this field.';
  end if;

  return new;
end;
$$;

create trigger documents_prevent_tier_self_grant
  before insert or update on public.documents
  for each row execute function public.prevent_document_tier_self_grant();

-- Spends one credit and raises the document to the matching tier, atomically:
-- a Standard credit unlocks 'student', a Premium credit 'professional'. Never
-- lowers a tier, and never charges for a tier the document already has.
-- Returns {status, unlocked_tier, standard_credits, premium_credits} where
-- status is 'ok' | 'already_unlocked' | 'not_found' | 'no_credits'.
create or replace function public.unlock_document_with_credit(
  p_user_id uuid,
  p_document_id uuid,
  p_tier text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_standard integer;
  v_premium integer;
begin
  if p_tier not in ('student', 'professional') then
    raise exception 'Unknown tier %', p_tier;
  end if;

  select unlocked_tier into v_current
    from public.documents
   where id = p_document_id and user_id = p_user_id
     for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select standard_credits, premium_credits into v_standard, v_premium
    from public.profiles
   where id = p_user_id
     for update;

  if v_current = 'professional' or v_current = p_tier then
    return jsonb_build_object('status', 'already_unlocked', 'unlocked_tier', v_current,
                              'standard_credits', v_standard, 'premium_credits', v_premium);
  end if;

  if (p_tier = 'student' and coalesce(v_standard, 0) <= 0)
     or (p_tier = 'professional' and coalesce(v_premium, 0) <= 0)
  then
    return jsonb_build_object('status', 'no_credits', 'unlocked_tier', v_current,
                              'standard_credits', v_standard, 'premium_credits', v_premium);
  end if;

  if p_tier = 'student' then
    update public.profiles set standard_credits = standard_credits - 1
     where id = p_user_id returning standard_credits into v_standard;
  else
    update public.profiles set premium_credits = premium_credits - 1
     where id = p_user_id returning premium_credits into v_premium;
  end if;

  update public.documents set unlocked_tier = p_tier where id = p_document_id;

  return jsonb_build_object('status', 'ok', 'unlocked_tier', p_tier,
                            'standard_credits', v_standard, 'premium_credits', v_premium);
end;
$$;

revoke all on function public.unlock_document_with_credit(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unlock_document_with_credit(uuid, uuid, text) to service_role;

-- Lets the web app ask whether the signed-in account has already answered
-- (or skipped) "How did you hear about Etymos?". Until now only the browser
-- remembered it (localStorage), so a new browser or a cleared one asked again,
-- because users can't read the table (admin-only select).
--
-- Answers only about the caller, and only yes or no: the answer itself stays
-- admin-only. visitor_id is the user id for every signed-in answer
-- (20261027000000_referral_survey_signed_in_only.sql), and it outlives a
-- deleted account's user_id, so both are checked.
--
-- Purely additive: no existing table, policy or function is changed.

create or replace function public.referral_survey_answered()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from public.referral_survey_responses
    where visitor_id = auth.uid()::text or user_id = auth.uid()
  );
$$;

revoke all on function public.referral_survey_answered() from public, anon;
grant execute on function public.referral_survey_answered() to authenticated;

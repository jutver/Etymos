-- The referral survey is now asked only of signed-in users, on the home page
-- (apps/web/src/components/ReferralSurvey.tsx), and keyed by account: the web
-- app sends the user id as visitor_id. Replace the insert policy so the
-- database refuses signed-out answers too, not just the UI.
--
-- Every answer recorded so far is wiped: they were collected per browser,
-- mostly from signed-out visitors, and would skew the new per-account counts.
-- Deliberate and irreversible; the survey restarts from zero.

delete from public.referral_survey_responses;

drop policy "referral_survey_insert_self_or_anon" on public.referral_survey_responses;

create policy "referral_survey_insert_self"
  on public.referral_survey_responses for insert
  to authenticated
  with check (user_id = auth.uid());

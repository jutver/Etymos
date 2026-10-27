-- Wipe every referral survey answer recorded so far. They were collected per
-- browser, mostly from signed-out visitors, and would skew the per-account
-- counts that 20261027000000_referral_survey_signed_in_only.sql starts.
-- Deliberate and irreversible; the survey restarts from zero.
--
-- A separate migration because 20261027000000 was already applied before this
-- delete was added to it, so editing that file would never run it.

delete from public.referral_survey_responses;

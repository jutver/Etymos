-- "How did you hear about Etymos?" — the one-question survey the web app asks
-- on a visitor's first visit (apps/web/src/components/ReferralSurvey.tsx),
-- read back by the admin portal's Referral sources screen.
--
-- One row per browser: visitor_id is a random id the web app keeps in
-- localStorage, and the unique index stops a second answer from the same
-- browser. Closing the dialog without answering is stored as 'skipped' so the
-- admin screen can show a response rate.
--
-- Purely additive: no existing table, policy or function is changed.

create table public.referral_survey_responses (
  id bigint generated always as identity primary key,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  -- Null for a visitor who is not signed in. The answer outlives a deleted
  -- account: it is a marketing statistic, not account data.
  user_id uuid references public.profiles(id) on delete set null,
  source text not null check (source in ('facebook', 'tiktok', 'friend', 'search', 'other', 'skipped')),
  -- The visitor's own words, only for 'other'.
  other_text text check (char_length(other_text) <= 200),
  created_at timestamptz not null default now(),
  constraint referral_survey_other_text_only_for_other check (other_text is null or source = 'other')
);

create unique index referral_survey_responses_visitor_idx on public.referral_survey_responses (visitor_id);
create index referral_survey_responses_created_at_idx on public.referral_survey_responses (created_at);

alter table public.referral_survey_responses enable row level security;

-- Anyone may answer, but only as themselves (or anonymously). No UPDATE or
-- DELETE policy: an answer is final.
create policy "referral_survey_insert_self_or_anon"
  on public.referral_survey_responses for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

create policy "referral_survey_select_admin_only"
  on public.referral_survey_responses for select
  using (public.is_admin(auth.uid()));

-- Support intake switches, on the admin Support screen (and the Feature Flags
-- page, being feature_flags rows: public read, admin write). Both start on,
-- which is how support worked before. backend/api/support.py and
-- support_inbound.py read them.
--
--   support_guest_requests  new requests from the /contact form while signed out
--   support_email_requests  new requests from email to the support address
--
-- Off only stops *new* requests: replies on conversations that already exist
-- (guest links, email replies to our messages) keep coming in, so turning a
-- switch off never cuts a conversation an agent is in the middle of.

insert into public.feature_flags (key, label, description, enabled)
values
  (
    'support_guest_requests',
    'Support requests from signed-out visitors',
    'When enabled, people who are not signed in can open a support request from the Contact page.',
    true
  ),
  (
    'support_email_requests',
    'Support requests by email',
    'When enabled, an email to the support address that is not a reply to an existing request opens a new one.',
    true
  )
on conflict (key) do nothing;

-- New emails turned away while support_email_requests is off.
alter table public.support_inbound_log drop constraint support_inbound_log_outcome_check;
alter table public.support_inbound_log add constraint support_inbound_log_outcome_check
  check (outcome in ('processing', 'appended', 'ticket_created', 'ignored_auto', 'ignored_own', 'ignored_banned',
                     'ignored_disabled', 'failed'));

-- Retire manual purchase approval.
--
-- Before SePay (20261004000000_sepay_payments.sql), an admin granted each
-- purchase by hand after checking the bank account. Payments now settle
-- automatically, and a transfer the webhook can't match is linked through
-- admin_match_payment_transaction, which ties the grant to money actually
-- received. Nothing should be grantable without a recorded transfer, so the
-- approval function goes. The admin portal's Waitlist -> Purchases queue
-- that called it is removed in the same change.
drop function if exists public.approve_purchase_request(uuid, text);

-- Rollback for phase7-receipts.sql. Removes the receipt triggers, functions, columns and sequence.
-- NOTE: the receipt numbers and frozen receipts already given to paid deposits are deleted with the columns.
-- Nothing else is touched (payments, seats, bookings, refunds, invoices and every existing function stay as they are).
begin;
drop trigger if exists trg_party_receipt_email on public.party_payments;
drop trigger if exists trg_party_receipt_assign on public.party_payments;
drop function if exists public.party_my_receipts(uuid);
drop function if exists public.party_receipt_email_trg();
drop function if exists public.party_receipt_assign();
drop function if exists public.party_receipt_build(public.party_payments, text);
drop index if exists public.party_payments_receipt_no_key;
alter table public.party_payments drop column if exists receipt_data, drop column if exists receipt_no;
drop sequence if exists public.party_receipt_seq;
commit;

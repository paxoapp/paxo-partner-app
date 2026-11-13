-- Party Pool phase 7: deposit receipts.
-- When a 30% DEPOSIT payment becomes paid, the payment gets a receipt number (PR-000001, ...) and a frozen copy of the receipt
-- (party_payments.receipt_data), and one receipt email is queued through the existing party_email() -> send-transactional-email path.
-- Only kind = 'deposit'. Balance payments and 'full' payments (joining after the party is confirmed) get no receipt here.
-- No GST split and nothing about drinks is stored on the receipt: it holds only the fields listed in party_receipt_build().
--
-- NOTHING existing is changed: no existing function, trigger, policy, constraint or row (except the two new columns, filled
-- only for the payment that is already paid and is a deposit). The payment, refund and confirmation code is not touched.
-- The receipt code can never make a payment fail: both triggers swallow their own errors.
-- The numbering of the existing paid deposit (last statement) does NOT send an email: it never changes `status`, and the
-- email trigger only fires when status changes to paid.

create sequence public.party_receipt_seq;
revoke all on sequence public.party_receipt_seq from public, anon, authenticated;

alter table public.party_payments
  add column receipt_no   text,
  add column receipt_data jsonb;
create unique index party_payments_receipt_no_key on public.party_payments (receipt_no) where receipt_no is not null;

-- builds the frozen receipt for one payment row. Used for new payments (the row being updated) and for the backfill.
create or replace function public.party_receipt_build(pay public.party_payments, p_no text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; v_venue text; v_name text; v_n int; v_total numeric; v_paid numeric; v_guests jsonb; v_party_paid int;
begin
  select * into p from public.parties where id = pay.party_id;
  select name into v_venue from public.venues where id = p.venue_id;
  select full_name into v_name from public.profiles where id = pay.customer_id;
  -- seats of this booking that are paid, plus the seats this payment is paying for (they are marked paid just after the payment row)
  select count(*)::int into v_n from public.party_seats where booking_id = pay.booking_id and (status = 'paid' or payment_id = pay.id);
  v_total := public.party_seat_total(p.id, v_n);
  select coalesce(sum(amount), 0) + pay.amount into v_paid from public.party_payments
   where booking_id = pay.booking_id and status = 'paid' and refund_status = 'none' and id <> pay.id;
  select coalesce(jsonb_agg(s.guest_name order by s.created_at), '[]'::jsonb) into v_guests from public.party_seats s where s.payment_id = pay.id;
  select count(*)::int into v_party_paid from public.party_seats where party_id = p.id and (status = 'paid' or payment_id = pay.id);
  return jsonb_build_object(
    'receipt_no',    p_no,
    'party_id',      p.id,
    'paid_at',       coalesce(pay.paid_at, now()),
    'paid_at_text',  public.party_ist(coalesce(pay.paid_at, now())),
    'party_title',   p.title,
    'venue_name',    v_venue,
    'party_start_text', public.party_ist(p.starts_at),
    'buyer_name',    v_name,
    'guests',        v_guests,
    'seats',         pay.seats_count,
    'booking_seats', v_n,
    'ticket_price',  v_total,
    'amount_paid',   pay.amount,
    'balance',       greatest(v_total - v_paid, 0),
    'reference',     coalesce(pay.cashfree_payment_id, pay.razorpay_payment_id, upper(left(pay.id::text, 8))),
    'min_seats',     p.min_paid_seats,
    'paid_seats',    v_party_paid,
    'closes_text',   public.party_ist(p.closes_at));
end $$;
revoke all on function public.party_receipt_build(public.party_payments, text) from public, anon, authenticated;

-- BEFORE trigger: gives the number and the frozen receipt, in the same update that marks the payment paid
create or replace function public.party_receipt_assign() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_data jsonb; v_no text;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.kind = 'deposit'
     and new.refund_status = 'none' and new.receipt_no is null then
    begin
      v_data := public.party_receipt_build(new, null);          -- built first, so a failure never uses up a number
      v_no := 'PR-' || lpad(nextval('public.party_receipt_seq')::text, 6, '0');
      new.receipt_data := jsonb_set(v_data, '{receipt_no}', to_jsonb(v_no));
      new.receipt_no := v_no;
    exception when others then
      new.receipt_no := null; new.receipt_data := null;       -- a receipt problem must never stop a payment
    end;
  end if;
  return new;
end $$;
revoke all on function public.party_receipt_assign() from public, anon, authenticated;
create trigger trg_party_receipt_assign before update of status on public.party_payments
  for each row execute function public.party_receipt_assign();

-- AFTER trigger: one email, only when the payment has just become paid and was given a receipt. The idempotency key makes a repeat impossible.
create or replace function public.party_receipt_email_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.party_email(new.customer_id, 'party_deposit_receipt', new.receipt_data, 'party-receipt-' || new.id);
  return null;
exception when others then
  return null;
end $$;
revoke all on function public.party_receipt_email_trg() from public, anon, authenticated;
create trigger trg_party_receipt_email after update of status on public.party_payments
  for each row when (new.status = 'paid' and old.status is distinct from 'paid' and new.receipt_no is not null)
  execute function public.party_receipt_email_trg();

-- the customer's own receipts (optionally for one party). Same visibility gate as the other party functions.
create or replace function public.party_my_receipts(p_party_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.party_pool_allowed() then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x.receipt_data || jsonb_build_object('payment_id', x.id, 'refunded', x.refund_status <> 'none') order by x.paid_at, x.receipt_no)
      from public.party_payments x
     where x.customer_id = auth.uid() and x.status = 'paid' and x.receipt_no is not null
       and (p_party_id is null or x.party_id = p_party_id)), '[]'::jsonb);
end $$;
revoke all on function public.party_my_receipts(uuid) from public, anon, authenticated;
grant execute on function public.party_my_receipts(uuid) to authenticated;

-- number the deposits that are already paid (no email: this update does not touch `status`)
with n as (
  select id, 'PR-' || lpad(nextval('public.party_receipt_seq')::text, 6, '0') as no
    from (select id from public.party_payments
           where status = 'paid' and kind = 'deposit' and refund_status = 'none' and receipt_no is null
           order by paid_at, id) s)
update public.party_payments x
   set receipt_no = n.no, receipt_data = public.party_receipt_build(x, n.no)
  from n where n.id = x.id;

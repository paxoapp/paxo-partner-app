-- Settlements fix 1: mark every payment as TEST or LIVE money.       (migration name: settlements_gateway_mode)
-- NOT APPLIED. Written for review. Nothing here changes a payment amount, a refund, a booking or any Razorpay / Cashfree code.
--
-- Rule (fail-safe): a payment is LIVE only when it was recorded while a real-money gateway was switched on.
--   Cashfree : platform_settings.cashfree_mode = 'production'   (the same setting create-cashfree-order already uses)
--   Razorpay : platform_settings.razorpay_mode = 'live'          (new setting, default 'test'; flip it to 'live' on the day Razorpay goes live)
-- Anything else is TEST. If somebody forgets to flip razorpay_mode, real payments are shown as TEST (hidden, not counted): annoying, never dangerous.

-- 1. The Razorpay switch (you said Razorpay is in test mode today).
alter table public.platform_settings
  add column if not exists razorpay_mode text not null default 'test' check (razorpay_mode in ('test', 'live'));

-- 2. The new column. Every existing row becomes 'test' by default.
alter table public.payments
  add column gateway_mode text not null default 'test' check (gateway_mode in ('test', 'live'));

-- 3. The one real-money payment so far: PAXO-000738, Cashfree production, Rs 10 (and nothing else).
do $m$
declare n int;
begin
  update public.payments p
     set gateway_mode = 'live'
    from public.bookings b
   where b.id = p.booking_id and b.booking_ref = 'PAXO-000738' and p.provider = 'cashfree';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'expected to mark exactly 1 live payment, marked %', n; end if;
end $m$;

-- 4. From now on every new payment row is stamped when it is recorded (no edge function has to change).
create or replace function public.set_payment_gateway_mode()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare s record;
begin
  select razorpay_mode, cashfree_mode into s from public.platform_settings limit 1;
  new.gateway_mode := case
    when new.provider = 'cashfree' and s.cashfree_mode = 'production' then 'live'
    when new.provider = 'razorpay' and s.razorpay_mode = 'live' then 'live'
    else 'test' end;
  return new;
end $f$;

drop trigger if exists trg_set_payment_gateway_mode on public.payments;
create trigger trg_set_payment_gateway_mode before insert on public.payments
  for each row execute function public.set_payment_gateway_mode();

-- 5. Nobody but the server can change it afterwards (same guard the other money fields already have).
create or replace function public.protect_payment_financial_fields()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    NEW.booking_id := OLD.booking_id;
    NEW.razorpay_order_id := OLD.razorpay_order_id;
    NEW.razorpay_payment_id := OLD.razorpay_payment_id;
    NEW.razorpay_signature := OLD.razorpay_signature;
    NEW.amount := OLD.amount;
    NEW.payment_type := OLD.payment_type;
    NEW.status := OLD.status;
    NEW.paid_at := OLD.paid_at;
    NEW.gateway_fee := OLD.gateway_fee; NEW.gateway_tax := OLD.gateway_tax;
    NEW.gateway_fee_estimated := OLD.gateway_fee_estimated; NEW.gateway_fee_deducted := OLD.gateway_fee_deducted;
    NEW.forfeited_amount := OLD.forfeited_amount; NEW.non_refundable_ack_at := OLD.non_refundable_ack_at;
    NEW.refund_amount := OLD.refund_amount; NEW.refund_percent := OLD.refund_percent;
    NEW.refund_status := OLD.refund_status; NEW.refunded_at := OLD.refunded_at;
    NEW.razorpay_refund_id := OLD.razorpay_refund_id; NEW.refund_attempts := OLD.refund_attempts;
    NEW.refund_last_error := OLD.refund_last_error; NEW.refund_next_retry_at := OLD.refund_next_retry_at;
    NEW.coupon_id := OLD.coupon_id; NEW.coupon_discount := OLD.coupon_discount;
    NEW.gateway_mode := OLD.gateway_mode;   -- the only line added to this function
    -- only settlement_status and settled_at may be changed by an admin
  END IF;
  RETURN NEW;
END;
$f$;

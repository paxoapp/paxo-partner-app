-- Settlements fix 2: a payment whose whole deposit went back to the customer owes the venue nothing, so its
-- settlement_status must say so ('n/a') instead of 'pending'.               (migration name: settlements_nothing_to_transfer)
-- NOT APPLIED. Written for review. It changes no amount, no refund, no booking, no hold and no edge function.
--
-- Rule (the same sum the Settlements screen already uses to work out "To transfer to venue"):
--   owed to the venue = deposit paid - refund to the customer - gateway fee deducted from that refund   (never below 0)
-- When a refund exists (refund_amount > 0) and owed = 0, the payment is 'n/a', not 'pending'.
-- A payment that is already 'settled' is never touched.

-- 0. The column only allows 'pending' and 'settled' today (constraint payments_settlement_status_check), so 'n/a' has to be allowed first.
alter table public.payments drop constraint payments_settlement_status_check;
alter table public.payments add constraint payments_settlement_status_check
  check (settlement_status = any (array['pending'::text, 'settled'::text, 'n/a'::text]));

-- 1. From now on: stamped automatically, whichever code writes the refund (Razorpay path, Cashfree manual path, admin marking).
create or replace function public.set_settlement_na()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  if new.status = 'paid'
     and new.settlement_status = 'pending'
     and coalesce(new.refund_amount, 0) > 0
     and greatest(0, new.amount - coalesce(new.refund_amount, 0) - coalesce(new.gateway_fee_deducted, 0)) = 0 then
    new.settlement_status := 'n/a';
  end if;
  return new;
end $f$;

drop trigger if exists trg_settlement_na on public.payments;
create trigger trg_settlement_na before insert or update on public.payments
  for each row execute function public.set_settlement_na();

-- 2. The existing rows: exactly these four (checked below; the migration stops if the count is not 4).
--    PAXO-000072, PAXO-000074, PAXO-000075  (Razorpay test payments, refunded in full)
--    PAXO-000735                            (Cashfree sandbox payment, refunded less the Rs 280.14 gateway fee)
--    NOT included: PAXO-000738 (Cashfree production, Rs 10). It was already marked "settled" on 10 Nov 2026 07:25 UTC by
--    paxoapp.in@gmail.com from the Settlements screen, with Rs 0 to transfer. It is left exactly as it is unless you decide otherwise.
do $m$
declare n int;
begin
  update public.payments p
     set settlement_status = 'n/a'
    from public.bookings b
   where b.id = p.booking_id
     and b.booking_ref in ('PAXO-000072', 'PAXO-000074', 'PAXO-000075', 'PAXO-000735')
     and p.status = 'paid'
     and p.settlement_status = 'pending'
     and coalesce(p.refund_amount, 0) > 0
     and greatest(0, p.amount - coalesce(p.refund_amount, 0) - coalesce(p.gateway_fee_deducted, 0)) = 0;
  get diagnostics n = row_count;
  if n <> 4 then raise exception 'expected to update exactly 4 payments, updated %', n; end if;
end $m$;

-- Party Pool: a guest can cancel their whole booking up to 48 hours before the party starts. 100% of what they paid is
-- queued as a refund (PAXO bears the gateway fee). Cancelling is final: the same guest cannot join this party again
-- (party_start_payment already blocks any booking that is not 'active'). A confirmed party stays confirmed.
-- Admin sees the refund in the existing "Refunds due" list with reason "guest_cancelled".

-- 1. new refund reason
alter table public.party_payments drop constraint party_payments_refund_reason_check;
alter table public.party_payments add constraint party_payments_refund_reason_check
  check (refund_reason = any (array['party_cancelled','minimum_not_reached','late_payment','guest_cancelled']));

-- 2. the cancel function (the only way a guest cancels)
create or replace function public.party_cancel_my_booking(p_party_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p record; b record; v_refund numeric; v_seats int;
begin
  if v_uid is null then raise exception 'Please sign in to continue.'; end if;
  select * into p from public.parties where id = p_party_id for update;
  if not found or p.status not in ('published', 'confirmed') then
    raise exception 'This booking can no longer be cancelled.';
  end if;
  select * into b from public.party_bookings where party_id = p.id and customer_id = v_uid for update;
  if not found then raise exception 'You have no booking in this party.'; end if;
  if b.status <> 'active' then raise exception 'This booking can no longer be cancelled.'; end if;
  if now() > p.starts_at - interval '48 hours' then
    raise exception 'Bookings can be cancelled until 48 hours before the party. That time has passed.';
  end if;

  select count(*)::int into v_seats from public.party_seats where booking_id = b.id and status = 'paid';

  -- everything paid comes back in full
  update public.party_payments
     set refund_status = 'due', refund_amount = amount, refund_reason = 'guest_cancelled', refund_queued_at = now()
   where booking_id = b.id and status = 'paid' and refund_status = 'none';
  select coalesce(sum(refund_amount), 0) into v_refund from public.party_payments
   where booking_id = b.id and refund_status = 'due' and refund_reason = 'guest_cancelled';

  -- a payment still open is closed; a payment that lands afterwards is refunded by the late-payment rule
  update public.party_payments set status = 'failed' where booking_id = b.id and status = 'created';
  update public.party_seats set status = 'cancelled' where booking_id = b.id and status in ('held', 'paid');
  update public.party_bookings set status = 'cancelled', updated_at = now() where id = b.id;

  return jsonb_build_object('cancelled', true, 'seats', v_seats, 'refund_amount', v_refund);
end $$;
revoke all on function public.party_cancel_my_booking(uuid) from public, anon;
grant execute on function public.party_cancel_my_booking(uuid) to authenticated;

-- 3. party_my_booking also says whether the guest can still cancel, and until when
create or replace function public.party_my_booking(p_party_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b record; p record; v_rem numeric; r jsonb;
begin
  if auth.uid() is null then return null; end if;
  select * into b from public.party_bookings where party_id = p_party_id and customer_id = auth.uid();
  if not found then return null; end if;
  select * into p from public.parties where id = p_party_id;
  v_rem := case when b.status = 'active' and p.status = 'confirmed' then public.party_booking_remaining(b.id) else 0 end;
  select jsonb_build_object(
    'booking_id', b.id, 'status', b.status,
    'male_paid',   count(*) filter (where s.status = 'paid' and s.gender = 'male'),
    'female_paid', count(*) filter (where s.status = 'paid' and s.gender = 'female'),
    'seats_paid',  count(*) filter (where s.status = 'paid')) into r
  from public.party_seats s where s.booking_id = b.id;
  return r || jsonb_build_object(
    'paid_amount', coalesce((select sum(x.amount) from public.party_payments x where x.booking_id = b.id and x.status = 'paid' and x.refund_status = 'none'), 0),
    'balance_due', v_rem,
    'balance_due_by', b.balance_due_by,
    'can_pay_balance', v_rem > 0 and (b.balance_due_by is null or now() <= b.balance_due_by),
    'refund_due', coalesce((select sum(x.refund_amount) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'due'), 0),
    'refunded', coalesce((select sum(x.refund_amount) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'refunded'), 0),
    'refunded_on', (select max(x.refunded_on) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'refunded'),
    'can_cancel', b.status = 'active' and p.status in ('published', 'confirmed') and now() <= p.starts_at - interval '48 hours',
    'cancel_until', p.starts_at - interval '48 hours');
end $$;

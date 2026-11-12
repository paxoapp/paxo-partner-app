-- PARTY POOL, PHASE 2: join, seats, payment, balance, forfeiture, refunds, automatic jobs.
-- Additive only. Nothing here touches bookings, payments, commissions, coupons or the booking refund logic.
-- New tables: party_bookings, party_payments, party_acceptances. Extended (additive columns): party_seats, party_venue_settlement.
-- Replaced: party_public() (same columns; seats-left now also subtracts live 10-minute holds).
-- Customers get NO direct table access. They use party_start_payment / party_my_booking / party_my_bookings only.
-- Money rules live in the database. The edge function party-payment (shown separately) only talks to Razorpay.

-- 1. Tables ---------------------------------------------------------------------------------------------------------
create table public.party_bookings (
  id                  uuid primary key default gen_random_uuid(),
  party_id            uuid not null references public.parties(id) on delete restrict,
  customer_id         uuid not null references auth.users(id) on delete restrict,
  status              text not null default 'active' check (status in ('active','forfeited','cancelled')),
  balance_due_by      timestamptz,                -- set when the party is confirmed (or when a late deposit lands)
  confirmed_notice_at timestamptz,
  balance_reminder_at timestamptz,
  forfeited_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (party_id, customer_id)                  -- one booking per customer per party; a forfeited row blocks joining again
);
create index party_bookings_party_idx on public.party_bookings (party_id, status);

create table public.party_payments (
  id                     uuid primary key default gen_random_uuid(),
  party_id               uuid not null references public.parties(id) on delete restrict,
  booking_id             uuid not null references public.party_bookings(id) on delete restrict,
  customer_id            uuid not null references auth.users(id) on delete restrict,
  kind                   text not null check (kind in ('deposit','full','balance')),
  seats_count            integer not null default 0 check (seats_count >= 0),
  amount                 numeric(10,2) not null check (amount > 0),
  status                 text not null default 'created' check (status in ('created','paid','failed','expired')),
  held_until             timestamptz,
  razorpay_order_id      text unique,
  razorpay_payment_id    text,
  paid_at                timestamptz,
  gateway_fee            numeric(10,2),
  gateway_tax            numeric(10,2),
  gateway_fee_estimated  boolean,
  refund_status          text not null default 'none' check (refund_status in ('none','due','refunded')),
  refund_amount          numeric(10,2),
  refund_reason          text check (refund_reason in ('party_cancelled','minimum_not_reached','late_payment')),
  refund_queued_at       timestamptz,
  refunded_on            date,                    -- the date the admin sent the money back
  refund_note            text check (char_length(refund_note) <= 1000),
  refund_marked_by       uuid references auth.users(id) on delete set null,
  refund_marked_at       timestamptz,
  created_at             timestamptz not null default now()
);
create unique index party_payments_one_open_idx on public.party_payments (booking_id) where status = 'created';
create index party_payments_party_idx on public.party_payments (party_id, status, refund_status);
create index party_payments_customer_idx on public.party_payments (customer_id);

create table public.party_acceptances (
  id            uuid primary key default gen_random_uuid(),
  party_id      uuid not null references public.parties(id) on delete restrict,
  booking_id    uuid not null references public.party_bookings(id) on delete restrict,
  payment_id    uuid references public.party_payments(id) on delete set null,
  customer_id   uuid not null references auth.users(id) on delete restrict,
  terms_version integer not null,
  accepted_at   timestamptz not null default now()
);
create index party_acceptances_booking_idx on public.party_acceptances (booking_id);

-- seats now know their booking and the payment that holds / paid for them
alter table public.party_seats
  add column booking_id uuid references public.party_bookings(id) on delete restrict,
  add column payment_id uuid references public.party_payments(id) on delete set null,
  add column held_until timestamptz,
  add column paid_at    timestamptz;
create index party_seats_booking_idx on public.party_seats (booking_id, status);
create index party_seats_payment_idx on public.party_seats (payment_id);

-- admin-only settlement record (the table is already admin-only): "party settled with the venue"
alter table public.party_venue_settlement
  add column settled_on date,
  add column settled_note text check (char_length(settled_note) <= 2000),
  add column settled_by uuid references auth.users(id) on delete set null;

-- 2. Access: admins read the tables; customers read nothing directly --------------------------------------------------
alter table public.party_bookings    enable row level security;
alter table public.party_payments    enable row level security;
alter table public.party_acceptances enable row level security;
revoke all on public.party_bookings, public.party_payments, public.party_acceptances from anon, authenticated;
grant select on public.party_bookings, public.party_payments, public.party_acceptances to authenticated;
create policy party_bookings_admin_select on public.party_bookings for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_payments_admin_select on public.party_payments for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_acceptances_admin_select on public.party_acceptances for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));

-- 3. Small helpers (internal, not callable by apps) --------------------------------------------------------------------
-- deadline for the balance: the earlier of (confirmed + 48h) and (start - 3 days), but never less than 12 hours after
-- confirmation, so a party confirmed late can never forfeit everybody at once.
create function public.party_balance_deadline(p_confirmed timestamptz, p_start timestamptz) returns timestamptz
language sql immutable set search_path = public as $$
  select greatest(least(p_confirmed + interval '48 hours', p_start - interval '3 days'), p_confirmed + interval '12 hours')
$$;

-- seats of one gender that are paid or on a live 10-minute hold
create function public.party_seats_taken(p_party_id uuid, p_gender text) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.party_seats s
   where s.party_id = p_party_id and s.gender = p_gender
     and (s.status = 'paid' or (s.status = 'held' and s.held_until > now()))
$$;

-- what one booking still owes: paid seats x price, minus what it paid (payments queued for refund do not count)
create function public.party_booking_remaining(p_booking_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(
    (select count(*) from public.party_seats s where s.booking_id = b.id and s.status = 'paid') * p.price_per_person
    - coalesce((select sum(x.amount) from public.party_payments x
                 where x.booking_id = b.id and x.status = 'paid' and x.refund_status = 'none'), 0), 0)
  from public.party_bookings b join public.parties p on p.id = b.party_id where b.id = p_booking_id
$$;

-- emails go through the existing send-transactional-email function (same path as the booking emails).
-- An email problem can never break a payment: every failure is swallowed.
create function public.party_email(p_customer uuid, p_type text, p_data jsonb, p_key text) returns void
language plpgsql security definer set search_path = public, net as $$
declare v_email text; v_secret text;
begin
  select email into v_email from public.profiles where id = p_customer;
  if v_email is null or v_email ilike 'paxoapp.in+%@gmail.com' then return; end if;   -- same skip as the welcome email
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'webhook_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://cjjksssylejwxwbalury.supabase.co/functions/v1/send-transactional-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    body := jsonb_build_object('type', p_type, 'to', v_email, 'data', p_data, 'idempotency_key', p_key));
exception when others then null;
end $$;

create function public.party_ist(p_ts timestamptz) returns text language sql immutable set search_path = public as $$
  select to_char(p_ts at time zone 'Asia/Kolkata', 'FMDy DD Mon, FMHH12:MI AM') || ' IST'
$$;

-- 4. THE one function that creates every party payment (join, top-up, balance) -----------------------------------------
-- Runs as the signed-in customer (auth.uid()). It checks every rule, holds the seats for 10 minutes, stores the terms
-- acceptance and writes the payment row. The edge function then only asks Razorpay for an order for that row.
--   p_kind 'join'    -> new seats (a first join, or a top-up when the customer already has seats). 30% before the party
--                       is confirmed, 100% after.
--   p_kind 'balance' -> the remaining amount on the seats already paid.
create function public.party_start_payment(
  p_party_id uuid, p_kind text, p_genders text[] default null, p_accept boolean default false, p_terms_version integer default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p record; b record; o record;
  v_n int; v_m int; v_f int; v_existing int; v_kind text; v_amount numeric; v_pay uuid;
  v_hold timestamptz := now() + interval '10 minutes'; g text;
begin
  if v_uid is null then raise exception 'Please sign in to continue.'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and account_state = 'active') then
    raise exception 'This account cannot join parties.';
  end if;
  if p_kind not in ('join', 'balance') then raise exception 'Unknown payment type.'; end if;

  select * into p from public.parties where id = p_party_id for update;      -- one buyer at a time per party
  if not found or p.status not in ('published', 'confirmed') then raise exception 'This party is not open.'; end if;

  select * into b from public.party_bookings where party_id = p.id and customer_id = v_uid for update;
  if b.id is not null and b.status <> 'active' then
    raise exception 'You can no longer join this party.';
  end if;

  if p_kind = 'join' then
    if now() >= p.closes_at then raise exception 'Joining has closed for this party.'; end if;
    if not coalesce(p_accept, false) then raise exception 'Please accept the terms to continue.'; end if;
    if p_terms_version is distinct from p.terms_version then
      raise exception 'The terms have changed. Please read and accept them again.';
    end if;
    v_n := coalesce(array_length(p_genders, 1), 0);
    if v_n < 1 then raise exception 'Choose at least one seat.'; end if;
    foreach g in array p_genders loop
      if g is null or g not in ('male', 'female') then raise exception 'Choose male or female for every person.'; end if;
      if g = 'male' then v_m := coalesce(v_m, 0) + 1; else v_f := coalesce(v_f, 0) + 1; end if;
    end loop;
    v_m := coalesce(v_m, 0); v_f := coalesce(v_f, 0);
    if v_n > p.max_seats_per_booking then
      raise exception 'You can book up to % seats in one booking.', p.max_seats_per_booking;
    end if;

    if b.id is null then
      insert into public.party_bookings (party_id, customer_id) values (p.id, v_uid) returning * into b;
    end if;
    -- a new attempt replaces this customer's earlier unpaid one, and gives its seats back
    for o in select id from public.party_payments where booking_id = b.id and status = 'created' loop
      update public.party_payments set status = 'failed' where id = o.id;
      update public.party_seats set status = 'cancelled' where payment_id = o.id and status = 'held';
    end loop;

    select count(*)::int into v_existing from public.party_seats s
     where s.booking_id = b.id and s.status = 'paid';
    if v_existing + v_n > p.max_seats_per_booking then
      raise exception 'You can hold up to % seats in total for this party. You already have %.', p.max_seats_per_booking, v_existing;
    end if;
    if v_m > p.male_seats - public.party_seats_taken(p.id, 'male') then
      raise exception 'Not enough male seats are left.';
    end if;
    if v_f > p.female_seats - public.party_seats_taken(p.id, 'female') then
      raise exception 'Not enough female seats are left.';
    end if;

    v_kind := case when p.status = 'confirmed' then 'full' else 'deposit' end;
    v_amount := round(v_n * p.price_per_person * case when v_kind = 'full' then 1 else 0.30 end, 2);
    insert into public.party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, held_until)
    values (p.id, b.id, v_uid, v_kind, v_n, v_amount, v_hold) returning id into v_pay;
    foreach g in array p_genders loop
      insert into public.party_seats (party_id, customer_id, gender, status, booking_id, payment_id, held_until)
      values (p.id, v_uid, g, 'held', b.id, v_pay, v_hold);
    end loop;
    insert into public.party_acceptances (party_id, booking_id, payment_id, customer_id, terms_version)
    values (p.id, b.id, v_pay, v_uid, p.terms_version);
    return jsonb_build_object('payment_id', v_pay, 'kind', v_kind, 'amount', v_amount, 'seats', v_n, 'held_until', v_hold);
  end if;

  -- balance
  if p.status <> 'confirmed' then raise exception 'The balance can be paid once the party is confirmed.'; end if;
  if b.id is null then raise exception 'You have no seats in this party.'; end if;
  v_amount := public.party_booking_remaining(b.id);
  if v_amount <= 0 then raise exception 'Nothing is left to pay.'; end if;
  if b.balance_due_by is not null and now() > b.balance_due_by then
    raise exception 'The balance deadline has passed.';
  end if;
  for o in select id from public.party_payments where booking_id = b.id and status = 'created' loop
    update public.party_payments set status = 'failed' where id = o.id;
    update public.party_seats set status = 'cancelled' where payment_id = o.id and status = 'held';
  end loop;
  insert into public.party_payments (party_id, booking_id, customer_id, kind, seats_count, amount)
  values (p.id, b.id, v_uid, 'balance', 0, v_amount) returning id into v_pay;
  return jsonb_build_object('payment_id', v_pay, 'kind', 'balance', 'amount', v_amount, 'seats', 0, 'held_until', null);
end $$;
revoke all on function public.party_start_payment(uuid, text, text[], boolean, integer) from public, anon, authenticated;
grant execute on function public.party_start_payment(uuid, text, text[], boolean, integer) to authenticated;

-- 5. Edge-function helpers (service role only) ---------------------------------------------------------------------------
-- the edge function reads its own row (amount + owner) and stores the Razorpay order id
create function public.party_payment_for_order(p_payment_id uuid)
returns table (id uuid, customer_id uuid, amount numeric, status text, razorpay_order_id text, kind text)
language sql stable security definer set search_path = public as $$
  select x.id, x.customer_id, x.amount, x.status, x.razorpay_order_id, x.kind from public.party_payments x where x.id = p_payment_id
$$;
create function public.party_payment_by_order(p_order_id text)
returns table (id uuid, customer_id uuid, amount numeric, status text)
language sql stable security definer set search_path = public as $$
  select x.id, x.customer_id, x.amount, x.status from public.party_payments x where x.razorpay_order_id = p_order_id
$$;
create function public.party_attach_order(p_payment_id uuid, p_order_id text) returns void
language sql security definer set search_path = public as $$
  update public.party_payments set razorpay_order_id = p_order_id
   where id = p_payment_id and status = 'created' and razorpay_order_id is null
$$;
-- order creation failed or payment failed: give the seats back
create function public.party_release_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.party_payments set status = 'failed' where id = p_payment_id and status = 'created';
  update public.party_seats set status = 'cancelled' where payment_id = p_payment_id and status = 'held';
end $$;
create function public.party_fail_payment(p_order_id text) returns text
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.party_payments where razorpay_order_id = p_order_id for update;
  if not found then return 'unknown order'; end if;
  if pay.status = 'paid' then return 'ignored: already paid'; end if;
  perform public.party_release_payment(pay.id);
  return 'payment marked failed';
end $$;

-- 6. Money in: mark a payment paid, take the seats, confirm the party -------------------------------------------------------
-- Called only by the edge functions (service role). It is idempotent. The amount Razorpay reports must equal the amount
-- PAXO asked for. If the payment can no longer be honoured (party cancelled or closed, seats gone, forfeited), the
-- money is still recorded as received and a 100% refund is queued instead of silently keeping it.
create function public.party_confirm_payment(
  p_order_id text, p_razorpay_payment_id text, p_amount_paise bigint,
  p_fee numeric default null, p_tax numeric default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pay record; p record; pb record;
  v_ok boolean := true; v_cap int; v_need int; v_has_fee boolean; v_paid int; v_confirmed boolean := false; v_deadline timestamptz;
  g text; r record;
begin
  select * into pay from public.party_payments where razorpay_order_id = p_order_id for update;
  if not found then return jsonb_build_object('result', 'unknown order'); end if;
  if pay.status = 'paid' then return jsonb_build_object('result', 'already paid'); end if;
  if p_amount_paise is distinct from round(pay.amount * 100)::bigint then
    insert into public.admin_alerts (kind, message, urgent)
    values ('party_payment_amount_mismatch',
            format('Razorpay reported %s paise for a party payment PAXO expected to be %s paise. It was NOT marked paid. Please check it in Razorpay.', p_amount_paise, round(pay.amount * 100)::bigint), true);
    return jsonb_build_object('result', 'amount mismatch');
  end if;

  select * into p from public.parties where id = pay.party_id for update;
  select * into pb from public.party_bookings where id = pay.booking_id for update;
  v_has_fee := coalesce(p_fee, 0) > 0;

  if pb.status <> 'active' then
    v_ok := false;
  elsif pay.kind = 'balance' then
    v_ok := p.status = 'confirmed';
  else
    v_ok := p.status in ('published', 'confirmed');
    if v_ok then
      -- seats that were already given back (10 minutes passed) are taken again only if they are still free
      foreach g in array array['male', 'female'] loop
        select count(*)::int into v_need from public.party_seats where payment_id = pay.id and gender = g and status = 'cancelled';
        v_cap := case when g = 'male' then p.male_seats else p.female_seats end;
        if v_need > 0 and public.party_seats_taken(p.id, g) + v_need > v_cap then v_ok := false; end if;
      end loop;
      if v_ok and (select count(*) from public.party_seats where booking_id = pb.id and status = 'paid')
                  + pay.seats_count > p.max_seats_per_booking then v_ok := false; end if;
    end if;
  end if;

  if not v_ok then
    update public.party_payments
       set status = 'paid', razorpay_payment_id = p_razorpay_payment_id, paid_at = now(),
           gateway_fee = p_fee, gateway_tax = p_tax, gateway_fee_estimated = not v_has_fee,
           refund_status = 'due', refund_amount = amount, refund_reason = 'late_payment', refund_queued_at = now()
     where id = pay.id;
    update public.party_seats set status = 'cancelled' where payment_id = pay.id and status in ('held', 'cancelled');
    insert into public.admin_alerts (kind, message, urgent)
    values ('party_late_payment', format('A party payment of ₹%s arrived after it could no longer be used (party %s). A 100%% refund is queued under Refunds due.', pay.amount, p.title), false);
    return jsonb_build_object('result', 'late payment: refund queued');
  end if;

  update public.party_payments
     set status = 'paid', razorpay_payment_id = p_razorpay_payment_id, paid_at = now(),
         gateway_fee = coalesce(p_fee, round(amount * 0.02 * 1.18, 2)),
         gateway_tax = coalesce(p_tax, round(amount * 0.02 * 0.18, 2)),
         gateway_fee_estimated = not v_has_fee
   where id = pay.id;

  if pay.kind <> 'balance' then
    update public.party_seats set status = 'paid', paid_at = now(), held_until = null
     where payment_id = pay.id and status in ('held', 'cancelled');
    -- a 30% deposit that lands after the party was already confirmed still owes the balance
    if p.status = 'confirmed' and pay.kind = 'deposit' then
      update public.party_bookings
         set balance_due_by = greatest(public.party_balance_deadline(p.confirmed_at, p.starts_at), now() + interval '12 hours'),
             updated_at = now()
       where id = pb.id and balance_due_by is null;
    end if;
    -- enough paid seats: the party is confirmed (only this owner-run function may do that)
    if p.status = 'published' then
      select count(*)::int into v_paid from public.party_seats where party_id = p.id and status = 'paid';
      if v_paid >= p.min_paid_seats then
        update public.parties set status = 'confirmed' where id = p.id;         -- the guard stamps confirmed_at
        v_confirmed := true;
        select * into p from public.parties where id = p.id;
        v_deadline := public.party_balance_deadline(p.confirmed_at, p.starts_at);
        for r in select b.id as booking_id, b.customer_id from public.party_bookings b
                  where b.party_id = p.id and b.status = 'active' and public.party_booking_remaining(b.id) > 0 loop
          update public.party_bookings set balance_due_by = v_deadline, confirmed_notice_at = now(), updated_at = now() where id = r.booking_id;
          perform public.party_email(r.customer_id, 'party_confirmed',
            jsonb_build_object('party_title', p.title, 'party_date', p.party_date,
                               'balance_amount', public.party_booking_remaining(r.booking_id), 'deadline', public.party_ist(v_deadline)),
            'party-confirmed-' || r.booking_id);
        end loop;
      end if;
    end if;
  end if;
  return jsonb_build_object('result', 'paid', 'party_confirmed', v_confirmed);
end $$;

-- Razorpay webhook entry: handles an event only if its order belongs to a party payment. Anything else is left
-- completely alone (handled=false) for the existing booking webhook logic.
create function public.party_apply_event(p_event_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev record; ent jsonb; v_order text; v_res jsonb; v_result text; v_fee numeric; v_tax numeric;
begin
  select * into ev from public.razorpay_events where event_id = p_event_id for update;
  if not found then return jsonb_build_object('handled', false); end if;
  ent := ev.payload #> '{payload,payment,entity}';
  v_order := coalesce(ent->>'order_id', ev.payload #>> '{payload,order,entity,id}');
  if v_order is null or not exists (select 1 from public.party_payments where razorpay_order_id = v_order) then
    return jsonb_build_object('handled', false);
  end if;
  if ev.processed_at is not null then return jsonb_build_object('handled', true, 'result', ev.result); end if;

  if ev.event_type in ('payment.captured', 'order.paid') then
    v_fee := case when (ent->>'fee') ~ '^[0-9]+$' and (ent->>'fee')::numeric > 0 then (ent->>'fee')::numeric / 100 end;
    v_tax := case when v_fee is not null then coalesce(nullif(ent->>'tax', '')::numeric, 0) / 100 end;
    v_res := public.party_confirm_payment(v_order, ent->>'id', (ent->>'amount')::bigint, v_fee, v_tax);
    v_result := 'party: ' || (v_res->>'result');
  elsif ev.event_type = 'payment.failed' then
    v_result := 'party: ' || public.party_fail_payment(v_order);
  else
    v_result := 'party: ignored ' || ev.event_type;
  end if;
  update public.razorpay_events set processed_at = now(), result = v_result where event_id = p_event_id;
  return jsonb_build_object('handled', true, 'result', v_result);
end $$;

-- 7. Refunds -----------------------------------------------------------------------------------------------------------
-- Queue a 100% refund of everything each customer paid for this party. PAXO bears the gateway fee. Runs when a party
-- becomes cancelled (admin Cancel, or the minimum was not reached) through the trigger below.
create function public.party_queue_refunds(p_party_id uuid, p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; r record; p record;
begin
  select * into p from public.parties where id = p_party_id;
  update public.party_payments
     set refund_status = 'due', refund_amount = amount, refund_reason = p_reason, refund_queued_at = now()
   where party_id = p_party_id and status = 'paid' and refund_status = 'none';
  get diagnostics n = row_count;
  update public.party_payments set status = 'failed' where party_id = p_party_id and status = 'created';
  update public.party_seats set status = 'cancelled' where party_id = p_party_id and status = 'held';
  update public.party_bookings set status = 'cancelled', updated_at = now() where party_id = p_party_id and status in ('active', 'forfeited');
  for r in select customer_id, sum(refund_amount) as amt from public.party_payments
            where party_id = p_party_id and refund_status = 'due' group by customer_id loop
    perform public.party_email(r.customer_id, 'party_cancelled',
      jsonb_build_object('party_title', p.title, 'party_date', p.party_date, 'refund_amount', r.amt,
                         'reason', case when p_reason = 'minimum_not_reached' then 'minimum' else 'cancelled' end),
      'party-cancelled-' || p_party_id || '-' || r.customer_id);
  end loop;
  return n;
end $$;

create function public.party_on_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform public.party_queue_refunds(new.id,
      case when coalesce(new.cancel_reason, '') ilike 'Minimum number of seats%' then 'minimum_not_reached' else 'party_cancelled' end);
  end if;
  return null;
end $$;
create trigger trg_party_on_cancel after update of status on public.parties
  for each row execute function public.party_on_cancel();

-- admin marks a refund as sent (date + note)
create function public.party_mark_refunded(p_payment_id uuid, p_date date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare pay record; p record;
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  if p_date is null then raise exception 'Enter the date the refund was sent.'; end if;
  if p_date > (now() at time zone 'Asia/Kolkata')::date then raise exception 'The refund date cannot be in the future.'; end if;
  select * into pay from public.party_payments where id = p_payment_id for update;
  if not found or pay.refund_status <> 'due' then raise exception 'This refund is not waiting to be sent.'; end if;
  update public.party_payments
     set refund_status = 'refunded', refunded_on = p_date, refund_note = nullif(btrim(coalesce(p_note, '')), ''),
         refund_marked_by = auth.uid(), refund_marked_at = now()
   where id = pay.id;
  select * into p from public.parties where id = pay.party_id;
  perform public.party_email(pay.customer_id, 'party_refund_sent',
    jsonb_build_object('party_title', p.title, 'refund_amount', pay.refund_amount, 'refunded_on', p_date),
    'party-refund-' || pay.id);
end $$;

-- 8. Scheduled work ----------------------------------------------------------------------------------------------------
create function public.party_run_jobs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record; v_released int := 0; v_cancelled int := 0; v_forfeited int := 0; v_completed int := 0; v_reminded int := 0; n int;
begin
  -- 1. unpaid 10-minute holds give their seats back
  update public.party_payments set status = 'expired' where status = 'created' and kind <> 'balance' and held_until < now();
  update public.party_seats set status = 'cancelled' where status = 'held' and held_until < now();
  get diagnostics v_released = row_count;

  -- 2. closing time passed and not enough seats paid: cancel + 100% refunds (the trigger queues them).
  --    A payment still inside its 10-minute hold is given the chance to finish first.
  for r in select p.id from public.parties p
            where p.status in ('published', 'closed') and p.closes_at <= now()
              and (select count(*) from public.party_seats s where s.party_id = p.id and s.status = 'paid') < p.min_paid_seats
              and not exists (select 1 from public.party_seats s where s.party_id = p.id and s.status = 'held' and s.held_until > now()) loop
    update public.parties set status = 'cancelled', cancel_reason = 'Minimum number of seats not reached.' where id = r.id;
    v_cancelled := v_cancelled + 1;
  end loop;

  -- 3. balance deadline passed: keep the deposit, free the seats, block the customer from this party
  for r in select b.id, b.customer_id, b.party_id from public.party_bookings b join public.parties p on p.id = b.party_id
            where p.status = 'confirmed' and b.status = 'active' and b.balance_due_by < now()
              and public.party_booking_remaining(b.id) > 0 loop
    update public.party_bookings set status = 'forfeited', forfeited_at = now(), updated_at = now() where id = r.id;
    update public.party_seats set status = 'forfeited' where booking_id = r.id and status in ('paid', 'held');
    update public.party_payments set status = 'failed' where booking_id = r.id and status = 'created';
    perform public.party_email(r.customer_id, 'party_forfeited',
      jsonb_build_object('party_title', (select title from public.parties where id = r.party_id)),
      'party-forfeit-' || r.id);
    v_forfeited := v_forfeited + 1;
  end loop;

  -- 4. balance reminders: once, when 24 hours or less are left
  for r in select b.id, b.customer_id, b.balance_due_by, p.title from public.party_bookings b join public.parties p on p.id = b.party_id
            where p.status = 'confirmed' and b.status = 'active' and b.balance_reminder_at is null
              and b.balance_due_by between now() and now() + interval '24 hours'
              and (b.confirmed_notice_at is null or b.confirmed_notice_at < now() - interval '6 hours')
              and public.party_booking_remaining(b.id) > 0 loop
    update public.party_bookings set balance_reminder_at = now() where id = r.id;
    perform public.party_email(r.customer_id, 'party_balance_reminder',
      jsonb_build_object('party_title', r.title, 'balance_amount', public.party_booking_remaining(r.id), 'deadline', public.party_ist(r.balance_due_by)),
      'party-reminder-' || r.id);
    v_reminded := v_reminded + 1;
  end loop;

  -- 5. party over
  update public.parties set status = 'completed' where status in ('confirmed', 'closed') and ends_at <= now();
  get diagnostics v_completed = row_count;

  return jsonb_build_object('holds_released', v_released, 'cancelled', v_cancelled, 'forfeited', v_forfeited,
                            'reminded', v_reminded, 'completed', v_completed);
end $$;

-- 9. What customers may see: their own booking only -----------------------------------------------------------------------
create function public.party_my_booking(p_party_id uuid) returns jsonb
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
    'refunded_on', (select max(x.refunded_on) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'refunded'));
end $$;
revoke all on function public.party_my_booking(uuid) from public, anon, authenticated;
grant execute on function public.party_my_booking(uuid) to authenticated;

create function public.party_my_bookings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'party_id', p.id, 'title', p.title, 'venue_name', v.name, 'party_date', p.party_date, 'start_time', p.start_time,
           'party_status', p.status, 'booking', public.party_my_booking(p.id)) order by p.starts_at desc), '[]'::jsonb)
  from public.party_bookings b
  join public.parties p on p.id = b.party_id
  join public.venues v on v.id = p.venue_id
  where b.customer_id = auth.uid()
$$;
revoke all on function public.party_my_bookings() from public, anon, authenticated;
grant execute on function public.party_my_bookings() to authenticated;

-- 10. Admin views of the money -------------------------------------------------------------------------------------------
create function public.party_admin_summary(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  select jsonb_build_object(
    'paid_seats',      count(*) filter (where s.status = 'paid'),
    'paid_male',       count(*) filter (where s.status = 'paid' and s.gender = 'male'),
    'paid_female',     count(*) filter (where s.status = 'paid' and s.gender = 'female'),
    'held_seats',      count(*) filter (where s.status = 'held' and s.held_until > now()),
    'forfeited_seats', count(*) filter (where s.status = 'forfeited')) into r
  from public.party_seats s where s.party_id = p_party_id;
  return r || (
    select jsonb_build_object(
      'deposits_collected', coalesce(sum(x.amount) filter (where x.kind = 'deposit'), 0),
      'full_collected',     coalesce(sum(x.amount) filter (where x.kind = 'full'), 0),
      'balances_collected', coalesce(sum(x.amount) filter (where x.kind = 'balance'), 0),
      'total_collected',    coalesce(sum(x.amount), 0),
      'refunds_due',        coalesce(sum(x.refund_amount) filter (where x.refund_status = 'due'), 0),
      'refunds_due_count',  count(*) filter (where x.refund_status = 'due'),
      'refunded',           coalesce(sum(x.refund_amount) filter (where x.refund_status = 'refunded'), 0),
      'forfeited_amount',   coalesce(sum(x.amount) filter (where x.refund_status = 'none' and b.status = 'forfeited'), 0))
    from public.party_payments x join public.party_bookings b on b.id = x.booking_id
    where x.party_id = p_party_id and x.status = 'paid')
  || jsonb_build_object(
    'balances_due', coalesce((select sum(public.party_booking_remaining(b.id)) from public.party_bookings b
                              join public.parties p on p.id = b.party_id
                              where b.party_id = p_party_id and b.status = 'active' and p.status = 'confirmed'), 0),
    'settled_on', (select settled_on from public.party_venue_settlement where party_id = p_party_id),
    'settled_note', (select settled_note from public.party_venue_settlement where party_id = p_party_id));
end $$;

create function public.party_admin_bookings(p_party_id uuid)
returns table (booking_id uuid, customer_id uuid, customer_name text, phone text, email text, status text,
               male integer, female integer, paid_amount numeric, balance_due numeric, balance_due_by timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  return query
  select b.id, b.customer_id, pr.full_name, pr.phone, pr.email, b.status,
         (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status in ('paid','forfeited') and s.gender = 'male'),
         (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status in ('paid','forfeited') and s.gender = 'female'),
         coalesce((select sum(x.amount) from public.party_payments x where x.booking_id = b.id and x.status = 'paid'), 0),
         case when b.status = 'active' then public.party_booking_remaining(b.id) else 0 end,
         b.balance_due_by
  from public.party_bookings b left join public.profiles pr on pr.id = b.customer_id
  where b.party_id = p_party_id
    and exists (select 1 from public.party_payments x where x.booking_id = b.id and x.status = 'paid')
  order by b.created_at;
end $$;

create function public.party_admin_refunds(p_party_id uuid)
returns table (payment_id uuid, customer_name text, phone text, email text, kind text, paid_amount numeric,
               refund_amount numeric, reason text, refund_status text, queued_at timestamptz, refunded_on date, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  return query
  select x.id, pr.full_name, pr.phone, pr.email, x.kind, x.amount, x.refund_amount, x.refund_reason, x.refund_status,
         x.refund_queued_at, x.refunded_on, x.refund_note
  from public.party_payments x left join public.profiles pr on pr.id = x.customer_id
  where x.party_id = p_party_id and x.refund_status <> 'none'
  order by x.refund_status, x.refund_queued_at;
end $$;

create function public.party_mark_settled(p_party_id uuid, p_date date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  select * into p from public.parties where id = p_party_id;
  if not found or p.status not in ('confirmed', 'completed') then
    raise exception 'Only a confirmed or completed party can be marked as settled.';
  end if;
  if p_date is null then raise exception 'Enter the settlement date.'; end if;
  insert into public.party_venue_settlement (party_id, settled_on, settled_note, settled_by)
  values (p_party_id, p_date, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (party_id) do update
    set settled_on = excluded.settled_on, settled_note = excluded.settled_note, settled_by = excluded.settled_by;
end $$;

-- 11. party_public: seats left now also subtract live 10-minute holds (counts of PAID seats are unchanged) -----------------
create or replace function public.party_public(p_party_id uuid default null)
returns table (
  id uuid, title text, description text, venue_id uuid, venue_name text, venue_area text, venue_city text,
  party_date date, start_time time, end_time time, starts_at timestamptz, ends_at timestamptz, closes_at timestamptz,
  package_type text, liquor_type text, price_per_person numeric, cover_photo_url text,
  terms_text text, terms_version integer, max_seats_per_booking integer,
  status text, joining_open boolean, min_paid_seats integer, male_seats integer, female_seats integer,
  paid_total integer, paid_male integer, paid_female integer, male_left integer, female_left integer
)
language sql stable security definer set search_path = public as $$
  with seats as (
    select s.party_id,
           count(*) filter (where s.status = 'paid' and s.gender = 'male')::int   as m,
           count(*) filter (where s.status = 'paid' and s.gender = 'female')::int as f,
           count(*) filter (where s.status = 'held' and s.held_until > now() and s.gender = 'male')::int   as hm,
           count(*) filter (where s.status = 'held' and s.held_until > now() and s.gender = 'female')::int as hf
    from public.party_seats s where s.status in ('paid', 'held') group by s.party_id
  ), x as (
    select p.*, v.name as v_name, v.area as v_area, v.city as v_city,
           coalesce(seats.m, 0) as m, coalesce(seats.f, 0) as f, coalesce(seats.hm, 0) as hm, coalesce(seats.hf, 0) as hf,
           case when p.status in ('published','confirmed','closed') and now() >= p.ends_at then 'completed'
                when p.status = 'published' and now() >= p.closes_at then 'closed'
                else p.status end as eff
    from public.parties p
    join public.venues v on v.id = p.venue_id
    left join seats on seats.party_id = p.id
    where p.status in ('published','confirmed','closed','completed')
      and (p_party_id is null or p.id = p_party_id)
  )
  select x.id, x.title, x.description, x.venue_id, x.v_name, x.v_area, x.v_city,
         x.party_date, x.start_time, x.end_time, x.starts_at, x.ends_at, x.closes_at,
         x.package_type, x.liquor_type, x.price_per_person, x.cover_photo_url,
         x.terms_text, x.terms_version, x.max_seats_per_booking,
         x.eff, (x.status in ('published','confirmed') and now() < x.closes_at), x.min_paid_seats, x.male_seats, x.female_seats,
         x.m + x.f, x.m, x.f, greatest(x.male_seats - x.m - x.hm, 0), greatest(x.female_seats - x.f - x.hf, 0)
  from x
  where p_party_id is not null or x.ends_at > now() - interval '7 days'
  order by x.starts_at;
$$;

-- 12. Who may call what ----------------------------------------------------------------------------------------------------
revoke all on function
  public.party_balance_deadline(timestamptz, timestamptz), public.party_seats_taken(uuid, text), public.party_booking_remaining(uuid),
  public.party_email(uuid, text, jsonb, text), public.party_ist(timestamptz),
  public.party_payment_for_order(uuid), public.party_payment_by_order(text), public.party_attach_order(uuid, text),
  public.party_release_payment(uuid), public.party_fail_payment(text),
  public.party_confirm_payment(text, text, bigint, numeric, numeric), public.party_apply_event(text),
  public.party_queue_refunds(uuid, text), public.party_on_cancel(), public.party_run_jobs()
  from public, anon, authenticated;
-- the edge functions run with the service role
grant execute on function
  public.party_payment_for_order(uuid), public.party_payment_by_order(text), public.party_attach_order(uuid, text),
  public.party_release_payment(uuid), public.party_fail_payment(text),
  public.party_confirm_payment(text, text, bigint, numeric, numeric), public.party_apply_event(text)
  to service_role;
-- admin screens (each function re-checks admin_users inside)
revoke all on function public.party_mark_refunded(uuid, date, text), public.party_mark_settled(uuid, date, text),
  public.party_admin_summary(uuid), public.party_admin_bookings(uuid), public.party_admin_refunds(uuid) from public, anon, authenticated;
grant execute on function public.party_mark_refunded(uuid, date, text), public.party_mark_settled(uuid, date, text),
  public.party_admin_summary(uuid), public.party_admin_bookings(uuid), public.party_admin_refunds(uuid) to authenticated;

-- 13. Schedule (same pg_cron pattern as mark-overdue-platform-fees) ------------------------------------------------------------
select cron.schedule('party-jobs', '* * * * *', 'select public.party_run_jobs()');

-- 14. Default terms, version 2 (new parties only; no party exists yet, and edits to a party's own text bump its version) ----------
alter table public.parties alter column terms_version set default 2;
alter table public.parties alter column terms_text set default $terms$1. PAXO is a booking platform. PAXO sells party seats, collects payments and issues the booking invoice.
2. The party, venue, food, drinks, entertainment and all services are provided and run by the venue partner. PAXO does not provide or run them.
3. The venue is solely responsible for the quality and safety of its food and drinks, its licences, hygiene, security and conduct at the party.
4. The party is confirmed once 30 seats are paid. Joining is open until the closing time and up to a maximum of 50 guests.
5. A seat is booked with a 30% deposit. After the party is confirmed, new guests pay 100% at the time of booking.
6. One person can book up to 10 seats in one booking. The booker must give the gender of every guest added.
7. The number of male and female seats is fixed for each party. When one category is full, no more seats are available in it.
8. The remaining balance must be paid within 48 hours of confirmation, or 3 days before the party, whichever comes first, and in any case at least 12 hours after confirmation. Joining and payments close 3 days before the party.
9. The 30% deposit is non-refundable once paid. If the balance is not paid on time, the deposit is forfeited, the seat is released and the guest cannot join the party.
10. If PAXO or the venue cancels the party, or if 30 seats are not paid by the closing time, guests receive a 100% refund within 7 to 10 working days.
11. Guests must arrive at the time shown on the party page, and the party starts at that time. If a guest arrives late or does not attend, neither the venue nor PAXO is responsible, and no refund is given.
12. The menu is decided by the votes of guests who have paid. The most-voted items are served, and a vote does not guarantee a specific item. The venue may replace an item with a similar one if it is not available.
13. Alcohol is served by the venue under its licence, only to guests who meet the legal drinking age. The venue may refuse service to any guest.
14. The venue may take action against any guest who misbehaves, including refusing entry or asking them to leave, with no refund.
15. Outside food and drinks are not allowed. Guests are responsible for any damage they cause.
16. PAXO is not liable for any injury, loss or dispute that happens at the venue. PAXO's responsibility is limited to the amount the guest paid for the seat.
17. PAXO issues an invoice for each booking. Taxes will be shown on the invoice as applicable.$terms$;

-- the guard used to force version 1 on insert; new parties now start at the current default version (2)
create or replace function public.parties_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  v_start timestamptz := null;
begin
  v_start := (new.party_date + new.start_time) at time zone 'Asia/Kolkata';
  if tg_op = 'INSERT' then
    new.status := 'draft'; new.published_at := null; new.confirmed_at := null;
    new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null;
    new.terms_version := 2; new.created_by := coalesce(auth.uid(), new.created_by);
    if new.closes_at is null then new.closes_at := v_start - interval '3 days'; end if;
    return new;
  end if;
  new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
  if old.status in ('cancelled','completed') then
    raise exception 'This party is % and can no longer be changed.', old.status;
  end if;
  new.terms_version := case when old.terms_text <> '' and new.terms_text is distinct from old.terms_text then old.terms_version + 1 else old.terms_version end;
  if (new.venue_id is distinct from old.venue_id or new.party_date is distinct from old.party_date
      or new.start_time is distinct from old.start_time or new.end_time is distinct from old.end_time
      or new.price_per_person is distinct from old.price_per_person or new.male_seats is distinct from old.male_seats
      or new.female_seats is distinct from old.female_seats)
     and exists (select 1 from public.party_seats s where s.party_id = old.id and s.status in ('held','paid')) then
    raise exception 'Venue, date, time, price and seat numbers cannot be changed after guests have joined. Cancel the party instead.';
  end if;
  if new.status is distinct from old.status then
    if not (case old.status
              when 'draft'     then new.status in ('published','cancelled')
              when 'published' then new.status in ('confirmed','closed','completed','cancelled')
              when 'confirmed' then new.status in ('closed','completed','cancelled')
              when 'closed'    then new.status in ('completed','cancelled')
              else false end) then
      raise exception 'A party cannot move from % to %.', old.status, new.status;
    end if;
    if new.status = 'confirmed' and current_user in ('authenticated', 'anon') then
      raise exception 'A party is confirmed automatically once enough seats are paid.';
    end if;
    if new.status = 'published' then
      if btrim(new.terms_text) = '' then raise exception 'Add the terms before publishing.'; end if;
      if v_start <= now() then raise exception 'The party start is in the past.'; end if;
      if new.closes_at is null or new.closes_at <= now() then raise exception 'The closing time must be in the future.'; end if;
      new.published_at := now();
    elsif new.status = 'confirmed' then new.confirmed_at := coalesce(new.confirmed_at, now());
    elsif new.status = 'cancelled' then new.cancelled_at := now(); new.cancelled_by := auth.uid();
    end if;
  else
    new.published_at := old.published_at; new.confirmed_at := old.confirmed_at;
    new.cancelled_at := old.cancelled_at; new.cancelled_by := old.cancelled_by;
  end if;
  return new;
end $$;

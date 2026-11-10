-- PARTY POOL, PHASE 4: Cashfree payments, a name + age for every seat, 5 seats per account, tax included / not included.
-- Migration name: party_pool_phase4_cashfree_seats_tax.     NOT APPLIED. Written for review (branch party-cashfree).
-- Additive except where a function is replaced (each replaced function is listed). Nothing here touches normal bookings,
-- payments, commissions, coupons or the booking refund logic. No existing row is changed.
--
-- DECISIONS ASSUMED (founder to confirm; each is one line to change):
--   * Tax percent is typed per party in the admin form. It DEFAULTS TO 0, and at 0 no tax line or tax word is shown to customers anywhere
--     (the existing party and every new party stay tax-free until someone enters a percent). New parties default to "price includes tax".
--   * The 30% deposit is taken on the total INCLUDING tax; a full refund returns everything paid, tax included.
--   * 5 seats per account is a hard cap in the database (least(max_seats_per_booking, 5)); the party form also limits it to 5.
--   * Cashfree needs an order to stay open at least ~16 minutes, so a Cashfree payment holds the seats for 16 minutes
--     (Razorpay payments keep the 10-minute hold).
--   * The existing published party keeps its stored max_seats_per_booking = 10, but the cap above still limits it to 5.
--   * party_invoices GST columns stay empty (waiting for the CA, as before).

-- 1. Parties: tax settings; default of 5 seats per booking -------------------------------------------------------------
alter table public.parties
  add column price_includes_tax boolean       not null default true,
  add column tax_percent        numeric(5,2)  not null default 0 check (tax_percent >= 0 and tax_percent <= 100);
alter table public.parties alter column max_seats_per_booking set default 5;

-- new parties get terms that say 5, not 10 (existing parties keep their own text; the admin edits it, which bumps the version)
do $$
declare d text;
begin
  select column_default into d from information_schema.columns
   where table_schema = 'public' and table_name = 'parties' and column_name = 'terms_text';
  if d is not null and d like '%One person can book up to 10 seats in one booking. The booker must give the gender of every guest added.%' then
    execute 'alter table public.parties alter column terms_text set default '
      || replace(replace(d, '::text', ''),
           'One person can book up to 10 seats in one booking. The booker must give the gender of every guest added.',
           'One person can book up to 5 seats in one booking. The booker must give the name, age and gender of every guest added.');
  end if;
end $$;

-- price, tax and seat numbers stay locked once anyone holds or has paid a seat (same guard, two more fields)
create or replace function public.parties_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
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
      or new.female_seats is distinct from old.female_seats
      or new.price_includes_tax is distinct from old.price_includes_tax or new.tax_percent is distinct from old.tax_percent)
     and exists (select 1 from public.party_seats s where s.party_id = old.id and s.status in ('held','paid')) then
    raise exception 'Venue, date, time, price, tax and seat numbers cannot be changed after guests have joined. Cancel the party instead.';
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
end $function$;

-- 2. Seats: who is coming ---------------------------------------------------------------------------------------------
alter table public.party_seats
  add column guest_name text check (guest_name is null or (char_length(btrim(guest_name)) between 2 and 60)),
  add column guest_age  integer check (guest_age is null or (guest_age between 1 and 120));

-- 3. Payments: which gateway, test or live, Cashfree ids ---------------------------------------------------------------
alter table public.party_payments
  add column provider            text not null default 'razorpay' check (provider in ('razorpay', 'cashfree')),
  add column cashfree_order_id   text unique,
  add column cashfree_payment_id text,
  add column cashfree_refund_id  text,
  add column gateway_mode        text not null default 'test' check (gateway_mode in ('test', 'live'));   -- fail-safe: 'test'
create unique index party_payments_cf_payment_idx on public.party_payments (cashfree_payment_id) where cashfree_payment_id is not null;

-- stamped from the live switches at insert; the provider and mode of a payment never change afterwards
create function public.set_party_payment_gateway_mode() returns trigger
language plpgsql security definer set search_path = public as $f$
declare s record;
begin
  if tg_op = 'UPDATE' then
    new.provider := old.provider; new.gateway_mode := old.gateway_mode;
    return new;
  end if;
  select cashfree_mode, razorpay_mode into s from public.platform_settings limit 1;
  new.gateway_mode := case
    when new.provider = 'cashfree' and s.cashfree_mode = 'production' then 'live'
    when new.provider = 'razorpay' and s.razorpay_mode = 'live' then 'live'
    else 'test' end;
  return new;
end $f$;
create trigger trg_set_party_payment_gateway_mode before insert or update on public.party_payments
  for each row execute function public.set_party_payment_gateway_mode();

-- 4. Money maths (one place; the screens only display what these return) -----------------------------------------------
create function public.party_seat_total(p_party_id uuid, p_n integer) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p.price_includes_tax then round(p_n * p.price_per_person, 2)
              else round(p_n * p.price_per_person, 2) + round(p_n * p.price_per_person * p.tax_percent / 100, 2) end
    from public.parties p where p.id = p_party_id
$$;
-- the tax inside that total (inclusive: total - total/(1+t); added on top: base * t)
create function public.party_seat_tax(p_party_id uuid, p_n integer) returns numeric
language sql stable security definer set search_path = public as $$
  select case when p.price_includes_tax
              then round(p_n * p.price_per_person - p_n * p.price_per_person / (1 + p.tax_percent / 100), 2)
              else round(p_n * p.price_per_person * p.tax_percent / 100, 2) end
    from public.parties p where p.id = p_party_id
$$;
revoke all on function public.party_seat_total(uuid, integer), public.party_seat_tax(uuid, integer) from public, anon, authenticated;

-- what the customer sees before paying (display only: party_start_payment recomputes everything itself)
create function public.party_quote(p_party_id uuid, p_seats integer) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p record; v_total numeric; v_now numeric; v_kind text;
begin
  select * into p from public.parties where id = p_party_id and status in ('published', 'confirmed');
  if not found or p_seats is null or p_seats < 1 or p_seats > 5 then return null; end if;
  v_total := public.party_seat_total(p.id, p_seats);
  v_kind := case when p.status = 'confirmed' then 'full' else 'deposit' end;
  v_now := case when v_kind = 'full' then v_total else round(v_total * 0.30, 2) end;
  return jsonb_build_object('seats', p_seats, 'price_per_person', p.price_per_person, 'tax_included', p.price_includes_tax,
    'tax_percent', p.tax_percent, 'tax_amount', public.party_seat_tax(p.id, p_seats), 'total', v_total,
    'kind', v_kind, 'pay_now', v_now, 'pay_later', v_total - v_now);
end $$;
revoke all on function public.party_quote(uuid, integer) from public;
grant execute on function public.party_quote(uuid, integer) to anon, authenticated;

-- the balance now follows the tax-aware total
create or replace function public.party_booking_remaining(p_booking_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(
    public.party_seat_total(p.id, (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status = 'paid'))
    - coalesce((select sum(x.amount) from public.party_payments x
                 where x.booking_id = b.id and x.status = 'paid' and x.refund_status = 'none'), 0), 0)
  from public.party_bookings b join public.parties p on p.id = b.party_id where b.id = p_booking_id
$$;

-- 5. Joining: replaces party_start_payment(uuid,text,text[],boolean,integer) ---------------------------------------------
-- p_guests = [{"name":"Asha","age":24,"gender":"female"}, ...]  (1 to 5 people)
drop function public.party_start_payment(uuid, text, text[], boolean, integer);
create function public.party_start_payment(
  p_party_id uuid, p_kind text, p_guests jsonb default null, p_accept boolean default false, p_terms_version integer default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  p record; b record; o record;
  v_n int; v_m int := 0; v_f int := 0; v_existing int; v_kind text; v_amount numeric; v_total numeric; v_pay uuid;
  v_max int; v_provider text; v_hold timestamptz; g jsonb; v_gender text; v_name text; v_age int;
begin
  if v_uid is null then raise exception 'Please sign in to continue.'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and account_state = 'active') then
    raise exception 'This account cannot join parties.';
  end if;
  if p_kind not in ('join', 'balance') then raise exception 'Unknown payment type.'; end if;

  select coalesce(payment_provider, 'razorpay') into v_provider from public.platform_settings limit 1;
  if v_provider not in ('razorpay', 'cashfree') then v_provider := 'razorpay'; end if;
  v_hold := now() + case when v_provider = 'cashfree' then interval '16 minutes' else interval '10 minutes' end;

  select * into p from public.parties where id = p_party_id for update;      -- one buyer at a time per party
  if not found or p.status not in ('published', 'confirmed') then raise exception 'This party is not open.'; end if;
  v_max := least(p.max_seats_per_booking, 5);

  select * into b from public.party_bookings where party_id = p.id and customer_id = v_uid for update;
  if b.id is not null and b.status <> 'active' then
    raise exception 'You can no longer join this party.';
  end if;

  if p_kind = 'join' then
    if now() >= p.closes_at then raise exception 'Joining has closed for this party.'; end if;
    if not coalesce(p_accept, false) then raise exception 'Please confirm the guest details and accept the terms to continue.'; end if;
    if p_terms_version is distinct from p.terms_version then
      raise exception 'The terms have changed. Please read and accept them again.';
    end if;
    if p_guests is null or jsonb_typeof(p_guests) <> 'array' then raise exception 'Add the name, age and gender of every guest.'; end if;
    v_n := jsonb_array_length(p_guests);
    if v_n < 1 then raise exception 'Choose at least one seat.'; end if;
    if v_n > v_max then raise exception 'You can book up to % seats in one booking.', v_max; end if;
    for g in select * from jsonb_array_elements(p_guests) loop
      if jsonb_typeof(g) <> 'object' then raise exception 'Add the name, age and gender of every guest.'; end if;
      v_name := btrim(coalesce(g->>'name', ''));
      if char_length(v_name) < 2 or char_length(v_name) > 60 then raise exception 'Enter the name of every guest (2 to 60 letters).'; end if;
      if (g->>'age') is null or (g->>'age') !~ '^[0-9]{1,3}$' then raise exception 'Enter the age of every guest.'; end if;
      v_age := (g->>'age')::int;
      if v_age < 1 or v_age > 120 then raise exception 'Enter a valid age for every guest.'; end if;
      if p.min_age is not null and v_age < p.min_age then
        raise exception 'Every guest must be at least % years old.', p.min_age;
      end if;
      v_gender := g->>'gender';
      if v_gender is null or v_gender not in ('male', 'female') then raise exception 'Choose male or female for every person.'; end if;
      if v_gender = 'male' then v_m := v_m + 1; else v_f := v_f + 1; end if;
    end loop;

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
    if v_existing + v_n > v_max then
      raise exception 'You can hold up to % seats in total for this party. You already have %.', v_max, v_existing;
    end if;
    if v_m > p.male_seats - public.party_seats_taken(p.id, 'male') then
      raise exception 'Not enough male seats are left.';
    end if;
    if v_f > p.female_seats - public.party_seats_taken(p.id, 'female') then
      raise exception 'Not enough female seats are left.';
    end if;

    v_kind := case when p.status = 'confirmed' then 'full' else 'deposit' end;
    v_total := public.party_seat_total(p.id, v_n);
    v_amount := case when v_kind = 'full' then v_total else round(v_total * 0.30, 2) end;
    insert into public.party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, held_until, provider)
    values (p.id, b.id, v_uid, v_kind, v_n, v_amount, v_hold, v_provider) returning id into v_pay;
    for g in select * from jsonb_array_elements(p_guests) loop
      insert into public.party_seats (party_id, customer_id, gender, status, booking_id, payment_id, held_until, guest_name, guest_age)
      values (p.id, v_uid, g->>'gender', 'held', b.id, v_pay, v_hold, btrim(g->>'name'), (g->>'age')::int);
    end loop;
    insert into public.party_acceptances (party_id, booking_id, payment_id, customer_id, terms_version)
    values (p.id, b.id, v_pay, v_uid, p.terms_version);
    return jsonb_build_object('payment_id', v_pay, 'kind', v_kind, 'amount', v_amount, 'seats', v_n, 'held_until', v_hold,
                              'provider', v_provider, 'total', v_total, 'tax_amount', public.party_seat_tax(p.id, v_n));
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
  insert into public.party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, provider)
  values (p.id, b.id, v_uid, 'balance', 0, v_amount, v_provider) returning id into v_pay;
  return jsonb_build_object('payment_id', v_pay, 'kind', 'balance', 'amount', v_amount, 'seats', 0, 'held_until', null,
                            'provider', v_provider, 'total', null, 'tax_amount', null);
end $$;
revoke all on function public.party_start_payment(uuid, text, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.party_start_payment(uuid, text, jsonb, boolean, integer) to authenticated;

-- 6. Edge-function helpers (service role only) ---------------------------------------------------------------------------
-- the Razorpay attach now refuses a row that belongs to Cashfree (and the other way round)
create or replace function public.party_attach_order(p_payment_id uuid, p_order_id text) returns void
language sql security definer set search_path = public as $$
  update public.party_payments set razorpay_order_id = p_order_id
   where id = p_payment_id and status = 'created' and razorpay_order_id is null and provider = 'razorpay'
$$;
create function public.party_attach_cashfree_order(p_payment_id uuid, p_order_id text) returns void
language sql security definer set search_path = public as $$
  update public.party_payments set cashfree_order_id = p_order_id
   where id = p_payment_id and status = 'created' and cashfree_order_id is null and provider = 'cashfree'
$$;
create function public.party_payment_by_cashfree_order(p_order_id text)
returns table (id uuid, customer_id uuid, amount numeric, status text, provider text)
language sql stable security definer set search_path = public as $$
  select x.id, x.customer_id, x.amount, x.status, x.provider from public.party_payments x where x.cashfree_order_id = p_order_id
$$;
create or replace function public.party_fail_payment(p_order_id text) returns text
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.party_payments where razorpay_order_id = p_order_id or cashfree_order_id = p_order_id for update;
  if not found then return 'unknown order'; end if;
  if pay.status = 'paid' then return 'ignored: already paid'; end if;
  perform public.party_release_payment(pay.id);
  return 'payment marked failed';
end $$;

-- 7. Money in. ONE function holds the rules for both gateways ------------------------------------------------------------
-- (the body is the Phase 2 party_confirm_payment, looked up by payment id; only the gateway-specific lines differ).
create function public.party_confirm_core(
  p_payment_id uuid, p_gw_payment_id text, p_amount_paise bigint, p_fee numeric default null, p_tax numeric default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pay record; p record; pb record; v_gw text;
  v_ok boolean := true; v_cap int; v_need int; v_has_fee boolean; v_paid int; v_confirmed boolean := false; v_deadline timestamptz;
  g text; r record;
begin
  select * into pay from public.party_payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('result', 'unknown order'); end if;
  v_gw := case pay.provider when 'cashfree' then 'Cashfree' else 'Razorpay' end;
  if pay.status = 'paid' then return jsonb_build_object('result', 'already paid'); end if;
  if p_amount_paise is distinct from round(pay.amount * 100)::bigint then
    insert into public.admin_alerts (kind, message, urgent)
    values ('party_payment_amount_mismatch',
            format('%s reported %s paise for a party payment PAXO expected to be %s paise. It was NOT marked paid. Please check it in %s.', v_gw, p_amount_paise, round(pay.amount * 100)::bigint, v_gw), true);
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
      -- seats that were already given back (the hold ran out) are taken again only if they are still free
      foreach g in array array['male', 'female'] loop
        select count(*)::int into v_need from public.party_seats where payment_id = pay.id and gender = g and status = 'cancelled';
        v_cap := case when g = 'male' then p.male_seats else p.female_seats end;
        if v_need > 0 and public.party_seats_taken(p.id, g) + v_need > v_cap then v_ok := false; end if;
      end loop;
      if v_ok and (select count(*) from public.party_seats where booking_id = pb.id and status = 'paid')
                  + pay.seats_count > least(p.max_seats_per_booking, 5) then v_ok := false; end if;
    end if;
  end if;

  if not v_ok then
    update public.party_payments
       set status = 'paid', paid_at = now(),
           razorpay_payment_id = case when provider = 'razorpay' then p_gw_payment_id else razorpay_payment_id end,
           cashfree_payment_id = case when provider = 'cashfree' then p_gw_payment_id else cashfree_payment_id end,
           gateway_fee = p_fee, gateway_tax = p_tax, gateway_fee_estimated = not v_has_fee,
           refund_status = 'due', refund_amount = amount, refund_reason = 'late_payment', refund_queued_at = now()
     where id = pay.id;
    update public.party_seats set status = 'cancelled' where payment_id = pay.id and status in ('held', 'cancelled');
    insert into public.admin_alerts (kind, message, urgent)
    values ('party_late_payment',
            format('A party payment of ₹%s arrived after it could no longer be used (party %s, %s%s payment %s). A 100%% refund is queued under Refunds due: refund it in full by hand in %s, then press Mark refunded. [%s]',
                   pay.amount, p.title, case when pay.gateway_mode = 'test' then 'TEST ' else '' end, v_gw, p_gw_payment_id, v_gw, pay.id),
            pay.provider = 'cashfree');
    return jsonb_build_object('result', 'late payment: refund queued');
  end if;

  -- the real fee is not known yet for Cashfree (it arrives later as a charges event): the same estimate Razorpay uses, flagged
  update public.party_payments
     set status = 'paid', paid_at = now(),
         razorpay_payment_id = case when provider = 'razorpay' then p_gw_payment_id else razorpay_payment_id end,
         cashfree_payment_id = case when provider = 'cashfree' then p_gw_payment_id else cashfree_payment_id end,
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

-- Razorpay: same name, same arguments, same results as before
create or replace function public.party_confirm_payment(
  p_order_id text, p_razorpay_payment_id text, p_amount_paise bigint,
  p_fee numeric default null, p_tax numeric default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.party_payments where razorpay_order_id = p_order_id and provider = 'razorpay';
  if v_id is null then return jsonb_build_object('result', 'unknown order'); end if;
  return public.party_confirm_core(v_id, p_razorpay_payment_id, p_amount_paise, p_fee, p_tax);
end $$;

-- Cashfree: called by the edge functions after they asked Cashfree itself (amount from Cashfree's reply, never the browser)
create function public.party_cashfree_apply_payment(p_order_id text, p_cf_payment_id text, p_amount numeric, p_currency text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_order_id is null or p_cf_payment_id is null or p_amount is null then return jsonb_build_object('result', 'malformed'); end if;
  select id into v_id from public.party_payments where cashfree_order_id = p_order_id and provider = 'cashfree';
  if v_id is null then return jsonb_build_object('result', 'unknown order'); end if;
  if coalesce(p_currency, 'INR') <> 'INR' then return jsonb_build_object('result', 'amount mismatch'); end if;
  if exists (select 1 from public.party_payments x where x.cashfree_payment_id = p_cf_payment_id and x.id <> v_id) then
    return jsonb_build_object('result', 'duplicate payment id');
  end if;
  return public.party_confirm_core(v_id, p_cf_payment_id, round(p_amount * 100)::bigint, null, null);
end $$;

-- Cashfree's real fee (PAYMENT_CHARGES_WEBHOOK): only fills the fee fields of an already-paid party payment
create function public.party_cashfree_apply_charges(p_order_id text, p_service_charge numeric, p_service_tax numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare pay record;
begin
  select * into pay from public.party_payments where cashfree_order_id = p_order_id for update;
  if pay.id is null then return jsonb_build_object('result', 'unknown order'); end if;
  if pay.status <> 'paid' then return jsonb_build_object('result', 'ignored: not paid yet'); end if;
  if p_service_charge is null or p_service_tax is null or p_service_charge < 0 or p_service_tax < 0 then
    return jsonb_build_object('result', 'malformed charges');
  end if;
  update public.party_payments
     set gateway_fee = round(p_service_charge + p_service_tax, 2), gateway_tax = round(p_service_tax, 2), gateway_fee_estimated = false
   where id = pay.id;
  return jsonb_build_object('result', 'fee stored');
end $$;

revoke all on function
  public.party_attach_cashfree_order(uuid, text), public.party_payment_by_cashfree_order(text),
  public.party_confirm_core(uuid, text, bigint, numeric, numeric), public.party_cashfree_apply_payment(text, text, numeric, text),
  public.party_cashfree_apply_charges(text, numeric, numeric), public.set_party_payment_gateway_mode()
  from public, anon, authenticated;
grant execute on function
  public.party_attach_cashfree_order(uuid, text), public.party_payment_by_cashfree_order(text),
  public.party_cashfree_apply_payment(text, text, numeric, text), public.party_cashfree_apply_charges(text, numeric, numeric)
  to service_role;

-- 8. Refunds: an urgent alert when a Cashfree refund becomes due (the late-payment case raises its own, above) -------------
create function public.party_refund_alert() returns trigger
language plpgsql security definer set search_path = public as $f$
declare p record;
begin
  if new.refund_status = 'due' and old.refund_status = 'none' and coalesce(new.refund_reason, '') <> 'late_payment' then
    select title into p from public.parties where id = new.party_id;
    insert into public.admin_alerts (kind, message, urgent)
    values ('party_refund_pending',
            format('Party refund due: ₹%s for "%s" (%s%s payment %s). Refund exactly ₹%s by hand in the %s dashboard, then press Mark refunded. [%s]',
                   new.refund_amount, p.title, case when new.gateway_mode = 'test' then 'TEST ' else '' end,
                   case new.provider when 'cashfree' then 'Cashfree' else 'Razorpay' end,
                   coalesce(new.cashfree_payment_id, new.razorpay_payment_id, '—'), new.refund_amount,
                   case new.provider when 'cashfree' then 'Cashfree' else 'Razorpay' end, new.id),
            new.provider = 'cashfree');
  end if;
  return null;
end $f$;
create trigger trg_party_refund_alert after update of refund_status on public.party_payments
  for each row execute function public.party_refund_alert();
revoke all on function public.party_refund_alert() from public, anon, authenticated;

-- replaces party_mark_refunded(uuid,date,text): one optional extra argument (the Cashfree refund id) and it closes the alert
drop function public.party_mark_refunded(uuid, date, text);
create function public.party_mark_refunded(p_payment_id uuid, p_date date, p_note text default null, p_cashfree_refund_id text default null)
returns void
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
         cashfree_refund_id = case when provider = 'cashfree' then nullif(left(btrim(coalesce(p_cashfree_refund_id, '')), 100), '') else cashfree_refund_id end,
         refund_marked_by = auth.uid(), refund_marked_at = now()
   where id = pay.id;
  update public.admin_alerts set resolved_at = now()
   where resolved_at is null and kind in ('party_refund_pending', 'party_late_payment') and message like '%[' || pay.id || ']%';
  select * into p from public.parties where id = pay.party_id;
  perform public.party_email(pay.customer_id, 'party_refund_sent',
    jsonb_build_object('party_title', p.title, 'refund_amount', pay.refund_amount, 'refunded_on', p_date),
    'party-refund-' || pay.id);
end $$;
revoke all on function public.party_mark_refunded(uuid, date, text, text) from public, anon, authenticated;
grant execute on function public.party_mark_refunded(uuid, date, text, text) to authenticated;

-- 9. Admin screens --------------------------------------------------------------------------------------------------------
-- refunds list: now also says which gateway, test or live, and the Cashfree ids to match in the dashboard
drop function public.party_admin_refunds(uuid);
create function public.party_admin_refunds(p_party_id uuid)
returns table (payment_id uuid, customer_name text, phone text, email text, kind text, paid_amount numeric, refund_amount numeric,
               reason text, refund_status text, queued_at timestamptz, refunded_on date, note text,
               provider text, gateway_mode text, gateway_payment_id text, cashfree_refund_id text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
  return query
  select x.id, pr.full_name, pr.phone, pr.email, x.kind, x.amount, x.refund_amount, x.refund_reason, x.refund_status,
         x.refund_queued_at, x.refunded_on, x.refund_note,
         x.provider, x.gateway_mode, coalesce(x.cashfree_payment_id, x.razorpay_payment_id), x.cashfree_refund_id
  from public.party_payments x left join public.profiles pr on pr.id = x.customer_id
  where x.party_id = p_party_id and x.refund_status <> 'none'
  order by x.refund_status, x.refund_queued_at;
end $$;
revoke all on function public.party_admin_refunds(uuid) from public, anon, authenticated;
grant execute on function public.party_admin_refunds(uuid) to authenticated;

-- money panel: live payments only unless the admin asks to include test ones (same idea as the bookings Settlements screen)
drop function public.party_admin_summary(uuid);
create function public.party_admin_summary(p_party_id uuid, p_include_test boolean default false)
returns jsonb
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
    where x.party_id = p_party_id and x.status = 'paid' and (p_include_test or x.gateway_mode = 'live'))
  || jsonb_build_object(
    'test_payments_count', (select count(*) from public.party_payments x where x.party_id = p_party_id and x.status = 'paid' and x.gateway_mode = 'test'),
    'test_total_collected', (select coalesce(sum(x.amount), 0) from public.party_payments x where x.party_id = p_party_id and x.status = 'paid' and x.gateway_mode = 'test'),
    'includes_test', p_include_test,
    'balances_due', coalesce((select sum(public.party_booking_remaining(b.id)) from public.party_bookings b
                              join public.parties p on p.id = b.party_id
                              where b.party_id = p_party_id and b.status = 'active' and p.status = 'confirmed'), 0),
    'settled_on', (select settled_on from public.party_venue_settlement where party_id = p_party_id),
    'settled_note', (select settled_note from public.party_venue_settlement where party_id = p_party_id));
end $$;
revoke all on function public.party_admin_summary(uuid, boolean) from public, anon, authenticated;
grant execute on function public.party_admin_summary(uuid, boolean) to authenticated;

-- one row per guest: name, age, gender (admin only)
create function public.party_admin_guests(p_party_id uuid)
returns table (booking_id uuid, booker_name text, booker_phone text, guest_name text, guest_age integer, gender text, seat_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.party_assert_admin();
  return query
  select s.booking_id, pr.full_name, pr.phone, s.guest_name, s.guest_age, s.gender, s.status
    from public.party_seats s join public.party_bookings b on b.id = s.booking_id
    left join public.profiles pr on pr.id = b.customer_id
   where s.party_id = p_party_id and s.status in ('paid', 'forfeited')
   order by b.created_at, s.created_at;
end $$;
revoke all on function public.party_admin_guests(uuid) from public, anon, authenticated;
grant execute on function public.party_admin_guests(uuid) to authenticated;

-- 10. What customers see ----------------------------------------------------------------------------------------------------
-- party_public: two new columns (tax) and the 5-seat cap; everything else is the live definition
drop function public.party_public(uuid);
create function public.party_public(p_party_id uuid default null)
returns table (id uuid, title text, description text, venue_id uuid, venue_name text, venue_area text, venue_city text,
  party_date date, start_time time, end_time time, starts_at timestamptz, ends_at timestamptz, closes_at timestamptz,
  package_type text, liquor_type text, price_per_person numeric, cover_photo_url text, terms_text text, terms_version integer,
  max_seats_per_booking integer, status text, joining_open boolean, min_paid_seats integer, male_seats integer, female_seats integer,
  paid_total integer, paid_male integer, paid_female integer, male_left integer, female_left integer,
  inclusions text, dress_code text, min_age integer, highlights text, price_includes_tax boolean, tax_percent numeric)
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
         x.terms_text, x.terms_version, least(x.max_seats_per_booking, 5),
         x.eff, (x.status in ('published','confirmed') and now() < x.closes_at), x.min_paid_seats, x.male_seats, x.female_seats,
         x.m + x.f, x.m, x.f, greatest(x.male_seats - x.m - x.hm, 0), greatest(x.female_seats - x.f - x.hf, 0),
         x.inclusions, x.dress_code, x.min_age, x.highlights, x.price_includes_tax, x.tax_percent
  from x
  where p_party_id is not null or x.ends_at > now() - interval '7 days'
  order by x.starts_at;
$$;
revoke all on function public.party_public(uuid) from public;
grant execute on function public.party_public(uuid) to anon, authenticated;

-- my booking: adds the total, the tax inside it, and my own guest list
create or replace function public.party_my_booking(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b record; p record; v_rem numeric; r jsonb; v_seats int;
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
  v_seats := coalesce((r->>'seats_paid')::int, 0);
  return r || jsonb_build_object(
    'paid_amount', coalesce((select sum(x.amount) from public.party_payments x where x.booking_id = b.id and x.status = 'paid' and x.refund_status = 'none'), 0),
    'balance_due', v_rem,
    'balance_due_by', b.balance_due_by,
    'can_pay_balance', v_rem > 0 and (b.balance_due_by is null or now() <= b.balance_due_by),
    'refund_due', coalesce((select sum(x.refund_amount) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'due'), 0),
    'refunded', coalesce((select sum(x.refund_amount) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'refunded'), 0),
    'refunded_on', (select max(x.refunded_on) from public.party_payments x where x.booking_id = b.id and x.refund_status = 'refunded'),
    'total_amount', case when v_seats > 0 then public.party_seat_total(p.id, v_seats) else 0 end,
    'tax_amount', case when v_seats > 0 then public.party_seat_tax(p.id, v_seats) else 0 end,
    'tax_included', p.price_includes_tax, 'tax_percent', p.tax_percent,
    'guests', coalesce((select jsonb_agg(jsonb_build_object('name', s.guest_name, 'age', s.guest_age, 'gender', s.gender) order by s.created_at)
                          from public.party_seats s where s.booking_id = b.id and s.status = 'paid'), '[]'::jsonb));
end $$;

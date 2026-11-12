-- PARTY POOL, PHASE 1. Purely additive: three new tables, one storage bucket, two functions, two triggers.
-- No change to any existing table, function, policy, booking, payment, commission, coupon or refund logic.
-- Customers never read these tables directly: they use party_public() below, which exposes only safe columns and
-- counts PAID seats only. The venue settlement lives in its own admin-only table, so it can never leak.

-- 1. The party --------------------------------------------------------------------------------------------------
create table public.parties (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null check (char_length(btrim(title)) between 2 and 120),
  description           text not null default '',
  venue_id              uuid not null references public.venues(id) on delete restrict,
  party_date            date not null,
  start_time            time not null,
  end_time              time not null,                       -- an end time at or before the start means "after midnight"
  starts_at             timestamptz generated always as ((party_date + start_time) at time zone 'Asia/Kolkata') stored,
  ends_at               timestamptz generated always as (
                          (party_date + case when end_time <= start_time then 1 else 0 end + end_time) at time zone 'Asia/Kolkata') stored,
  package_type          text not null default '',
  liquor_type           text not null default '',            -- e.g. IMFL
  price_per_person      numeric(10,2) not null check (price_per_person > 0),
  male_seats            integer not null check (male_seats >= 0),
  female_seats          integer not null check (female_seats >= 0),
  min_paid_seats        integer not null default 30 check (min_paid_seats >= 1),
  closes_at             timestamptz,                         -- empty on insert = 3 days before the party start (trigger)
  max_seats_per_booking integer not null default 10 check (max_seats_per_booking >= 1),
  cover_photo_url       text,
  terms_text            text not null default $terms$1. PAXO is a booking platform. PAXO sells party seats, collects payments and issues the booking invoice.
2. The party, venue, food, drinks, entertainment and all services are provided and run by the venue partner. PAXO does not provide or run them.
3. The venue is solely responsible for the quality and safety of its food and drinks, its licences, hygiene, security and conduct at the party.
4. The party is confirmed once 30 seats are paid. Joining is open until the closing time and up to a maximum of 50 guests.
5. A seat is booked with a 30% deposit. After the party is confirmed, new guests pay 100% at the time of booking.
6. One person can book up to 10 seats in one booking. The booker must give the gender of every guest added.
7. The number of male and female seats is fixed for each party. When one category is full, no more seats are available in it.
8. The remaining balance must be paid within 48 hours of confirmation, or 3 days before the party, whichever comes first. Joining and payments close 3 days before the party.
9. The 30% deposit is non-refundable once paid. If the balance is not paid on time, the deposit is forfeited, the seat is released and the guest cannot join the party.
10. If PAXO or the venue cancels the party, or if 30 seats are not paid by the closing time, guests receive a 100% refund within 7 to 10 working days.
11. Guests must arrive at the time shown on the party page, and the party starts at that time. If a guest arrives late or does not attend, neither the venue nor PAXO is responsible, and no refund is given.
12. The menu is decided by the votes of guests who have paid. The most-voted items are served, and a vote does not guarantee a specific item. The venue may replace an item with a similar one if it is not available.
13. Alcohol is served by the venue under its licence, only to guests who meet the legal drinking age. The venue may refuse service to any guest.
14. The venue may take action against any guest who misbehaves, including refusing entry or asking them to leave, with no refund.
15. Outside food and drinks are not allowed. Guests are responsible for any damage they cause.
16. PAXO is not liable for any injury, loss or dispute that happens at the venue. PAXO's responsibility is limited to the amount the guest paid for the seat.
17. PAXO issues an invoice for each booking. Taxes will be shown on the invoice as applicable.$terms$,
  terms_version         integer not null default 1,          -- goes up whenever terms_text changes (Phase 2 stores it on acceptance)
  status                text not null default 'draft'
                          check (status in ('draft','published','confirmed','closed','completed','cancelled')),
  published_at          timestamptz,
  confirmed_at          timestamptz,                         -- stamped by the Phase 2 payment logic
  cancelled_at          timestamptz,
  cancelled_by          uuid references auth.users(id) on delete set null,
  cancel_reason         text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint parties_seats_total check (male_seats + female_seats >= 1),
  constraint parties_min_within_total check (min_paid_seats <= male_seats + female_seats),
  constraint parties_closes_before_start check (closes_at is null or closes_at <= starts_at)
);
create index parties_status_starts_idx on public.parties (status, starts_at);
create index parties_venue_idx on public.parties (venue_id);

-- 2. Admin-only: what PAXO pays the venue (never readable by customers or partners) -----------------------------
create table public.party_venue_settlement (
  party_id         uuid primary key references public.parties(id) on delete cascade,
  settlement_type  text check (settlement_type in ('per_head','percentage')),
  settlement_value numeric(10,2) check (settlement_value >= 0),
  note             text check (char_length(note) <= 2000),
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  constraint settlement_pct_max check (settlement_type is distinct from 'percentage' or settlement_value <= 100)
);

-- 3. Seats. Phase 1 only needs the minimum so the counters are real (empty = 0). Phase 2 extends it. ------------
-- Rows are created only by Phase 2 payment functions. Nothing here is writable or readable by customers.
create table public.party_seats (
  id          uuid primary key default gen_random_uuid(),
  party_id    uuid not null references public.parties(id) on delete restrict,
  customer_id uuid not null references auth.users(id) on delete restrict,
  gender      text not null check (gender in ('male','female')),
  status      text not null default 'held' check (status in ('held','paid','cancelled','forfeited')),
  created_at  timestamptz not null default now()
);
create index party_seats_party_status_idx on public.party_seats (party_id, status, gender);

-- 4. Access: admins only, straight on the tables --------------------------------------------------------------
alter table public.parties                enable row level security;
alter table public.party_venue_settlement enable row level security;
alter table public.party_seats            enable row level security;
revoke all on public.parties, public.party_venue_settlement, public.party_seats from anon, authenticated;
grant select, insert, update, delete on public.parties, public.party_venue_settlement to authenticated;
grant select on public.party_seats to authenticated;

create policy parties_admin_select on public.parties for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy parties_admin_insert on public.parties for insert
  with check (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy parties_admin_update on public.parties for update
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()))
  with check (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy parties_admin_delete_draft on public.parties for delete
  using (status = 'draft' and exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_settlement_admin_all on public.party_venue_settlement for all
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()))
  with check (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_seats_admin_select on public.party_seats for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));

-- 5. Rules the database enforces (not just the screen) -----------------------------------------------------------
create function public.parties_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  v_start timestamptz := null;
begin
  -- the stored starts_at column is not filled in yet while this trigger runs, so work it out from date + time
  v_start := (new.party_date + new.start_time) at time zone 'Asia/Kolkata';
  if tg_op = 'INSERT' then
    -- a new party always starts as a draft; the admin publishes it explicitly
    new.status := 'draft'; new.published_at := null; new.confirmed_at := null;
    new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null;
    new.terms_version := 1; new.created_by := coalesce(auth.uid(), new.created_by);
    if new.closes_at is null then new.closes_at := v_start - interval '3 days'; end if;
    return new;
  end if;

  new.created_at := old.created_at; new.created_by := old.created_by; new.updated_at := now();
  if old.status in ('cancelled','completed') then
    raise exception 'This party is % and can no longer be changed.', old.status;
  end if;
  new.terms_version := case when old.terms_text <> '' and new.terms_text is distinct from old.terms_text then old.terms_version + 1 else old.terms_version end;

  -- venue, date, time, price and seat numbers cannot change once anyone holds or has paid for a seat (cancel instead)
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
    -- "confirmed" is set only by the service role or the Phase 2 payment function (which runs as the database owner),
    -- never by an admin or anyone else signed in through the apps
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
create trigger trg_parties_guard before insert or update on public.parties
  for each row execute function public.parties_guard();

create function public.party_settlement_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger trg_party_settlement_touch before insert or update on public.party_venue_settlement
  for each row execute function public.party_settlement_touch();

-- 6. The one safe door for customers ----------------------------------------------------------------------------
-- party_public()        -> every party customers may see (published, confirmed, closed, recently completed)
-- party_public(<id>)    -> one party
-- Counts are PAID seats only. Settlement, admin notes and other customers' data are not in the result.
-- status: a confirmed party stays "confirmed"; a published one past its closing time reads "closed"; after the
-- party ends it reads "completed". joining_open is true only while published/confirmed and before the closing time.
create function public.party_public(p_party_id uuid default null)
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
           count(*) filter (where s.gender = 'male')::int   as m,
           count(*) filter (where s.gender = 'female')::int as f
    from public.party_seats s where s.status = 'paid' group by s.party_id
  ), x as (
    select p.*, v.name as v_name, v.area as v_area, v.city as v_city,
           coalesce(seats.m, 0) as m, coalesce(seats.f, 0) as f,
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
         x.m + x.f, x.m, x.f, greatest(x.male_seats - x.m, 0), greatest(x.female_seats - x.f, 0)
  from x
  where p_party_id is not null or x.ends_at > now() - interval '7 days'
  order by x.starts_at;
$$;
revoke all on function public.party_public(uuid) from public;
grant execute on function public.party_public(uuid) to anon, authenticated;

-- 7. Cover photos: public to read, only admins can add, replace or remove --------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('party-covers', 'party-covers', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy party_covers_select_public on storage.objects for select using (bucket_id = 'party-covers');
create policy party_covers_insert_admin on storage.objects for insert
  with check (bucket_id = 'party-covers' and exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_covers_update_admin on storage.objects for update
  using (bucket_id = 'party-covers' and exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy party_covers_delete_admin on storage.objects for delete
  using (bucket_id = 'party-covers' and exists (select 1 from public.admin_users au where au.id = auth.uid()));

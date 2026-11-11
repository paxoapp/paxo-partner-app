-- Party Pool phase 6: visibility switch (off / testers / all).
-- platform_settings.party_pool_visibility decides who may see and use Party Pool in the CUSTOMER app. Default 'off'.
--   off      nobody (admins too: they see nothing in the customer app)
--   testers  accounts listed in party_pool_testers, plus admin accounts
--   all      everyone, signed in or not (as today)
-- Admin console screens, payment confirmation, the Cashfree/Razorpay webhooks, refunds and every party_admin_* function are NOT gated:
-- a payment already in flight must always finish. No booking function, table or policy is touched.
--
-- How the nine customer-facing functions are gated: each original is RENAMED to <name>__ungated (and closed to customers),
-- and a thin SECURITY DEFINER wrapper with the original name, signature, return type and grants is created in its place.
-- Everything that called the old name (edge functions, other functions) now goes through the gate. Rollback = phase6-rollback.sql
-- (drops the wrappers, renames the originals back: the original function text is restored byte for byte).

alter table public.platform_settings
  add column party_pool_visibility text not null default 'off'
  constraint platform_settings_party_pool_visibility_chk check (party_pool_visibility in ('off', 'testers', 'all'));

create table public.party_pool_testers (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  note     text,
  added_at timestamptz not null default now()
);
alter table public.party_pool_testers enable row level security;
revoke all on public.party_pool_testers from public, anon, authenticated;
create policy party_pool_testers_admin_all on public.party_pool_testers
  for all to authenticated
  using (exists (select 1 from public.admin_users a where a.id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.id = auth.uid()));
grant select, insert, update, delete on public.party_pool_testers to authenticated;

-- the one yes/no everything uses
create or replace function public.party_pool_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select case (select party_pool_visibility from public.platform_settings limit 1)
    when 'all' then true
    when 'testers' then auth.uid() is not null and (
         exists (select 1 from public.party_pool_testers t where t.user_id = auth.uid())
      or exists (select 1 from public.admin_users a where a.id = auth.uid()))
    else false
  end
$$;
revoke all on function public.party_pool_allowed() from public, anon, authenticated;

-- what the customer app asks once after sign-in (also for signed-out visitors: true only in mode 'all')
create or replace function public.party_pool_access() returns boolean
language sql stable security definer set search_path = public as $$
  select public.party_pool_allowed()
$$;
revoke all on function public.party_pool_access() from public, anon, authenticated;
grant execute on function public.party_pool_access() to anon, authenticated;

-- ---- rename the originals and close them to customers ------------------------------------------------------------------------
alter function public.party_public(uuid)                              rename to party_public__ungated;
alter function public.party_quote(uuid, integer)                      rename to party_quote__ungated;
alter function public.party_menu_voting(uuid)                         rename to party_menu_voting__ungated;
alter function public.party_menu_final(uuid)                          rename to party_menu_final__ungated;
alter function public.party_cast_vote(uuid, text, uuid)               rename to party_cast_vote__ungated;
alter function public.party_my_booking(uuid)                          rename to party_my_booking__ungated;
alter function public.party_my_bookings()                             rename to party_my_bookings__ungated;
alter function public.party_my_invoices()                             rename to party_my_invoices__ungated;
alter function public.party_start_payment(uuid, text, jsonb, boolean, integer) rename to party_start_payment__ungated;

revoke all on function public.party_public__ungated(uuid)                                from public, anon, authenticated;
revoke all on function public.party_quote__ungated(uuid, integer)                        from public, anon, authenticated;
revoke all on function public.party_menu_voting__ungated(uuid)                           from public, anon, authenticated;
revoke all on function public.party_menu_final__ungated(uuid)                            from public, anon, authenticated;
revoke all on function public.party_cast_vote__ungated(uuid, text, uuid)                 from public, anon, authenticated;
revoke all on function public.party_my_booking__ungated(uuid)                            from public, anon, authenticated;
revoke all on function public.party_my_bookings__ungated()                               from public, anon, authenticated;
revoke all on function public.party_my_invoices__ungated()                               from public, anon, authenticated;
revoke all on function public.party_start_payment__ungated(uuid, text, jsonb, boolean, integer) from public, anon, authenticated;

-- ---- the gated wrappers (same name, arguments, return type) --------------------------------------------------------------------
create or replace function public.party_public(p_party_id uuid default null)
returns table(id uuid, title text, description text, venue_id uuid, venue_name text, venue_area text, venue_city text, party_date date, start_time time without time zone, end_time time without time zone, starts_at timestamp with time zone, ends_at timestamp with time zone, closes_at timestamp with time zone, package_type text, liquor_type text, price_per_person numeric, cover_photo_url text, terms_text text, terms_version integer, max_seats_per_booking integer, status text, joining_open boolean, min_paid_seats integer, male_seats integer, female_seats integer, paid_total integer, paid_male integer, paid_female integer, male_left integer, female_left integer, inclusions text, dress_code text, min_age integer, highlights text, price_includes_tax boolean, tax_percent numeric)
language sql stable security definer set search_path = public as $$
  select * from public.party_public__ungated(p_party_id) where public.party_pool_allowed()
$$;

create or replace function public.party_quote(p_party_id uuid, p_seats integer) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.party_pool_allowed() then public.party_quote__ungated(p_party_id, p_seats) end
$$;

create or replace function public.party_menu_voting(p_party_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.party_pool_allowed() then public.party_menu_voting__ungated(p_party_id)
              else jsonb_build_object('configured', false) end
$$;

-- admins always get through here: the admin console reads the final menu with this function, whatever the switch says
create or replace function public.party_menu_final(p_party_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.party_pool_allowed() or exists (select 1 from public.admin_users a where a.id = auth.uid())
              then public.party_menu_final__ungated(p_party_id) end
$$;

create or replace function public.party_cast_vote(p_party_id uuid, p_category text, p_option_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.party_pool_allowed() then raise exception 'Voting is not open for this party.'; end if;
  return public.party_cast_vote__ungated(p_party_id, p_category, p_option_id);
end $$;

create or replace function public.party_my_booking(p_party_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.party_pool_allowed() then public.party_my_booking__ungated(p_party_id) end
$$;

create or replace function public.party_my_bookings() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.party_pool_allowed() then public.party_my_bookings__ungated() else '[]'::jsonb end
$$;

create or replace function public.party_my_invoices() returns setof public.party_invoices
language sql stable security definer set search_path = public as $$
  select * from public.party_my_invoices__ungated() where public.party_pool_allowed()
$$;

-- refuses BEFORE anything happens: no seat is held, no payment row is made, so the edge functions never ask a gateway for an order
create or replace function public.party_start_payment(p_party_id uuid, p_kind text, p_guests jsonb default null, p_accept boolean default false, p_terms_version integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.party_pool_allowed() then raise exception 'Parties are not available right now.'; end if;
  return public.party_start_payment__ungated(p_party_id, p_kind, p_guests, p_accept, p_terms_version);
end $$;

-- ---- grants: exactly what the originals had ---------------------------------------------------------------------------------------
revoke all on function public.party_public(uuid)                              from public, anon, authenticated;
revoke all on function public.party_quote(uuid, integer)                      from public, anon, authenticated;
revoke all on function public.party_menu_voting(uuid)                         from public, anon, authenticated;
revoke all on function public.party_menu_final(uuid)                          from public, anon, authenticated;
revoke all on function public.party_cast_vote(uuid, text, uuid)               from public, anon, authenticated;
revoke all on function public.party_my_booking(uuid)                          from public, anon, authenticated;
revoke all on function public.party_my_bookings()                             from public, anon, authenticated;
revoke all on function public.party_my_invoices()                             from public, anon, authenticated;
revoke all on function public.party_start_payment(uuid, text, jsonb, boolean, integer) from public, anon, authenticated;
grant execute on function public.party_public(uuid)                           to anon, authenticated;
grant execute on function public.party_quote(uuid, integer)                   to anon, authenticated;
grant execute on function public.party_menu_final(uuid)                       to anon, authenticated;
grant execute on function public.party_menu_voting(uuid)                      to authenticated;
grant execute on function public.party_cast_vote(uuid, text, uuid)            to authenticated;
grant execute on function public.party_my_booking(uuid)                       to authenticated;
grant execute on function public.party_my_bookings()                          to authenticated;
grant execute on function public.party_my_invoices()                          to authenticated;
grant execute on function public.party_start_payment(uuid, text, jsonb, boolean, integer) to authenticated;

-- Party Pool phase 5: "Add a new venue" for party-only venues.
-- A party-only venue is a normal row in public.venues (approved, NOT live, availability paused) that is also listed in
-- public.party_only_venues. It can host parties, but can never be published to customers as a bookable venue
-- (a trigger refuses is_live = true). Nothing in the existing booking flow is edited: no existing function, trigger,
-- policy or column is changed. Rollback: phase5-rollback.sql.

create table public.party_only_venues (
  venue_id   uuid primary key references public.venues(id) on delete restrict,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.party_only_venues enable row level security;
revoke all on public.party_only_venues from public, anon, authenticated;
grant select on public.party_only_venues to authenticated;
create policy party_only_venues_admin_read on public.party_only_venues
  for select to authenticated using (exists (select 1 from public.admin_users a where a.id = auth.uid()));

-- Refuses to publish a party-only venue. Runs only when is_live is being set to true.
create or replace function public.guard_party_only_venue_live()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.party_only_venues p where p.venue_id = new.id) then
    raise exception 'This venue is party-only, so it cannot be published to customers (is_live cannot be turned on). Use "Make a normal venue" first if it should take bookings.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_guard_party_only_venue_live
  before update of is_live on public.venues
  for each row when (new.is_live is true)
  execute function public.guard_party_only_venue_live();

-- Admin-only: create a party-only venue. Returns the venue id.
create or replace function public.admin_create_party_venue(
  p_name text, p_city text, p_area text default null, p_address text default null,
  p_maps text default null, p_phone text default null, p_allow_duplicate boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_admin uuid := auth.uid();
begin
  if v_admin is null or not exists (select 1 from public.admin_users where id = v_admin) then
    raise exception 'Admins only.' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_city), '') = '' then
    raise exception 'Venue name and city are required.' using errcode = 'P0001'; end if;
  if not coalesce(p_allow_duplicate, false) and public.managed_venue_duplicate(p_name, p_city) then
    raise exception 'A venue with this name already exists in this city.' using errcode = 'P0001'; end if;

  insert into public.venues (name, city, area, address, google_maps_url, contact_phone,
                             status, approved_at, reviewed_at, is_live, is_verified, venue_state, availability_mode, created_by)
  values (btrim(p_name), btrim(p_city), nullif(btrim(p_area), ''), nullif(btrim(p_address), ''),
          nullif(btrim(p_maps), ''), nullif(btrim(p_phone), ''),
          'approved', now(), now(), false, false, 'active', 'paused', v_admin)
  returning id into v_id;
  insert into public.party_only_venues (venue_id, created_by) values (v_id, v_admin);
  return v_id;
end $$;

-- Admin-only: turn a party-only venue into a normal (not yet live) venue. Same venue id, so its parties stay linked.
create or replace function public.admin_make_party_venue_normal(p_venue_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from public.admin_users where id = auth.uid()) then
    raise exception 'Admins only.' using errcode = '42501'; end if;
  delete from public.party_only_venues where venue_id = p_venue_id;
  return found;
end $$;

revoke all on function public.guard_party_only_venue_live() from public, anon, authenticated;
revoke all on function public.admin_create_party_venue(text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_make_party_venue_normal(uuid) from public, anon, authenticated;
grant execute on function public.admin_create_party_venue(text, text, text, text, text, text, boolean) to authenticated;
grant execute on function public.admin_make_party_venue_normal(uuid) to authenticated;

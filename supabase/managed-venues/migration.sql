-- Managed venues (PAXO creates and runs a venue's account until handover to the owner).
-- NOT APPLIED. Review first. Everything here is additive except the four replaced guards marked "CHANGES EXISTING BEHAVIOUR".

------------------------------------------------------------------------------------------------
-- 1. columns
------------------------------------------------------------------------------------------------
alter table public.venues
  add column managed_by_paxo   boolean not null default false,
  add column owner_contact_email text,          -- the owner's real address: stored, read by NO trigger or function until handover
  add column google_maps_url   text;

-- a login created by PAXO for a managed venue; the admin Customers tab and counts leave these out
alter table public.profiles
  add column is_managed_login boolean not null default false;
create index profiles_managed_login_idx on public.profiles (is_managed_login) where is_managed_login;

------------------------------------------------------------------------------------------------
-- 2. audit table (admins can read; only the service role writes)
------------------------------------------------------------------------------------------------
create table public.managed_venue_audit (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references public.venues(id),
  action               text not null check (action in ('create', 'reset_password', 'handover')),
  status               text not null default 'started'
                         check (status in ('started', 'email_changed', 'db_done', 'completed', 'failed')),
  admin_id             uuid not null references public.admin_users(id),
  login_user_id        uuid,
  previous_login_email text,
  new_email            text,
  request_id           uuid unique,            -- a double click / retry of "Add venue" returns the same venue
  emailed_at           timestamptz,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index managed_one_create_per_venue on public.managed_venue_audit (venue_id) where action = 'create';
create unique index managed_one_live_handover on public.managed_venue_audit (venue_id) where action = 'handover' and status <> 'failed';
create index managed_audit_login_idx on public.managed_venue_audit (login_user_id);
alter table public.managed_venue_audit enable row level security;
create policy managed_audit_admin_read on public.managed_venue_audit for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));
revoke all on public.managed_venue_audit from anon, authenticated;
grant select on public.managed_venue_audit to authenticated;     -- RLS limits it to admins; nobody but the service role can write

------------------------------------------------------------------------------------------------
-- 3. helper functions (service role only)
------------------------------------------------------------------------------------------------
-- has this account ever been a PAXO-managed login? (permanent: used to keep coupons away from it)
create function public.managed_is_login(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.managed_venue_audit where login_user_id = p_uid and action = 'create')
$$;

-- is this login address taken? (an existing account, or an address a managed login used before)
create function public.managed_login_email_taken(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users where lower(email) = lower(btrim(p_email)))
      or exists (select 1 from public.managed_venue_audit
                  where lower(coalesce(previous_login_email, '')) = lower(btrim(p_email))
                     or lower(coalesce(new_email, '')) = lower(btrim(p_email)))
$$;

-- does this address already belong to an account OTHER than p_except?
create function public.managed_email_in_use(p_email text, p_except uuid default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users where lower(email) = lower(btrim(p_email)) and id is distinct from p_except)
$$;

create function public.managed_venue_duplicate(p_name text, p_city text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.venues
                  where lower(btrim(name)) = lower(btrim(p_name)) and lower(btrim(city)) = lower(btrim(p_city)))
$$;

-- remove every session of a login (used when a managed login is handed over, and after a password reset)
create function public.managed_end_sessions(p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.sessions where user_id = p_uid;
end $$;

-- Creates the venue, links the login and writes the audit row in ONE transaction.
-- The auth user is created first by the edge function; if this fails the edge function deletes that user again.
create function public.managed_create_venue(
  p_admin uuid, p_request uuid, p_user uuid, p_login_email text,
  p_name text, p_venue_type text, p_city text, p_area text, p_address text, p_maps text, p_capacity integer,
  p_contact_person text, p_contact_phone text, p_owner_email text, p_gst_no text, p_allow_duplicate boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.admin_users where id = p_admin) then
    raise exception 'Admins only' using errcode = '42501'; end if;
  select venue_id into v_id from public.managed_venue_audit where request_id = p_request and action = 'create';
  if v_id is not null then return v_id; end if;                       -- same request again: same venue
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_city), '') = '' then
    raise exception 'Venue name and city are required.' using errcode = 'P0001'; end if;
  if not p_allow_duplicate and public.managed_venue_duplicate(p_name, p_city) then
    raise exception 'A venue with this name already exists in this city.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.admin_users where id = p_user) then
    raise exception 'An admin account cannot be a venue partner.' using errcode = 'P0001'; end if;

  insert into public.venues (
    name, venue_type, city, area, address, google_maps_url, guest_capacity,
    contact_person_name, contact_phone, business_email, owner_contact_email, gst_no,
    status, approved_at, reviewed_at, stage1_cleared_at, is_live, is_verified, venue_state,
    managed_by_paxo, created_by)
  values (
    btrim(p_name), nullif(btrim(p_venue_type), ''), btrim(p_city), nullif(btrim(p_area), ''), nullif(btrim(p_address), ''),
    nullif(btrim(p_maps), ''), p_capacity,
    nullif(btrim(p_contact_person), ''), nullif(btrim(p_contact_phone), ''), lower(btrim(p_login_email)),
    nullif(lower(btrim(p_owner_email)), ''), nullif(btrim(p_gst_no), ''),
    'approved', now(), now(), now(), false, false, 'active',
    true, p_admin)
  returning id into v_id;

  insert into public.partner_users (id, venue_id, full_name, phone)
  values (p_user, v_id, nullif(btrim(p_contact_person), ''), nullif(btrim(p_contact_phone), ''));

  update public.profiles set is_managed_login = true, full_name = coalesce(nullif(btrim(p_contact_person), ''), full_name)
   where id = p_user;

  insert into public.managed_venue_audit (venue_id, action, status, admin_id, login_user_id, new_email, request_id)
  values (v_id, 'create', 'completed', p_admin, p_user, lower(btrim(p_login_email)), p_request);
  return v_id;
end $$;

-- Handover, database half: business_email -> owner, flag off, login sessions ended. Safe to call twice.
create function public.managed_complete_handover(p_audit uuid, p_venue uuid, p_new_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v record; a record; v_uid uuid;
begin
  select * into a from public.managed_venue_audit where id = p_audit and venue_id = p_venue and action = 'handover' for update;
  if a.id is null then raise exception 'Unknown handover.' using errcode = 'P0001'; end if;
  if a.status in ('db_done', 'completed') then return; end if;
  select id, managed_by_paxo into v from public.venues where id = p_venue for update;
  if not v.managed_by_paxo then raise exception 'This venue is not managed by PAXO.' using errcode = 'P0001'; end if;
  select id into v_uid from public.partner_users where venue_id = p_venue;
  update public.venues set business_email = lower(btrim(p_new_email)), owner_contact_email = lower(btrim(p_new_email)),
         managed_by_paxo = false where id = p_venue;
  update public.profiles set is_managed_login = false where id = v_uid;
  delete from auth.sessions where user_id = v_uid;
  update public.managed_venue_audit set status = 'db_done', updated_at = now() where id = p_audit;
end $$;

revoke execute on function
  public.managed_is_login(uuid), public.managed_login_email_taken(text), public.managed_email_in_use(text, uuid),
  public.managed_venue_duplicate(text, text), public.managed_end_sessions(uuid),
  public.managed_create_venue(uuid, uuid, uuid, text, text, text, text, text, text, text, integer, text, text, text, text, boolean),
  public.managed_complete_handover(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.managed_is_login(uuid), public.managed_login_email_taken(text), public.managed_email_in_use(text, uuid),
  public.managed_venue_duplicate(text, text), public.managed_end_sessions(uuid),
  public.managed_create_venue(uuid, uuid, uuid, text, text, text, text, text, text, text, integer, text, text, text, text, boolean),
  public.managed_complete_handover(uuid, uuid, text)
  to service_role;

------------------------------------------------------------------------------------------------
-- 4. CHANGES EXISTING BEHAVIOUR
------------------------------------------------------------------------------------------------
-- 4a. a partner (including the managed login) can never change the managed flag or the owner's email
create or replace function public.guard_partner_venue_status_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and exists (select 1 from public.partner_users pu where pu.venue_id = new.id and pu.id = auth.uid())
     and (
       new.status is distinct from old.status
       or new.is_verified is distinct from old.is_verified
       or new.rejection_note is distinct from old.rejection_note
       or new.addons_enabled is distinct from old.addons_enabled
       or new.managed_by_paxo is distinct from old.managed_by_paxo
       or new.owner_contact_email is distinct from old.owner_contact_email
     )
  then
    raise exception 'Only PAXO can change this setting.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- 4b. a self-registered venue can never arrive already "managed"
create or replace function public.harden_venue_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.role() = 'service_role'
     or exists (select 1 from public.admin_users au where au.id = auth.uid()) then return new; end if;
  new.created_by := auth.uid();
  new.status := 'submitted'; new.is_live := false; new.is_verified := false; new.venue_state := 'active';
  new.on_hold := false; new.on_hold_reason := null; new.timeout_strike_count := 0;
  new.gst_verified := false; new.gst_verified_at := null; new.gst_verified_by := null;
  new.approved_at := null; new.reviewed_at := null; new.rejection_note := null;
  new.state_reason := null; new.state_changed_at := null; new.state_changed_by := null;
  new.addons_enabled := true;
  new.managed_by_paxo := false; new.owner_contact_email := null;
  return new;
end $$;

-- 4c. the managed flag on a profile is a system column
create or replace function public.enforce_profile_system_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or auth.role() = 'service_role'
     or exists (select 1 from public.admin_users au where au.id = auth.uid()) then return new; end if;
  if new.id is distinct from old.id or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at or new.rating_avg is distinct from old.rating_avg
     or new.is_managed_login is distinct from old.is_managed_login
     or (new.no_show_count is distinct from old.no_show_count
         and coalesce(current_setting('app.profile_counter', true), '') <> 'on') then
    raise exception 'This profile detail cannot be changed.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- 4d. no "Welcome to Paxo" customer email for PAXO's own plus-addresses (the function itself is untouched)
drop trigger trg_send_welcome_email on public.profiles;
create trigger trg_send_welcome_email after insert on public.profiles for each row
  when (new.email is not null and new.email not ilike 'paxoapp.in+%@gmail.com')
  execute function public.send_welcome_email();

-- 4e. coupons: a PAXO-managed login never gets a welcome coupon, a referral code, or a referral credit
create or replace function public.coupon_issue_for_user() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); s record; p record; v_code text; i int := 0; k int;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.managed_is_login(v_uid) then return jsonb_build_object('eligible', false); end if;
  select * into s from public.coupon_settings where id = 1;
  select id, created_at into p from public.profiles where id = v_uid;
  if p.id is null or p.created_at < s.launch_at then return jsonb_build_object('eligible', false); end if;

  select code into v_code from public.referral_codes where owner_id = v_uid;
  if v_code is null then
    loop
      i := i + 1; v_code := '';
      for k in 1..8 loop v_code := v_code || substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1); end loop;
      begin
        insert into public.referral_codes (owner_id, code) values (v_uid, v_code);
        exit;
      exception when unique_violation then
        select code into v_code from public.referral_codes where owner_id = v_uid;
        exit when v_code is not null or i >= 8;
      end;
    end loop;
  end if;

  perform public.coupon_check_cap();
  select * into s from public.coupon_settings where id = 1;
  if s.offers_enabled
     and not exists (select 1 from public.coupons where owner_id = v_uid and type = 'welcome')
     and not exists (select 1 from public.bookings where customer_id = v_uid and status in ('confirmed', 'completed', 'no_show')) then
    insert into public.coupons (owner_id, type, amount, expires_at)
    values (v_uid, 'welcome', null, now() + make_interval(days => s.welcome_valid_days))
    on conflict do nothing;
  end if;
  return jsonb_build_object('eligible', true, 'referral_code', v_code);
end $$;

create or replace function public.coupon_claim_referral(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); s record; me record; v_sharer uuid;
begin
  if v_uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if public.managed_is_login(v_uid) then return jsonb_build_object('ok', false, 'reason', 'not_eligible'); end if;
  select * into s from public.coupon_settings where id = 1;
  select id, created_at into me from public.profiles where id = v_uid;
  if me.id is null or me.created_at < s.launch_at then return jsonb_build_object('ok', false, 'reason', 'not_eligible'); end if;
  if now() - me.created_at > make_interval(hours => s.referral_claim_window_hours) then
    return jsonb_build_object('ok', false, 'reason', 'too_late'); end if;
  if exists (select 1 from public.referrals where friend_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_referred'); end if;
  if exists (select 1 from public.bookings where customer_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'has_booking'); end if;
  select owner_id into v_sharer from public.referral_codes where code = upper(trim(coalesce(p_code, '')));
  if v_sharer is null then return jsonb_build_object('ok', false, 'reason', 'invalid_code'); end if;
  if v_sharer = v_uid then return jsonb_build_object('ok', false, 'reason', 'own_code'); end if;
  if public.coupon_norm_email((select email from public.profiles where id = v_uid))
     = public.coupon_norm_email((select email from public.profiles where id = v_sharer)) then
    return jsonb_build_object('ok', false, 'reason', 'same_account'); end if;
  if public.coupon_phones_match(v_uid, v_sharer) then
    return jsonb_build_object('ok', false, 'reason', 'same_phone'); end if;
  insert into public.referrals (sharer_id, friend_id, code_used) values (v_sharer, v_uid, upper(trim(p_code)));
  return jsonb_build_object('ok', true);
end $$;
-- (grants on the two coupon functions are unchanged: create or replace keeps them)

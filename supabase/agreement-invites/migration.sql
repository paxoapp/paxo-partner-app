-- Partner Agreement by email link (no login). Migration name: venue_agreement_invites
-- Touches ONLY agreement tables, one private bucket and a small rate-limit table.
-- No payments, bookings or Party Pool objects are changed.

-- 1. New columns on agreement_acceptances (existing rows become accepted_via = 'app')
alter table public.agreement_acceptances
  add column accepted_by_name text,
  add column accepted_by_designation text,
  add column accepted_email text,
  add column accepted_via text not null default 'app';
alter table public.agreement_acceptances
  add constraint agreement_acceptances_accepted_via_check check (accepted_via in ('app', 'email_link'));

-- 2. Invites. Only the SHA-256 hash of the token is stored. RLS on, no policies, no grants:
--    customers, partners and admins cannot read or write it directly. Only the functions below can.
create table public.venue_agreement_invites (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  sent_to_email text not null,
  sent_to_name text,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_at timestamptz
);
create index venue_agreement_invites_venue_idx on public.venue_agreement_invites (venue_id, created_at desc);
alter table public.venue_agreement_invites enable row level security;
revoke all on public.venue_agreement_invites from public, anon, authenticated;

-- 3. Rate limit counters (fixed windows). Same lock-down.
create table public.public_rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
alter table public.public_rate_limits enable row level security;
revoke all on public.public_rate_limits from public, anon, authenticated;

-- 4. Functions. All SECURITY DEFINER, callable only by the edge functions (service_role).

-- true = allowed, false = over the limit. Old rows are swept now and then.
create or replace function public.agreement_rate_hit(p_key text, p_limit int, p_window_seconds int)
returns boolean language plpgsql security definer set search_path = public as $f$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n int;
begin
  insert into public_rate_limits (key, window_start, hits) values (left(p_key, 200), w, 1)
  on conflict (key, window_start) do update set hits = public_rate_limits.hits + 1
  returning hits into n;
  if random() < 0.02 then
    delete from public_rate_limits where window_start < now() - interval '1 day';
  end if;
  return n <= p_limit;
end $f$;

-- Admin (edge function has already checked the caller is an admin). Makes a new invite and cancels older unused ones.
create or replace function public.agreement_invite_create(p_venue_id uuid, p_token_hash text, p_email text, p_name text, p_admin uuid)
returns timestamptz language plpgsql security definer set search_path = public as $f$
declare exp timestamptz;
begin
  if not exists (select 1 from venues where id = p_venue_id) then raise exception 'Venue not found'; end if;
  if exists (select 1 from agreement_acceptances where venue_id = p_venue_id and checkpoint = 'final_agreement') then
    raise exception 'This venue has already accepted the agreement';
  end if;
  update venue_agreement_invites set expires_at = now()
   where venue_id = p_venue_id and used_at is null and expires_at > now();
  insert into venue_agreement_invites (venue_id, token_hash, sent_to_email, sent_to_name, created_by)
  values (p_venue_id, p_token_hash, lower(trim(p_email)), nullif(trim(p_name), ''), p_admin)
  returning expires_at into exp;
  return exp;
end $f$;

-- Public page: is this link usable? Venue name only comes back for a usable link.
create or replace function public.agreement_invite_check(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare r record;
begin
  select i.*, v.name as venue_name into r
    from venue_agreement_invites i join venues v on v.id = i.venue_id where i.token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  if r.used_at is not null
     or exists (select 1 from agreement_acceptances where venue_id = r.venue_id and checkpoint = 'final_agreement') then
    return jsonb_build_object('status', 'used');
  end if;
  if r.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  return jsonb_build_object('status', 'valid', 'venue_name', r.venue_name, 'sent_to_name', r.sent_to_name, 'expires_at', r.expires_at);
end $f$;

-- Accept: validate, insert the acceptance, mark the invite used. One function = one transaction.
create or replace function public.agreement_invite_accept(p_token_hash text, p_name text, p_designation text, p_ip text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare r record; acc_id uuid; acc_at timestamptz;
begin
  p_name := trim(coalesce(p_name, ''));
  p_designation := trim(coalesce(p_designation, ''));
  if char_length(p_name) < 2 or char_length(p_name) > 120 or p_name ~ '[[:cntrl:]]' then raise exception 'Please enter your full name'; end if;
  if char_length(p_designation) < 2 or char_length(p_designation) > 120 or p_designation ~ '[[:cntrl:]]' then raise exception 'Please enter your designation'; end if;

  select i.*, v.name as venue_name into r
    from venue_agreement_invites i join venues v on v.id = i.venue_id
   where i.token_hash = p_token_hash for update of i;
  if not found then raise exception 'This link is not valid'; end if;
  if r.used_at is not null then raise exception 'This link has already been used'; end if;
  if r.expires_at <= now() then raise exception 'This link has expired'; end if;
  if exists (select 1 from agreement_acceptances where venue_id = r.venue_id and checkpoint = 'final_agreement') then
    raise exception 'This link has already been used';
  end if;

  insert into agreement_acceptances (venue_id, checkpoint, policy_version, ip_address, device_info,
                                     accepted_by_name, accepted_by_designation, accepted_email, accepted_via)
  values (r.venue_id, 'final_agreement', 'v1', left(p_ip, 100), left(p_device, 500),
          p_name, p_designation, r.sent_to_email, 'email_link')
  returning id, accepted_at into acc_id, acc_at;
  update venue_agreement_invites set used_at = now() where id = r.id;

  return jsonb_build_object('acceptance_id', acc_id, 'venue_id', r.venue_id, 'venue_name', r.venue_name,
                            'email', r.sent_to_email, 'accepted_at', acc_at, 'name', p_name, 'designation', p_designation);
end $f$;

revoke execute on function public.agreement_rate_hit(text, int, int) from public, anon, authenticated;
revoke execute on function public.agreement_invite_create(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.agreement_invite_check(text) from public, anon, authenticated;
revoke execute on function public.agreement_invite_accept(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.agreement_rate_hit(text, int, int) to service_role;
grant execute on function public.agreement_invite_create(uuid, text, text, text, uuid) to service_role;
grant execute on function public.agreement_invite_check(text) to service_role;
grant execute on function public.agreement_invite_accept(text, text, text, text, text) to service_role;

-- 4b. Partners (the existing insert policy) may only write accepted_via = 'app'. 'email_link' is written only by
--     agreement_invite_accept (SECURITY DEFINER, service role).
alter policy agreement_acceptances_insert on public.agreement_acceptances
  with check (
    accepted_via = 'app'
    and exists (select 1 from partner_users pu where pu.venue_id = agreement_acceptances.venue_id and pu.id = (select auth.uid()))
  );

-- 5. Private bucket for the accepted-agreement PDFs. Only admins can read; nobody can write except the
--    edge function (service role bypasses policies). Path: <venue_id>/<acceptance_id>.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('venue-agreements', 'venue-agreements', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;
create policy venue_agreements_select_admin on storage.objects for select to authenticated
  using (bucket_id = 'venue-agreements' and exists (select 1 from public.admin_users au where au.id = auth.uid()));

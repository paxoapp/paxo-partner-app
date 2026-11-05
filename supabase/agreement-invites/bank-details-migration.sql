-- Bank details on the agreement link page. Migration name: venue_agreement_bank_step
-- Touches only the agreement-invite table, new functions, and one private bucket. No change to partner_bank_details'
-- structure or policies, and nothing in payments, bookings, settlements or Party Pool.

-- 1. The invite now also tracks the bank step, and an invite can be a "bank only" link (agreement already accepted).
alter table public.venue_agreement_invites
  add column purpose text not null default 'agreement' check (purpose in ('agreement', 'bank')),
  add column bank_status text not null default 'pending' check (bank_status in ('pending', 'skipped', 'added')),
  add column bank_done_at timestamptz,
  add column bank_proof_path text;

-- 2. Link check. Status values the page understands:
--    invalid | expired | used (nothing left to do) | valid (step 1: agreement) | bank (step 2: bank details only)
--    'bank' also carries the venue name. last4 is only returned once details exist, never the full number.
create or replace function public.agreement_invite_check(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare r record; accepted boolean; has_bank boolean;
begin
  select i.*, v.name as venue_name into r
    from venue_agreement_invites i join venues v on v.id = i.venue_id where i.token_hash = p_token_hash;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  accepted := exists (select 1 from agreement_acceptances where venue_id = r.venue_id and checkpoint = 'final_agreement');
  has_bank := exists (select 1 from partner_bank_details where venue_id = r.venue_id and coalesce(account_number, '') <> '');
  if r.expires_at <= now() then
    return jsonb_build_object('status', case when r.used_at is not null or r.bank_status = 'added' then 'used' else 'expired' end);
  end if;
  -- bank step: agreement already accepted (through this link or an earlier one), bank not added yet
  if accepted and (r.purpose = 'bank' or r.used_at is not null) and r.bank_status in ('pending', 'skipped') and not has_bank then
    return jsonb_build_object('status', 'bank', 'venue_name', r.venue_name, 'skipped_before', r.bank_status = 'skipped', 'expires_at', r.expires_at);
  end if;
  if r.purpose = 'agreement' and r.used_at is null and not accepted then
    return jsonb_build_object('status', 'valid', 'venue_name', r.venue_name, 'sent_to_name', r.sent_to_name, 'expires_at', r.expires_at);
  end if;
  return jsonb_build_object('status', 'used');
end $f$;

-- 3. Save bank details (service role only). First-time add only: it never overwrites details already on file.
create or replace function public.agreement_bank_save(
  p_token_hash text, p_holder text, p_account text, p_ifsc text, p_bank text, p_branch text, p_upi text, p_proof_path text)
returns jsonb language plpgsql security definer set search_path = public as $f$
declare r record; chk jsonb; ifsc text := upper(trim(coalesce(p_ifsc, ''))); acct text := trim(coalesce(p_account, ''));
        holder text := trim(coalesce(p_holder, '')); bank text := trim(coalesce(p_bank, '')); branch text := nullif(trim(coalesce(p_branch, '')), '');
        upi text := nullif(trim(coalesce(p_upi, '')), '');
begin
  select i.* into r from venue_agreement_invites i where i.token_hash = p_token_hash for update;
  if not found then raise exception 'This link is not valid'; end if;
  chk := agreement_invite_check(p_token_hash);
  if chk->>'status' <> 'bank' then raise exception 'Bank details cannot be added with this link'; end if;
  if char_length(holder) < 2 or char_length(holder) > 120 or holder ~ '[[:cntrl:]]' then raise exception 'Enter the account holder name'; end if;
  if acct !~ '^[0-9]{9,18}$' then raise exception 'Account number must be 9 to 18 digits'; end if;
  if ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' then raise exception 'Enter a valid IFSC code'; end if;
  if char_length(bank) < 2 or char_length(bank) > 120 or bank ~ '[[:cntrl:]]' then raise exception 'Enter the bank name'; end if;
  if branch is not null and (char_length(branch) > 120 or branch ~ '[[:cntrl:]]') then raise exception 'Branch name is too long'; end if;
  if upi is not null and upi !~ '^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9]{1,63}$' then raise exception 'Enter a valid UPI ID'; end if;
  if p_proof_path is not null and p_proof_path !~ ('^' || r.venue_id::text || '/[A-Za-z0-9._-]{1,100}$') then raise exception 'Invalid upload'; end if;

  insert into partner_bank_details (venue_id, account_holder_name, account_number, ifsc_code, bank_name, branch_name, upi_id, updated_at)
  values (r.venue_id, holder, acct, ifsc, bank, branch, upi, now());   -- primary key = venue_id: a second add would conflict
  update venue_agreement_invites set bank_status = 'added', bank_done_at = now(), bank_proof_path = p_proof_path where id = r.id;
  return jsonb_build_object('venue_id', r.venue_id, 'last4', right(acct, 4));
end $f$;

-- 4. Skip for now.
create or replace function public.agreement_bank_skip(p_token_hash text)
returns void language plpgsql security definer set search_path = public as $f$
begin
  if agreement_invite_check(p_token_hash)->>'status' <> 'bank' then raise exception 'Nothing to skip'; end if;
  update venue_agreement_invites set bank_status = 'skipped' where token_hash = p_token_hash;
end $f$;

-- 5. Admin: a bank-only link for a venue that has accepted but has no bank details. Cancels older unused links.
create or replace function public.agreement_bank_invite_create(p_venue_id uuid, p_token_hash text, p_email text, p_name text, p_admin uuid)
returns timestamptz language plpgsql security definer set search_path = public as $f$
declare exp timestamptz;
begin
  if not exists (select 1 from venues where id = p_venue_id) then raise exception 'Venue not found'; end if;
  if not exists (select 1 from agreement_acceptances where venue_id = p_venue_id and checkpoint = 'final_agreement') then
    raise exception 'This venue has not accepted the agreement yet';
  end if;
  if exists (select 1 from partner_bank_details where venue_id = p_venue_id and coalesce(account_number, '') <> '') then
    raise exception 'This venue already has bank details';
  end if;
  update venue_agreement_invites set expires_at = now()
   where venue_id = p_venue_id and expires_at > now() and bank_status in ('pending', 'skipped');
  insert into venue_agreement_invites (venue_id, token_hash, sent_to_email, sent_to_name, created_by, purpose)
  values (p_venue_id, p_token_hash, lower(trim(p_email)), nullif(trim(p_name), ''), p_admin, 'bank')
  returning expires_at into exp;
  return exp;
end $f$;

revoke execute on function public.agreement_invite_check(text) from public, anon, authenticated;
revoke execute on function public.agreement_bank_save(text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.agreement_bank_skip(text) from public, anon, authenticated;
revoke execute on function public.agreement_bank_invite_create(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.agreement_invite_check(text) to service_role;
grant execute on function public.agreement_bank_save(text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.agreement_bank_skip(text) to service_role;
grant execute on function public.agreement_bank_invite_create(uuid, text, text, text, uuid) to service_role;

-- 6. Private bucket for cancelled cheque / passbook photos: admin can read, nobody else. Written only by the edge function.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('venue-bank-proofs', 'venue-bank-proofs', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;
create policy venue_bank_proofs_select_admin on storage.objects for select to authenticated
  using (bucket_id = 'venue-bank-proofs' and exists (select 1 from public.admin_users au where au.id = auth.uid()));

-- 7. "Link-added, not yet verified" tag. Purely informational: nothing (settlements, payouts, bookings) reads it.
alter table public.venue_agreement_invites
  add column bank_verified_at timestamptz,
  add column bank_verified_by uuid;

-- Admin only (checked inside; anon and non-admins are refused). For a list of venues: when the link-added bank details
-- arrived and whether an admin has marked them verified. Venues whose details were not added through a link are absent.
create or replace function public.admin_bank_link_status(p_venue_ids uuid[])
returns table (vid uuid, added_at timestamptz, verified_at timestamptz)
language plpgsql security definer set search_path = public as $f$
begin
  if not exists (select 1 from admin_users au where au.id = auth.uid()) then raise exception 'Admin access required'; end if;
  return query
    select distinct on (i.venue_id) i.venue_id, i.bank_done_at, i.bank_verified_at
      from venue_agreement_invites i
     where i.venue_id = any (p_venue_ids) and i.bank_status = 'added'
     order by i.venue_id, i.bank_done_at desc;
end $f$;

create or replace function public.admin_bank_mark_verified(p_venue_id uuid)
returns void language plpgsql security definer set search_path = public as $f$
declare iid uuid;
begin
  if not exists (select 1 from admin_users au where au.id = auth.uid()) then raise exception 'Admin access required'; end if;
  select i.id into iid from venue_agreement_invites i
   where i.venue_id = p_venue_id and i.bank_status = 'added' order by i.bank_done_at desc limit 1;
  if iid is null then raise exception 'No link-added bank details to verify'; end if;
  update venue_agreement_invites set bank_verified_at = now(), bank_verified_by = auth.uid() where id = iid and bank_verified_at is null;
end $f$;

revoke execute on function public.admin_bank_link_status(uuid[]) from public, anon;
revoke execute on function public.admin_bank_mark_verified(uuid) from public, anon;
grant execute on function public.admin_bank_link_status(uuid[]) to authenticated;
grant execute on function public.admin_bank_mark_verified(uuid) to authenticated;

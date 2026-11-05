-- Partner Agreement v2. Migration name: agreement_v2_policy_version
-- Only change: new acceptances through the email link are stored as policy_version 'v2'.
-- Existing rows (Illusion, v1) are not touched. The login gate (app) sends 'v2' itself. No payments, bookings or Party Pool objects.
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
  values (r.venue_id, 'final_agreement', 'v2', left(p_ip, 100), left(p_device, 500),
          p_name, p_designation, r.sent_to_email, 'email_link')
  returning id, accepted_at into acc_id, acc_at;
  update venue_agreement_invites set used_at = now() where id = r.id;

  return jsonb_build_object('acceptance_id', acc_id, 'venue_id', r.venue_id, 'venue_name', r.venue_name,
                            'email', r.sent_to_email, 'accepted_at', acc_at, 'name', p_name, 'designation', p_designation);
end $f$;

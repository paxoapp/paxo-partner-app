
do $t$
declare
  adm uuid := '1e90769e-84b7-4d7e-aaa0-260bb1dc5f77';
  bv uuid := '03a1f9ad-68e0-44fa-a625-89470acf8e74'; -- Beerlin (not accepted)
  iv uuid := '5a81eaee-8427-40db-b1ab-ea2537e09f52'; -- Illusion (already accepted)
  h1 text := repeat('a', 64); h2 text := repeat('b', 64); h3 text := repeat('c', 64);
  res jsonb; out text[] := '{}'; ok boolean; n int; msg text; exp timestamptz;
begin
  -- direct access denied for anon and authenticated
  set local role anon;
  begin perform 1 from venue_agreement_invites; out := out || 'FAIL anon read'; exception when insufficient_privilege then out := out || 'PASS anon cannot read invites'; end;
  begin perform agreement_invite_check(h1); out := out || 'FAIL anon fn'; exception when insufficient_privilege then out := out || 'PASS anon cannot call functions'; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform 1 from venue_agreement_invites; out := out || 'FAIL admin read'; exception when insufficient_privilege then out := out || 'PASS even admin cannot read invites directly'; end;
  begin perform 1 from public_rate_limits; out := out || 'FAIL rl read'; exception when insufficient_privilege then out := out || 'PASS rate table locked'; end;
  begin perform agreement_invite_create(bv, h1, 'a@b.co', 'x', adm); out := out || 'FAIL auth fn'; exception when insufficient_privilege then out := out || 'PASS authenticated cannot call functions'; end;
  select count(*) into n from agreement_acceptances where venue_id = iv;
  out := out || (case when n > 0 then 'PASS admin can read acceptances' else 'FAIL admin acceptances' end);
  select count(*) into n from storage.buckets where id = 'venue-agreements' and public = false;
  reset role;

  -- create / check
  exp := agreement_invite_create(bv, h1, ' Owner@Example.com ', 'Tusher', adm);
  out := out || (case when exp between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour' then 'PASS expiry is 14 days' else 'FAIL expiry '||exp end);
  out := out || (case when (select sent_to_email from venue_agreement_invites where token_hash = h1) = 'owner@example.com' then 'PASS email lowercased' else 'FAIL email' end);
  res := agreement_invite_check(h1);
  out := out || (case when res->>'status' = 'valid' and res->>'venue_name' = 'Beerlin' then 'PASS valid link shows venue' else 'FAIL check '||res end);
  out := out || (case when agreement_invite_check(h3)->>'status' = 'invalid' and not (agreement_invite_check(h3) ? 'venue_name') then 'PASS unknown token invalid, no venue name' else 'FAIL invalid' end);

  -- already accepted venue cannot get an invite
  begin perform agreement_invite_create(iv, h3, 'a@b.co', 'x', adm); out := out || 'FAIL invite for accepted venue'; exception when others then out := out || 'PASS no invite for accepted venue'; end;

  -- resend cancels the older link
  perform agreement_invite_create(bv, h2, 'owner@example.com', 'Tusher', adm);
  out := out || (case when agreement_invite_check(h1)->>'status' = 'expired' and agreement_invite_check(h2)->>'status' = 'valid' then 'PASS resend cancels old link' else 'FAIL resend' end);

  -- bad input rejected, and nothing written
  begin perform agreement_invite_accept(h2, 'A', 'Owner', '1.2.3.4', 'ua'); out := out || 'FAIL short name'; exception when others then out := out || 'PASS short name rejected'; end;
  begin perform agreement_invite_accept(h2, 'Ravi Kumar', '', '1.2.3.4', 'ua'); out := out || 'FAIL empty designation'; exception when others then out := out || 'PASS empty designation rejected'; end;
  begin perform agreement_invite_accept(h1, 'Ravi Kumar', 'Owner', '1.2.3.4', 'ua'); out := out || 'FAIL expired accept'; exception when others then get stacked diagnostics msg = message_text; out := out || (case when msg like '%expired%' then 'PASS expired link refused' else 'FAIL expired msg '||msg end); end;
  begin perform agreement_invite_accept(h3, 'Ravi Kumar', 'Owner', '1.2.3.4', 'ua'); out := out || 'FAIL unknown accept'; exception when others then out := out || 'PASS unknown link refused'; end;
  select count(*) into n from agreement_acceptances where venue_id = bv;
  out := out || (case when n = 0 then 'PASS nothing written by failed attempts' else 'FAIL leaked '||n end);

  -- accept
  res := agreement_invite_accept(h2, '  Ravi Kumar ', 'Director', '1.2.3.4', 'Mozilla/5.0');
  out := out || (case when res->>'venue_name' = 'Beerlin' and res->>'email' = 'owner@example.com' then 'PASS accept returns details' else 'FAIL accept '||res end);
  out := out || (case when exists (select 1 from agreement_acceptances where venue_id = bv and checkpoint = 'final_agreement' and policy_version = 'v1'
        and accepted_via = 'email_link' and accepted_by_name = 'Ravi Kumar' and accepted_by_designation = 'Director'
        and accepted_email = 'owner@example.com' and ip_address = '1.2.3.4' and device_info = 'Mozilla/5.0') then 'PASS acceptance row complete' else 'FAIL acceptance row' end);
  out := out || (case when (select used_at from venue_agreement_invites where token_hash = h2) is not null then 'PASS invite marked used' else 'FAIL used_at' end);
  out := out || (case when agreement_invite_check(h2)->>'status' = 'used' then 'PASS used link reports used' else 'FAIL used check' end);
  begin perform agreement_invite_accept(h2, 'Ravi Kumar', 'Director', '1.2.3.4', 'ua'); out := out || 'FAIL double accept'; exception when others then out := out || 'PASS second accept refused'; end;
  select count(*) into n from agreement_acceptances where venue_id = bv and checkpoint = 'final_agreement';
  out := out || (case when n = 1 then 'PASS exactly one acceptance row' else 'FAIL rows '||n end);
  begin perform agreement_invite_create(bv, h3, 'a@b.co', 'x', adm); out := out || 'FAIL invite after accept'; exception when others then out := out || 'PASS no new invite after accept'; end;

  -- existing app rows keep working: default accepted_via
  out := out || (case when (select accepted_via from agreement_acceptances where venue_id = iv and checkpoint = 'final_agreement' limit 1) = 'app' then 'PASS old rows are app' else 'FAIL old rows' end);

  -- rate limit: 3 allowed, 4th blocked, other key unaffected
  ok := agreement_rate_hit('t:ip1', 3, 600); ok := agreement_rate_hit('t:ip1', 3, 600); ok := agreement_rate_hit('t:ip1', 3, 600);
  out := out || (case when ok then 'PASS 3rd hit allowed' else 'FAIL 3rd' end);
  out := out || (case when not agreement_rate_hit('t:ip1', 3, 600) then 'PASS 4th hit blocked' else 'FAIL 4th' end);
  out := out || (case when agreement_rate_hit('t:ip2', 3, 600) then 'PASS other key unaffected' else 'FAIL other' end);

  -- bucket and policy
  select count(*) into n from storage.buckets where id = 'venue-agreements' and public = false;
  out := out || (case when n = 1 then 'PASS bucket private' else 'FAIL bucket' end);
  select count(*) into n from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'venue_agreements_select_admin';
  out := out || (case when n = 1 then 'PASS admin-only read policy' else 'FAIL policy' end);

  raise exception 'ROLLBACK_RESULTS %', array_to_string(out, E'\n');
end $t$;

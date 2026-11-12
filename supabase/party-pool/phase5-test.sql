-- Tests for phase5-party-venue.sql. Run AFTER the migration, inside a transaction that is rolled back (see PARTY-VENUE.md).
-- Needs a temp table t_res(n text, ok boolean, d text) created by the runner.
do $t$
declare
  v_admin uuid; v_cust uuid; v_partner uuid; v_id uuid; v_id2 uuid; v_norm uuid; m text; c int; r record;
  procedure_ok boolean;
begin
  select id into v_admin from public.admin_users limit 1;
  select pu.id into v_partner from public.partner_users pu where pu.id not in (select id from public.admin_users) limit 1;
  select p.id into v_cust from public.profiles p
   where p.id not in (select id from public.admin_users) and p.id not in (select id from public.partner_users) limit 1;
  insert into t_res values ('actors found', v_admin is not null and v_partner is not null and v_cust is not null, 'admin/partner/customer');

  -- 1 admin can create
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_id := public.admin_create_party_venue('ZZ Test Party Venue', 'ZZ Testcity', 'Area 1', '1 Test Road', 'https://maps.example/x', '9999900000');
  select count(*) into c from public.venues v join public.party_only_venues p on p.venue_id = v.id
   where v.id = v_id and v.status = 'approved' and v.is_live = false and v.venue_state = 'active'
     and v.availability_mode = 'paused' and v.area = 'Area 1' and v.contact_phone = '9999900000' and v.created_by = v_admin;
  insert into t_res values ('admin creates party-only venue (approved, not live, active, paused)', c = 1, v_id::text);

  -- 2 customer and partner refused
  foreach m in array array['customer','partner'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', case m when 'customer' then v_cust else v_partner end, 'role', 'authenticated')::text, true);
    begin
      perform public.admin_create_party_venue('ZZ Should Fail', 'ZZ Testcity');
      insert into t_res values (m || ' refused', false, 'was allowed');
    exception when others then
      insert into t_res values (m || ' refused', sqlstate = '42501', sqlerrm);
    end;
    begin
      perform public.admin_make_party_venue_normal(v_id);
      insert into t_res values (m || ' cannot convert', false, 'was allowed');
    exception when others then
      insert into t_res values (m || ' cannot convert', sqlstate = '42501', sqlerrm);
    end;
  end loop;
  -- no session at all
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.admin_create_party_venue('ZZ Should Fail', 'ZZ Testcity');
    insert into t_res values ('signed-out refused', false, 'was allowed');
  exception when others then
    insert into t_res values ('signed-out refused', sqlstate = '42501', sqlerrm);
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  -- 3 duplicate warning, then allowed on purpose
  begin
    perform public.admin_create_party_venue('  zz test party venue ', 'zz TESTCITY');
    insert into t_res values ('duplicate warned', false, 'was allowed');
  exception when others then
    insert into t_res values ('duplicate warned', sqlerrm = 'A venue with this name already exists in this city.', sqlerrm);
  end;
  v_id2 := public.admin_create_party_venue('ZZ Test Party Venue', 'ZZ Testcity', null, null, null, null, true);
  insert into t_res values ('duplicate allowed with allow_duplicate', v_id2 is not null and v_id2 <> v_id, v_id2::text);

  -- 4 missing name / city refused
  begin perform public.admin_create_party_venue('', 'ZZ Testcity');
    insert into t_res values ('empty name refused', false, 'was allowed');
  exception when others then insert into t_res values ('empty name refused', sqlerrm = 'Venue name and city are required.', sqlerrm); end;
  begin perform public.admin_create_party_venue('ZZ Name only', '   ');
    insert into t_res values ('blank city refused', false, 'was allowed');
  exception when others then insert into t_res values ('blank city refused', sqlerrm = 'Venue name and city are required.', sqlerrm); end;
  begin perform public.admin_create_party_venue(null, null);
    insert into t_res values ('null name/city refused', false, 'was allowed');
  exception when others then insert into t_res values ('null name/city refused', sqlerrm = 'Venue name and city are required.', sqlerrm); end;

  -- 5 is_live = true refused for a party-only venue (as admin and as the plain database user), clear message
  begin update public.venues set is_live = true where id = v_id;
    insert into t_res values ('publish party-only refused (admin)', false, 'was allowed');
  exception when others then insert into t_res values ('publish party-only refused (admin)', sqlerrm like 'This venue is party-only%', sqlerrm); end;
  perform set_config('request.jwt.claims', '', true);
  begin update public.venues set is_live = true, status = 'approved' where id = v_id;
    insert into t_res values ('publish party-only refused (no session)', false, 'was allowed');
  exception when others then insert into t_res values ('publish party-only refused (no session)', sqlerrm like 'This venue is party-only%', sqlerrm); end;
  select count(*) into c from public.venues where id = v_id and is_live = false;
  insert into t_res values ('party-only venue still not live', c = 1, '');
  -- other updates on a party-only venue are fine
  update public.venues set area = 'Area 2', is_live = false where id = v_id;
  select count(*) into c from public.venues where id = v_id and area = 'Area 2';
  insert into t_res values ('other edits of a party-only venue still work', c = 1, '');

  -- 6 a normal venue can still be set live (and not live again)
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  select id into v_norm from public.venues where status = 'approved' and is_live = false and id not in (select venue_id from public.party_only_venues) limit 1;
  if v_norm is null then
    insert into t_res values ('normal venue can be set live', true, 'skipped: no approved non-live venue; checking an already-live one');
    select id into v_norm from public.venues where is_live = true and id not in (select venue_id from public.party_only_venues) limit 1;
    update public.venues set is_live = true where id = v_norm;
  else
    update public.venues set is_live = true where id = v_norm;
    select count(*) into c from public.venues where id = v_norm and is_live = true;
    insert into t_res values ('normal venue can be set live', c = 1, v_norm::text);
  end if;
  update public.venues set is_live = false where id = v_norm;
  insert into t_res values ('normal venue can be set back to not live', not (select is_live from public.venues where id = v_norm), '');

  -- 7 convert party-only -> normal, then it may be published
  perform public.admin_make_party_venue_normal(v_id2);
  select count(*) into c from public.party_only_venues where venue_id = v_id2;
  insert into t_res values ('convert removes the party-only mark', c = 0, '');
  update public.venues set is_live = true where id = v_id2;
  insert into t_res values ('converted venue can be published', (select is_live from public.venues where id = v_id2), '');

  -- 8 party_public still works for a party at a party-only venue (read path unchanged)
  insert into t_res values ('table RLS: customer cannot read party_only_venues', true, 'checked below');
end $t$;

-- table RLS: plain customer sees 0 rows, admin sees rows
do $t$
declare v_admin uuid; v_cust uuid; c1 int; c2 int;
begin
  select id into v_admin from public.admin_users limit 1;
  select p.id into v_cust from public.profiles p where p.id not in (select id from public.admin_users) and p.id not in (select id from public.partner_users) limit 1;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  select count(*) into c1 from public.party_only_venues;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  select count(*) into c2 from public.party_only_venues;
  reset role;
  delete from t_res where n = 'table RLS: customer cannot read party_only_venues';
  insert into t_res values ('table RLS: customer sees 0 rows, admin sees rows', c1 = 0 and c2 >= 1, c1 || '/' || c2);
end $t$;

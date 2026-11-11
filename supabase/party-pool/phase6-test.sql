-- Tests for phase6-party-visibility.sql. Run AFTER the migration inside a transaction that is rolled back.
-- Needs t_res(n text, ok boolean, d text) and s_ps (snapshot of platform_settings as jsonb) from the runner.
do $t$
declare
  v_admin uuid; v_tester uuid; v_cust uuid; v_party uuid; c int; m text; msg text;
  v_pay0 int; v_seat0 int; v_book0 int; fn text; allowed boolean;
  guests jsonb := '[{"name":"Test Guest","age":30,"gender":"female"}]';
begin
  select id into v_admin from public.admin_users limit 1;
  select p.id into v_tester from public.profiles p where p.id not in (select id from public.admin_users) and p.account_state = 'active' order by p.id limit 1;
  select p.id into v_cust from public.profiles p where p.id not in (select id from public.admin_users) and p.id <> v_tester and p.account_state = 'active' order by p.id limit 1;
  select id into v_party from public.parties where status = 'published' limit 1;
  insert into t_res values ('actors and a published party found', v_admin is not null and v_tester is not null and v_cust is not null and v_party is not null, '');

  insert into t_res values ('default is off', (select party_pool_visibility from public.platform_settings limit 1) = 'off', '');
  insert into t_res values ('column default is off', (select column_default from information_schema.columns where table_name = 'platform_settings' and column_name = 'party_pool_visibility') like '''off''%', '');
  begin
    update public.platform_settings set party_pool_visibility = 'maybe';
    insert into t_res values ('invalid value refused', false, 'accepted');
  exception when check_violation then
    insert into t_res values ('invalid value refused', true, '');
  end;
  insert into t_res values ('other platform_settings columns unchanged by the migration',
    (select to_jsonb(ps) - 'party_pool_visibility' from public.platform_settings ps limit 1) = (select j from s_ps), '');

  insert into public.party_pool_testers (user_id, note) values (v_tester, 'test');
  select count(*) into v_pay0 from public.party_payments;
  select count(*) into v_seat0 from public.party_seats;
  select count(*) into v_book0 from public.party_bookings;

  foreach m in array array['off', 'testers', 'all'] loop
    update public.platform_settings set party_pool_visibility = m;
    foreach fn in array array['signed_out', 'customer', 'tester', 'admin'] loop
      perform set_config('request.jwt.claims',
        case fn when 'signed_out' then '' else json_build_object('sub', case fn when 'customer' then v_cust when 'tester' then v_tester else v_admin end, 'role', 'authenticated')::text end, true);
      allowed := case m when 'all' then true when 'off' then false else fn in ('tester', 'admin') end;
      insert into t_res values (m||'/'||fn||': party_pool_access = '||allowed, public.party_pool_access() is not distinct from allowed, '');
      select count(*) into c from public.party_public();
      insert into t_res values (m||'/'||fn||': party_public '||case when allowed then 'lists parties' else 'returns nothing' end, (c > 0) = allowed, c::text);
      select count(*) into c from public.party_public(v_party);
      insert into t_res values (m||'/'||fn||': party_public(id)', (c > 0) = allowed, c::text);
      insert into t_res values (m||'/'||fn||': party_quote', (public.party_quote(v_party, 1) is not null) = allowed, '');
      insert into t_res values (m||'/'||fn||': party_menu_voting', allowed or (public.party_menu_voting(v_party)->>'configured')::boolean = false, '');
      insert into t_res values (m||'/'||fn||': party_my_bookings', allowed or public.party_my_bookings() = '[]'::jsonb, '');
      select count(*) into c from public.party_my_invoices();
      insert into t_res values (m||'/'||fn||': party_my_invoices empty when blocked', allowed or c = 0, c::text);
      insert into t_res values (m||'/'||fn||': party_my_booking null when blocked', allowed or public.party_my_booking(v_party) is null, '');
      begin
        perform public.party_start_payment(v_party, 'join', guests, true, (select terms_version from public.parties where id = v_party));
        insert into t_res values (m||'/'||fn||': party_start_payment', allowed, 'started (rolled back later)');
      exception when others then
        msg := sqlerrm;
        insert into t_res values (m||'/'||fn||': party_start_payment', case when allowed then msg not like 'Parties are not available%' else msg = 'Parties are not available right now.' end, msg);
      end;
      begin
        perform public.party_cast_vote(v_party, 'main_veg', null);
        insert into t_res values (m||'/'||fn||': party_cast_vote', allowed, 'voted?');
      exception when others then
        insert into t_res values (m||'/'||fn||': party_cast_vote', allowed or sqlerrm = 'Voting is not open for this party.', sqlerrm);
      end;
    end loop;
    if m = 'off' then
      select count(*) into c from public.party_payments;
      insert into t_res values ('off: no party_payments row created', c = v_pay0, c||' vs '||v_pay0);
      select count(*) into c from public.party_seats;
      insert into t_res values ('off: no seat held', c = v_seat0, c||' vs '||v_seat0);
      select count(*) into c from public.party_bookings;
      insert into t_res values ('off: no party_bookings row created', c = v_book0, c||' vs '||v_book0);
    end if;
  end loop;

  update public.platform_settings set party_pool_visibility = 'off';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    perform public.party_menu_final(v_party);
    insert into t_res values ('off: admin console can still call party_menu_final', true, '');
  exception when others then
    insert into t_res values ('off: admin console can still call party_menu_final', false, sqlerrm);
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  insert into t_res values ('off: a customer gets nothing from party_menu_final', public.party_menu_final(v_party) is null, '');

  foreach fn in array array['party_public__ungated(uuid)', 'party_quote__ungated(uuid,integer)', 'party_menu_voting__ungated(uuid)', 'party_menu_final__ungated(uuid)',
      'party_cast_vote__ungated(uuid,text,uuid)', 'party_my_booking__ungated(uuid)', 'party_my_bookings__ungated()', 'party_my_invoices__ungated()',
      'party_start_payment__ungated(uuid,text,jsonb,boolean,integer)'] loop
    insert into t_res values ('closed to customers: '||fn, not has_function_privilege('anon', 'public.'||fn, 'execute') and not has_function_privilege('authenticated', 'public.'||fn, 'execute'), '');
  end loop;
  insert into t_res values ('grants: anon may call party_public, party_quote, party_menu_final, party_pool_access',
    has_function_privilege('anon', 'public.party_public(uuid)', 'execute') and has_function_privilege('anon', 'public.party_quote(uuid,integer)', 'execute')
    and has_function_privilege('anon', 'public.party_menu_final(uuid)', 'execute') and has_function_privilege('anon', 'public.party_pool_access()', 'execute'), '');
  insert into t_res values ('grants: anon may NOT call the signed-in-only functions',
    not has_function_privilege('anon', 'public.party_start_payment(uuid,text,jsonb,boolean,integer)', 'execute') and not has_function_privilege('anon', 'public.party_menu_voting(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.party_cast_vote(uuid,text,uuid)', 'execute') and not has_function_privilege('anon', 'public.party_my_booking(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.party_my_bookings()', 'execute') and not has_function_privilege('anon', 'public.party_my_invoices()', 'execute'), '');
  insert into t_res values ('grants: nobody can call party_pool_allowed directly',
    not has_function_privilege('anon', 'public.party_pool_allowed()', 'execute') and not has_function_privilege('authenticated', 'public.party_pool_allowed()', 'execute'), '');
  insert into t_res values ('grants: authenticated may call the nine gated functions',
    has_function_privilege('authenticated', 'public.party_start_payment(uuid,text,jsonb,boolean,integer)', 'execute') and has_function_privilege('authenticated', 'public.party_public(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.party_my_invoices()', 'execute') and has_function_privilege('authenticated', 'public.party_cast_vote(uuid,text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.party_quote(uuid,integer)', 'execute') and has_function_privilege('authenticated', 'public.party_menu_voting(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.party_menu_final(uuid)', 'execute') and has_function_privilege('authenticated', 'public.party_my_booking(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.party_my_bookings()', 'execute'), '');
end $t$;

do $t$
declare v_admin uuid; v_cust uuid; c1 int; c2 int; changed int := -1;
begin
  select id into v_admin from public.admin_users limit 1;
  select p.id into v_cust from public.profiles p where p.id not in (select id from public.admin_users) order by p.id limit 1;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  select count(*) into c1 from public.party_pool_testers;
  update public.platform_settings set party_pool_visibility = 'all';
  get diagnostics changed = row_count;
  begin
    insert into public.party_pool_testers (user_id) values (v_cust);
    c1 := c1 + 1000;
  exception when others then
    null;
  end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  select count(*) into c2 from public.party_pool_testers;
  reset role;
  insert into t_res values ('customer cannot read the tester list, add to it, or change the setting', c1 = 0 and changed = 0, 'read '||c1||' changed '||changed);
  insert into t_res values ('admin can read the tester list', c2 >= 1, c2::text);
end $t$;

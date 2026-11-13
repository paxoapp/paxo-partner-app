-- Tests for phase7-receipts.sql. Run AFTER the migration inside a transaction that is rolled back (see the runner in the report).
-- Needs from the runner: t_res(n text, ok boolean, d text), t_mail(to_customer uuid, type text, data jsonb, key text) filled by a
-- stand-in for party_email() (so NO real email can leave), and s_data (hash of party_payments without the two new columns, taken before the migration).
do $t$
declare
  v_cust uuid; v_cust2 uuid; v_cust3 uuid; v_admin uuid;
  v_p2 uuid := '7fbf1804-d3a6-4711-a29e-5fbe7466aae8'; v_p3 uuid := '618f41a3-756d-4aa4-b076-4f6c824e914b';
  v_old uuid := '6d63229b-0669-47c4-a29f-fc2eedde42eb';
  tv int; r jsonb; pay1 uuid; pay2 uuid; payb uuid; payf uuid; payl uuid; payx uuid; pay8 uuid; bk uuid;
  rd jsonb; rr jsonb; c int; m0 int; res text; amt numeric; def_build text; def_stub text;
  g1 jsonb := '[{"name":"Receipt Guest One","age":30,"gender":"female"}]';
  g2 jsonb := '[{"name":"Receipt Guest Two","age":31,"gender":"male"}]';
  g3 jsonb := '[{"name":"Receipt Guest Three","age":29,"gender":"female"}]';
begin
  select id into v_admin from public.admin_users limit 1;
  select jsonb_agg(id) into strict r from (select to_jsonb(p.id) as id from public.profiles p
     where p.id not in (select id from public.admin_users) and p.account_state = 'active'
       and p.id not in (select customer_id from public.party_bookings) order by p.id limit 3) q;
  v_cust := (r->>0)::uuid; v_cust2 := (r->>1)::uuid; v_cust3 := (r->>2)::uuid;
  select terms_version into tv from public.parties where id = v_p3;
  insert into t_res values ('actors found', v_admin is not null and v_cust3 is not null and tv is not null, '');
  update public.platform_settings set party_pool_visibility = 'all';

  -- ---------------- the migration itself ----------------
  insert into t_res values ('migration left every other party_payments row byte-for-byte as it was',
    (select md5(coalesce(string_agg(md5((to_jsonb(x) - 'receipt_no' - 'receipt_data')::text), ',' order by x.id), '')) from public.party_payments x) = (select h from s_data), '');
  insert into t_res values ('backfill and migration sent no email at all', (select count(*) from t_mail) = 0, (select count(*) from t_mail)::text);
  select receipt_no, receipt_data into res, rd from public.party_payments where id = v_old;
  insert into t_res values ('backfill: the one paid deposit is numbered PR-000001', res = 'PR-000001', coalesce(res, 'null'));
  insert into t_res values ('backfill: nothing else is numbered', (select count(*) from public.party_payments where receipt_no is not null) = 1, '');
  insert into t_res values ('backfill: frozen receipt values are right (ticket 100, paid 30, balance 70, 1 seat, gateway reference)',
    (rd->>'ticket_price')::numeric = 100 and (rd->>'amount_paid')::numeric = 30 and (rd->>'balance')::numeric = 70
    and (rd->>'seats')::int = 1 and (rd->>'booking_seats')::int = 1 and jsonb_array_length(rd->'guests') = 1
    and rd->>'reference' = '6991237914' and rd->>'party_title' = 'TEST Party 2 (do not book)' and rd->>'venue_name' is not null, rd::text);
  insert into t_res values ('receipt holds exactly the agreed fields',
    (select array_agg(k order by k) from jsonb_object_keys(rd) k) = array['amount_paid','balance','booking_seats','buyer_name','closes_text','guests','min_seats','paid_at','paid_at_text','paid_seats','party_id','party_start_text','party_title','receipt_no','reference','seats','ticket_price','venue_name'], '');
  insert into t_res values ('receipt has no GST / tax / alcohol / liquor / drink wording', lower(rd::text) !~ '(alcohol|liquor|drink|gst|cgst|sgst|igst|tax|beverage)', '');

  -- ---------------- a new deposit (party 3) ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  r := public.party_start_payment(v_p3, 'join', g1, true, tv);
  pay1 := (r->>'payment_id')::uuid; amt := (r->>'amount')::numeric;
  insert into t_res values ('deposit started (kind deposit, 30%)', r->>'kind' = 'deposit' and amt = 30, r::text);
  insert into t_res values ('a created (unpaid) payment has no receipt and sends nothing',
    (select receipt_no from public.party_payments where id = pay1) is null and (select count(*) from t_mail) = 0, '');
  res := public.party_confirm_core(pay1, 'TESTGW-001', round(amt * 100)::bigint)->>'result';
  insert into t_res values ('existing confirmation path still works', res = 'paid', res);
  select receipt_no, receipt_data into res, rd from public.party_payments where id = pay1;
  insert into t_res values ('paid deposit gets the next number PR-000002', res = 'PR-000002', coalesce(res, 'null'));
  insert into t_res values ('exactly one receipt email queued, to this customer, with the idempotency key',
    (select count(*) from t_mail where type = 'party_deposit_receipt') = 1
    and exists (select 1 from t_mail where type = 'party_deposit_receipt' and to_customer = v_cust and key = 'party-receipt-' || pay1 and data = rd), '');
  insert into t_res values ('receipt values: guest, ticket 100, paid 30, balance 70, reference, 1 of 2 seats',
    rd->'guests' = '["Receipt Guest One"]'::jsonb and (rd->>'ticket_price')::numeric = 100 and (rd->>'amount_paid')::numeric = 30
    and (rd->>'balance')::numeric = 70 and rd->>'reference' = 'TESTGW-001' and (rd->>'paid_seats')::int = 1 and (rd->>'min_seats')::int = 2
    and (rd->>'booking_seats')::int = 1, rd::text);
  insert into t_res values ('email data has no GST / tax / alcohol / drink wording', (select lower(data::text) !~ '(alcohol|liquor|drink|gst|cgst|sgst|igst|tax|beverage)' from t_mail where type = 'party_deposit_receipt' limit 1), '');
  res := public.party_confirm_core(pay1, 'TESTGW-001', round(amt * 100)::bigint)->>'result';
  insert into t_res values ('paying the same payment again: nothing new (already paid), same number, still one email',
    res = 'already paid' and (select receipt_no from public.party_payments where id = pay1) = 'PR-000002' and (select count(*) from t_mail where type = 'party_deposit_receipt') = 1, res);

  -- ---------------- receipts through the screen function (party 3 still published) ----------------
  rr := public.party_my_receipts(v_p3);
  insert into t_res values ('party_my_receipts: customer sees their own receipt (1)', jsonb_array_length(rr) = 1 and rr->0->>'receipt_no' = 'PR-000002' and (rr->0->>'refunded')::boolean = false and rr->0->>'payment_id' = pay1::text, rr::text);

  -- ---------------- a second deposit on the same booking confirms the party ----------------
  r := public.party_start_payment(v_p3, 'join', g2, true, tv);
  pay2 := (r->>'payment_id')::uuid; amt := (r->>'amount')::numeric;
  res := public.party_confirm_core(pay2, 'TESTGW-002', round(amt * 100)::bigint)->>'result';
  select receipt_no, receipt_data into res, rd from public.party_payments where id = pay2;
  insert into t_res values ('second deposit: number PR-000003, 2 seats on the booking, ticket 200, paid 30, balance 140',
    res = 'PR-000003' and (rd->>'booking_seats')::int = 2 and (rd->>'ticket_price')::numeric = 200 and (rd->>'amount_paid')::numeric = 30
    and (rd->>'balance')::numeric = 140 and rd->'guests' = '["Receipt Guest Two"]'::jsonb and (rd->>'paid_seats')::int = 2, rd::text);
  insert into t_res values ('party reached its minimum and is confirmed (existing behaviour)', (select status from public.parties where id = v_p3) = 'confirmed', '');
  insert into t_res values ('two receipt emails so far (one per deposit)', (select count(*) from t_mail where type = 'party_deposit_receipt') = 2, '');

  -- ---------------- balance payment: NO receipt ----------------
  m0 := (select count(*) from t_mail where type = 'party_deposit_receipt');
  r := public.party_start_payment(v_p3, 'balance');
  payb := (r->>'payment_id')::uuid; amt := (r->>'amount')::numeric;
  res := public.party_confirm_core(payb, 'TESTGW-003', round(amt * 100)::bigint)->>'result';
  insert into t_res values ('balance payment is paid but gets NO receipt and sends no receipt email',
    res = 'paid' and (select receipt_no from public.party_payments where id = payb) is null and (select count(*) from t_mail where type = 'party_deposit_receipt') = m0, res);

  -- ---------------- full payment (joined after confirmation): NO receipt ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true);
  r := public.party_start_payment(v_p3, 'join', g3, true, tv);
  payf := (r->>'payment_id')::uuid; amt := (r->>'amount')::numeric;
  res := public.party_confirm_core(payf, 'TESTGW-004', round(amt * 100)::bigint)->>'result';
  insert into t_res values ('full payment (kind full) is paid but gets NO receipt and no email',
    r->>'kind' = 'full' and res = 'paid' and (select receipt_no from public.party_payments where id = payf) is null and (select count(*) from t_mail where type = 'party_deposit_receipt') = m0, r->>'kind');

  -- ---------------- late payment that is refunded: NO receipt ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust3, 'role', 'authenticated')::text, true);
  r := public.party_start_payment(v_p2, 'join', g3, true, tv);
  payl := (r->>'payment_id')::uuid;
  update public.party_payments set status = 'paid', paid_at = now(), refund_status = 'due', refund_amount = amount, refund_reason = 'late_payment', refund_queued_at = now() where id = payl;
  update public.party_seats set status = 'cancelled' where payment_id = payl;
  insert into t_res values ('late payment (refund due) gets NO receipt and no email',
    (select receipt_no from public.party_payments where id = payl) is null and (select count(*) from t_mail where type = 'party_deposit_receipt') = m0, '');

  -- ---------------- a receipt problem must never stop a payment ----------------
  select pg_get_functiondef('public.party_receipt_build(public.party_payments,text)'::regprocedure) into def_build;
  create or replace function public.party_receipt_build(pay public.party_payments, p_no text) returns jsonb language plpgsql security definer set search_path = public as $f$ begin raise exception 'receipt builder broken'; end $f$;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true);
  r := public.party_start_payment(v_p2, 'join', g1, true, tv);
  pay8 := (r->>'payment_id')::uuid; amt := (r->>'amount')::numeric;
  res := public.party_confirm_core(pay8, 'TESTGW-005', round(amt * 100)::bigint)->>'result';
  insert into t_res values ('broken receipt builder: the payment still completes, just without a receipt',
    res = 'paid' and (select status from public.party_payments where id = pay8) = 'paid'
    and (select receipt_no from public.party_payments where id = pay8) is null
    and (select count(*) from public.party_seats where payment_id = pay8 and status = 'paid') = 1
    and (select count(*) from t_mail where type = 'party_deposit_receipt') = m0, res);
  execute def_build;
  insert into t_res values ('receipt builder restored byte for byte', md5(pg_get_functiondef('public.party_receipt_build(public.party_payments,text)'::regprocedure)) = md5(def_build), '');

  -- ---------------- reading receipts: who sees what, and the visibility switch ----------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  rr := public.party_my_receipts();
  insert into t_res values ('customer sees both their deposit receipts, not the balance payment', jsonb_array_length(rr) = 2 and rr->0->>'receipt_no' = 'PR-000002' and rr->1->>'receipt_no' = 'PR-000003', rr::text);
  insert into t_res values ('receipt screen data has no GST / tax / alcohol / drink wording', lower(rr::text) !~ '(alcohol|liquor|drink|gst|cgst|sgst|igst|tax|beverage)', '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true);
  insert into t_res values ('another customer sees none of those receipts (and none for a full payment)', public.party_my_receipts() = '[]'::jsonb, public.party_my_receipts()::text);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust3, 'role', 'authenticated')::text, true);
  insert into t_res values ('a customer whose payment was refunded as late sees none', public.party_my_receipts() = '[]'::jsonb, '');
  perform set_config('request.jwt.claims', '', true);
  insert into t_res values ('signed-out visitor gets an empty list', public.party_my_receipts() = '[]'::jsonb, '');
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  update public.platform_settings set party_pool_visibility = 'off';
  insert into t_res values ('visibility off: nothing is returned', public.party_my_receipts() = '[]'::jsonb, '');
  update public.platform_settings set party_pool_visibility = 'testers';
  insert into t_res values ('visibility testers, not a tester: nothing is returned', public.party_my_receipts() = '[]'::jsonb, '');
  insert into public.party_pool_testers (user_id, note) values (v_cust, 'test');
  insert into t_res values ('visibility testers, listed tester: both receipts', jsonb_array_length(public.party_my_receipts()) = 2, '');
  update public.platform_settings set party_pool_visibility = 'all';
  update public.party_payments set refund_status = 'due', refund_amount = amount, refund_reason = 'party_cancelled', refund_queued_at = now() where id = pay1;
  insert into t_res values ('a refunded deposit is flagged on its receipt', (public.party_my_receipts(v_p3)->0->>'refunded')::boolean = true, '');

  -- ---------------- an email provider problem must never stop a payment ----------------
  select pg_get_functiondef('public.party_email(uuid,text,jsonb,text)'::regprocedure) into def_stub;
  create or replace function public.party_email(p_customer uuid, p_type text, p_data jsonb, p_key text) returns void language plpgsql security definer set search_path = public, net as $f$ begin raise exception 'email down'; end $f$;
  select id into bk from public.party_bookings where party_id = v_p3 and customer_id = v_cust;
  m0 := (select count(*) from t_mail);
  insert into public.party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, provider) values (v_p3, bk, v_cust, 'deposit', 0, 10, 'cashfree') returning id into payx;
  update public.party_payments set status = 'paid', paid_at = now(), cashfree_payment_id = 'TESTGW-006' where id = payx;
  insert into t_res values ('email service down: the payment is still marked paid and numbered, no error escapes',
    (select status from public.party_payments where id = payx) = 'paid' and (select receipt_no from public.party_payments where id = payx) = 'PR-000004' and (select count(*) from t_mail) = m0, '');
  execute def_stub;

  -- ---------------- access and grants ----------------
  insert into t_res values ('grants: anon cannot call party_my_receipts, signed-in customers can',
    not has_function_privilege('anon', 'public.party_my_receipts(uuid)', 'execute') and has_function_privilege('authenticated', 'public.party_my_receipts(uuid)', 'execute'), '');
  insert into t_res values ('grants: nobody can call the builder or the two trigger functions directly',
    not has_function_privilege('anon', 'public.party_receipt_build(public.party_payments,text)', 'execute') and not has_function_privilege('authenticated', 'public.party_receipt_build(public.party_payments,text)', 'execute')
    and not has_function_privilege('anon', 'public.party_receipt_assign()', 'execute') and not has_function_privilege('authenticated', 'public.party_receipt_assign()', 'execute')
    and not has_function_privilege('anon', 'public.party_receipt_email_trg()', 'execute') and not has_function_privilege('authenticated', 'public.party_receipt_email_trg()', 'execute'), '');
  insert into t_res values ('grants: nobody can use the receipt number sequence',
    not has_sequence_privilege('anon', 'public.party_receipt_seq', 'usage') and not has_sequence_privilege('authenticated', 'public.party_receipt_seq', 'usage'), '');
  insert into t_res values ('no function returns the payments table type (new columns cannot leak through a row-returning function)',
    (select count(*) from pg_proc where prorettype = 'public.party_payments'::regtype) = 0, '');
  update public.platform_settings set party_pool_visibility = (select j->>'party_pool_visibility' from s_ps);   -- put the switch back as the runner found it
end $t$;

-- a customer cannot read receipts straight from the table either (row security on party_payments is unchanged)
do $t$
declare v_cust uuid; c int;
begin
  select customer_id into v_cust from public.party_payments where receipt_no = 'PR-000002';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  select count(*) into c from public.party_payments where receipt_no is not null;
  reset role;
  insert into t_res values ('a customer cannot read party_payments (and so receipt_data) directly', c = 0, c::text);
end $t$;

-- Rolled-back test for phase4-cashfree-seats-tax.sql. Run it AFTER the migration text in the same call; it ends by raising
-- ROLLBACK_RESULTS so nothing is kept. Uses the existing "TEST Party (do not book)" and two active test customers.
do $t$
declare
  c1 uuid := 'cdb53fc7-dce4-4e98-b2a3-9dd417afd4fa'; c2 uuid := 'f57f3152-c53b-4484-b9c0-85bac2a6c71e';
  adm uuid := '1e90769e-84b7-4d7e-aaa0-260bb1dc5f77'; pid uuid := 'de2ae2da-9db4-4b0a-b3d3-473138bc7435';
  res jsonb := '{}'; r jsonb; pay jsonb; v text; n int; rec record;
  g2 jsonb := '[{"name":"Asha Rao","age":24,"gender":"female"},{"name":"Ravi Kumar","age":26,"gender":"male"}]';
  g1 jsonb := '[{"name":"Dev Mehta","age":30,"gender":"male"}]';
begin
  -- A. quotes (display only)
  res := res || jsonb_build_object('quote_included_2', public.party_quote(pid, 2));
  update public.parties set price_includes_tax = false, tax_percent = 18 where id = pid;
  res := res || jsonb_build_object('quote_excluded_2', public.party_quote(pid, 2), 'quote_6_seats', public.party_quote(pid, 6));
  update public.parties set price_includes_tax = true where id = pid;

  -- B. validation errors (as customer 1)
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  n := 0;
  for v in select unnest(array[
      '[{"name":"Asha Rao","age":20,"gender":"female"}]',          -- under the age limit (21)
      '[{"name":"A","age":25,"gender":"female"}]',                 -- name too short
      '[{"name":"Asha Rao","gender":"female"}]',                   -- no age
      '[{"name":"Asha Rao","age":25,"gender":"other"}]',           -- bad gender
      '[{"name":"A B","age":25,"gender":"male"},{"name":"C D","age":25,"gender":"male"},{"name":"E F","age":25,"gender":"male"},{"name":"G H","age":25,"gender":"male"}]', -- 4 seats, cap is 3 here
      '[]']) loop
    n := n + 1;
    begin
      perform public.party_start_payment(pid, 'join', v::jsonb, true, 2);
      res := res || jsonb_build_object('validation_' || n, 'NOT REJECTED');
    exception when others then res := res || jsonb_build_object('validation_' || n, sqlerrm); end;
  end loop;
  begin perform public.party_start_payment(pid, 'join', g1, false, 2); res := res || jsonb_build_object('no_accept', 'NOT REJECTED');
  exception when others then res := res || jsonb_build_object('no_accept', sqlerrm); end;

  -- C. Razorpay still works (customer 2, provider switched to razorpay inside this test)
  update public.platform_settings set payment_provider = 'razorpay';
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  pay := public.party_start_payment(pid, 'join', g1, true, 2);
  select p.provider, p.gateway_mode, p.amount, (p.held_until - p.created_at)::text as hold into rec from public.party_payments p where p.id = (pay->>'payment_id')::uuid;
  res := res || jsonb_build_object('rzp_start', pay, 'rzp_provider', rec.provider, 'rzp_mode', rec.gateway_mode, 'rzp_hold', rec.hold);
  perform public.party_attach_cashfree_order((pay->>'payment_id')::uuid, 'PYwrong');          -- must do nothing (provider is razorpay)
  perform public.party_attach_order((pay->>'payment_id')::uuid, 'order_RZP1');
  res := res || jsonb_build_object('rzp_confirm', public.party_confirm_payment('order_RZP1', 'pay_RZP1', 3000), 'rzp_confirm_again', public.party_confirm_payment('order_RZP1', 'pay_RZP1', 3000));
  select razorpay_payment_id, cashfree_payment_id, status into rec from public.party_payments where id = (pay->>'payment_id')::uuid;
  res := res || jsonb_build_object('rzp_row', row_to_json(rec));

  -- D. Cashfree: customer 1 joins with 2 guests (deposit 30% of 200 = 60), pays, party reaches its minimum and confirms
  update public.platform_settings set payment_provider = 'cashfree';
  perform set_config('request.jwt.claims', json_build_object('sub', c1, 'role', 'authenticated')::text, true);
  pay := public.party_start_payment(pid, 'join', g2, true, 2);
  select p.provider, p.gateway_mode, p.amount into rec from public.party_payments p where p.id = (pay->>'payment_id')::uuid;
  res := res || jsonb_build_object('cf_start', pay, 'cf_provider', rec.provider, 'cf_mode', rec.gateway_mode);
  select count(*), min(guest_name), max(guest_age) into rec from public.party_seats where payment_id = (pay->>'payment_id')::uuid and status = 'held';
  res := res || jsonb_build_object('cf_held_seats', row_to_json(rec));
  perform public.party_attach_cashfree_order((pay->>'payment_id')::uuid, 'PY00000000000000000000000000000001');
  res := res || jsonb_build_object('cf_wrong_amount', public.party_cashfree_apply_payment('PY00000000000000000000000000000001', 'cfp_1', 59.99, 'INR'));
  res := res || jsonb_build_object('cf_paid', public.party_cashfree_apply_payment('PY00000000000000000000000000000001', 'cfp_1', 60, 'INR'),
                                   'cf_paid_again', public.party_cashfree_apply_payment('PY00000000000000000000000000000001', 'cfp_1', 60, 'INR'));
  res := res || jsonb_build_object('cf_charges', public.party_cashfree_apply_charges('PY00000000000000000000000000000001', 1.42, 0.26));
  select status, cashfree_payment_id, razorpay_payment_id, gateway_fee, gateway_fee_estimated into rec from public.party_payments where id = (pay->>'payment_id')::uuid;
  res := res || jsonb_build_object('cf_row', row_to_json(rec), 'party_status', (select status from public.parties where id = pid),
                                   'amount_mismatch_alerts', (select count(*) from public.admin_alerts where kind = 'party_payment_amount_mismatch'));
  res := res || jsonb_build_object('my_booking_c1', public.party_my_booking(pid));
  -- a changed attempt cannot alter provider / mode afterwards
  update public.party_payments set provider = 'razorpay', gateway_mode = 'test' where id = (pay->>'payment_id')::uuid;
  select provider, gateway_mode into rec from public.party_payments where id = (pay->>'payment_id')::uuid;
  res := res || jsonb_build_object('provider_locked', row_to_json(rec));

  -- E. balance for customer 1 (confirmed party: 200 - 60 = 140), paid through Cashfree
  pay := public.party_start_payment(pid, 'balance', null, false, null);
  perform public.party_attach_cashfree_order((pay->>'payment_id')::uuid, 'PY00000000000000000000000000000002');
  res := res || jsonb_build_object('balance_start', pay, 'balance_paid', public.party_cashfree_apply_payment('PY00000000000000000000000000000002', 'cfp_2', 140, 'INR'),
                                   'remaining_after', public.party_booking_remaining((select id from public.party_bookings where party_id = pid and customer_id = c1)));
  -- customer 2 (razorpay deposit of 30 on 100): balance 70 started on Cashfree, then the party is cancelled before it is paid
  perform set_config('request.jwt.claims', json_build_object('sub', c2, 'role', 'authenticated')::text, true);
  pay := public.party_start_payment(pid, 'balance', null, false, null);
  perform public.party_attach_cashfree_order((pay->>'payment_id')::uuid, 'PY00000000000000000000000000000003');
  res := res || jsonb_build_object('c2_balance_start', pay);

  -- F. admin views before cancel
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  res := res || jsonb_build_object('summary_live_only', public.party_admin_summary(pid), 'summary_with_test', public.party_admin_summary(pid, true),
                                   'guests', (select jsonb_agg(row_to_json(g)) from public.party_admin_guests(pid) g),
                                   'public_row', (select row_to_json(x) from (select max_seats_per_booking, price_includes_tax, tax_percent, price_per_person from public.party_public(pid)) x));

  -- G. party cancelled: refunds queue, urgent alerts, then a late payment arrives for the cancelled party
  update public.parties set status = 'cancelled', cancel_reason = 'Cancelled by PAXO (test)' where id = pid;
  res := res || jsonb_build_object('refunds', (select jsonb_agg(row_to_json(x)) from public.party_admin_refunds(pid) x),
                                   'urgent_alerts', (select jsonb_agg(jsonb_build_object('kind', kind, 'urgent', urgent, 'msg', left(message, 140))) from public.admin_alerts where kind like 'party_%' and resolved_at is null));
  res := res || jsonb_build_object('late_payment', public.party_cashfree_apply_payment('PY00000000000000000000000000000003', 'cfp_3', 70, 'INR'));
  select refund_status, refund_amount, refund_reason into rec from public.party_payments where cashfree_order_id = 'PY00000000000000000000000000000003';
  res := res || jsonb_build_object('late_row', row_to_json(rec));

  -- H. admin marks a Cashfree refund (with the Cashfree refund id); the alert closes
  perform public.party_mark_refunded((select id from public.party_payments where cashfree_order_id = 'PY00000000000000000000000000000001'), current_date, 'refunded in dashboard', 'CFREF_1');
  select refund_status, cashfree_refund_id into rec from public.party_payments where cashfree_order_id = 'PY00000000000000000000000000000001';
  res := res || jsonb_build_object('marked', row_to_json(rec),
                                   'open_alerts_for_that_payment', (select count(*) from public.admin_alerts a where a.resolved_at is null and a.message like '%[' || (select id from public.party_payments where cashfree_order_id = 'PY00000000000000000000000000000001') || ']%'),
                                   'summary_after', public.party_admin_summary(pid, true) - 'settled_on' - 'settled_note');

  -- I. who may run what
  res := res || jsonb_build_object('privileges', jsonb_build_object(
      'quote_anon', has_function_privilege('anon', 'public.party_quote(uuid,integer)', 'execute'),
      'start_anon', has_function_privilege('anon', 'public.party_start_payment(uuid,text,jsonb,boolean,integer)', 'execute'),
      'start_auth', has_function_privilege('authenticated', 'public.party_start_payment(uuid,text,jsonb,boolean,integer)', 'execute'),
      'core_auth', has_function_privilege('authenticated', 'public.party_confirm_core(uuid,text,bigint,numeric,numeric)', 'execute'),
      'cf_apply_auth', has_function_privilege('authenticated', 'public.party_cashfree_apply_payment(text,text,numeric,text)', 'execute'),
      'cf_apply_service', has_function_privilege('service_role', 'public.party_cashfree_apply_payment(text,text,numeric,text)', 'execute'),
      'guests_anon', has_function_privilege('anon', 'public.party_admin_guests(uuid)', 'execute'),
      'refunds_anon', has_function_privilege('anon', 'public.party_admin_refunds(uuid)', 'execute'),
      'mark_auth', has_function_privilege('authenticated', 'public.party_mark_refunded(uuid,date,text,text)', 'execute'),
      'public_anon', has_function_privilege('anon', 'public.party_public(uuid)', 'execute')));
  raise exception 'ROLLBACK_RESULTS %', res::text;
end $t$;

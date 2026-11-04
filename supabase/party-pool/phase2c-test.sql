do $t$
declare
  v uuid := '53b1a218-c99d-4039-a37f-e35ee3393509';
  u1 uuid := 'cdb53fc7-dce4-4e98-b2a3-9dd417afd4fa'; u2 uuid := 'f57f3152-c53b-4484-b9c0-85bac2a6c71e';
  far uuid; near uuid; b1 uuid; b2 uuid; pay1 uuid; pay2 uuid; r jsonb; res text := ''; n int; m jsonb; msg text;
begin
  -- fixtures: a party 10 days out, one 1 day out
  insert into parties (title, venue_id, party_date, start_time, end_time, price_per_person, male_seats, female_seats, min_paid_seats, closes_at, package_type, liquor_type)
   values ('T far', v, (now() + interval '10 days')::date, '20:00', '23:00', 1000, 10, 10, 2, now() + interval '1 day', 'x', 'y') returning id into far;
  insert into parties (title, venue_id, party_date, start_time, end_time, price_per_person, male_seats, female_seats, min_paid_seats, closes_at, package_type, liquor_type)
   values ('T near', v, (now() + interval '1 day')::date, '23:30', '23:59', 1000, 10, 10, 2, now() - interval '1 hour', 'x', 'y') returning id into near;
  update parties set status = 'published' where id in (far, near);
  -- u1: 2 paid seats + deposit 600 on far; u2: 1 paid seat + 300 on far, also one open (created) payment with a held seat
  insert into party_bookings (party_id, customer_id) values (far, u1) returning id into b1;
  insert into party_bookings (party_id, customer_id) values (far, u2) returning id into b2;
  insert into party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, status, paid_at) values (far, b1, u1, 'deposit', 2, 600, 'paid', now()) returning id into pay1;
  insert into party_seats (party_id, customer_id, gender, status, booking_id, payment_id, paid_at) values (far, u1, 'male', 'paid', b1, pay1, now()), (far, u1, 'female', 'paid', b1, pay1, now());
  insert into party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, status, paid_at) values (far, b2, u2, 'deposit', 1, 300, 'paid', now()) returning id into pay2;
  insert into party_seats (party_id, customer_id, gender, status, booking_id, payment_id, paid_at) values (far, u2, 'male', 'paid', b2, pay2, now());
  -- near party: u1 booking with a paid seat
  insert into party_bookings (party_id, customer_id) values (near, u1) returning id into b1;
  insert into party_payments (party_id, booking_id, customer_id, kind, seats_count, amount, status, paid_at) values (near, b1, u1, 'deposit', 1, 300, 'paid', now()) returning id into pay1;
  insert into party_seats (party_id, customer_id, gender, status, booking_id, payment_id, paid_at) values (near, u1, 'male', 'paid', b1, pay1, now());

  -- as u1
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  m := party_my_booking(far);
  res := res || 'can_cancel_far=' || (m->>'can_cancel') || '; ';
  r := party_cancel_my_booking(far);
  res := res || 'cancel_far=' || r::text || '; ';
  begin perform party_cancel_my_booking(far); res := res || 'BAD double cancel ok; '; exception when others then res := res || 'double cancel blocked; '; end;
  begin perform party_start_payment(far, 'join', array['male'], true, 2); res := res || 'BAD rejoin ok; '; exception when others then msg := sqlerrm; res := res || 'rejoin blocked(' || msg || '); '; end;
  m := party_my_booking(near);
  res := res || 'can_cancel_near=' || (m->>'can_cancel') || '; ';
  begin perform party_cancel_my_booking(near); res := res || 'BAD near cancel ok; '; exception when others then res := res || 'near blocked(' || sqlerrm || '); '; end;
  -- as u2: cannot touch u1's booking (no booking of their own in near)
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  begin perform party_cancel_my_booking(near); res := res || 'BAD other cancel ok; '; exception when others then res := res || 'other user blocked; '; end;
  -- anon cannot call
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin perform party_cancel_my_booking(far); res := res || 'BAD anon ok; '; exception when others then res := res || 'anon blocked; '; end;
  reset role;

  -- state checks
  select count(*) into n from party_seats where party_id = far and status = 'paid';
  res := res || 'paid_seats_far_left=' || n || '; ';
  select count(*) into n from party_seats where party_id = far and customer_id = u1 and status = 'cancelled';
  res := res || 'u1_seats_cancelled=' || n || '; ';
  select count(*) into n from party_payments where booking_id = (select id from party_bookings where party_id = far and customer_id = u1) and refund_status = 'due' and refund_amount = 600 and refund_reason = 'guest_cancelled';
  res := res || 'u1_refund_row=' || n || '; ';
  select count(*) into n from party_payments where booking_id = b2 and refund_status = 'none';
  res := res || 'u2_untouched=' || n || '; ';
  select count(*) into n from party_payments where party_id = near and refund_status = 'none';
  res := res || 'near_untouched=' || n || '; ';
  select status into msg from party_bookings where party_id = far and customer_id = u1;
  res := res || 'u1_booking=' || msg || '; ';
  m := (select party_admin_summary(far));
  raise exception 'ROLLBACK_RESULTS %', res;
end $t$;

-- PARTY POOL PHASE 3: menu voting, results / final menu, guest list, invoice data. Additive only: no existing table or function changes.
-- Every new table has RLS on and NO policies and no grants: everything goes through the SECURITY DEFINER functions below.
-- Customers only ever get their own vote and aggregate totals. Admin functions check admin_users themselves.

-- ================= 1. tables =================
create table public.party_menu_categories (
  party_id   uuid not null references public.parties(id) on delete cascade,
  category   text not null check (category in ('starter_veg','starter_non_veg','main_veg','main_non_veg','dessert','drinks')),
  winners    integer not null check (winners between 1 and 10),
  sort_order integer not null default 0,
  primary key (party_id, category)
);
create table public.party_menu_options (
  id           uuid primary key default gen_random_uuid(),
  party_id     uuid not null,
  category     text not null,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  label        text not null check (char_length(btrim(label)) between 1 and 120),
  sort_order   integer not null default 0,
  foreign key (party_id, category) references public.party_menu_categories(party_id, category) on delete cascade
);
create unique index party_menu_options_label_uq on public.party_menu_options (party_id, category, lower(btrim(label)));
-- one vote per booking per category; option_id null = "Anything is fine" (adds no weight to any item).
-- The weight is NOT stored: it is the booking's paid seats at tally time, so forfeited / cancelled / refunded bookings lose their votes by themselves.
create table public.party_menu_votes (
  booking_id uuid not null references public.party_bookings(id) on delete cascade,
  party_id   uuid not null,
  category   text not null,
  option_id  uuid references public.party_menu_options(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (booking_id, category),
  foreign key (party_id, category) references public.party_menu_categories(party_id, category) on delete cascade
);
create table public.party_menu_state (
  party_id         uuid primary key references public.parties(id) on delete cascade,
  voting_closes_at timestamptz,            -- null = 24 hours after the joining close time (never later than the party start)
  locked_at        timestamptz,
  locked_by        uuid
);
create table public.party_menu_tie_picks (
  party_id  uuid not null,
  category  text not null,
  option_id uuid not null references public.party_menu_options(id) on delete cascade,
  primary key (option_id)
);
create table public.party_menu_final (
  party_id    uuid not null references public.parties(id) on delete cascade,
  category    text not null,
  rank        integer not null,
  option_id   uuid,
  label       text not null,
  weight      integer not null,
  by_tiebreak boolean not null default false,
  primary key (party_id, category, rank)
);
create sequence public.party_invoice_seq;
create table public.party_invoices (
  id            uuid primary key default gen_random_uuid(),
  invoice_no    text not null unique,
  booking_id    uuid not null unique references public.party_bookings(id),
  party_id      uuid not null references public.parties(id),
  customer_id   uuid not null,
  status        text not null default 'issued' check (status in ('issued','void')),
  buyer_name    text, buyer_phone text, buyer_email text,
  party_title   text not null, venue_name text not null, party_date date not null,
  seats         integer not null, male integer not null default 0, female integer not null default 0,
  amount_paid   numeric not null,
  issued_at     timestamptz not null default now(),
  voided_at     timestamptz,
  -- pending the CA: GST details and layout. Left empty on purpose.
  buyer_gstin text, taxable_value numeric, gst_rate numeric, cgst numeric, sgst numeric, igst numeric
);
create index party_invoices_party_idx on public.party_invoices (party_id);
create index party_invoices_customer_idx on public.party_invoices (customer_id);

alter table public.party_menu_categories enable row level security;
alter table public.party_menu_options    enable row level security;
alter table public.party_menu_votes      enable row level security;
alter table public.party_menu_state      enable row level security;
alter table public.party_menu_tie_picks  enable row level security;
alter table public.party_menu_final      enable row level security;
alter table public.party_invoices        enable row level security;
revoke all on public.party_menu_categories, public.party_menu_options, public.party_menu_votes, public.party_menu_state,
  public.party_menu_tie_picks, public.party_menu_final, public.party_invoices from public, anon, authenticated;
revoke all on sequence public.party_invoice_seq from public, anon, authenticated;

-- ================= 2. internal helpers (not callable by anon / authenticated) =================
create function public.party_assert_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.admin_users where id = auth.uid()) then raise exception 'Admins only.'; end if;
end $$;

create function public.party_menu_close_at(p_party_id uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(s.voting_closes_at, least(p.closes_at + interval '24 hours', p.starts_at)) from public.parties p left join public.party_menu_state s on s.party_id = p.id where p.id = p_party_id
$$;

create function public.party_menu_kind_ok(p_category text, p_kind text) returns boolean
language sql immutable as $$
  select case p_category
    when 'drinks' then p_kind not in ('starter_veg','starter_non_veg','main_veg','main_non_veg','dessert','side')
    else p_kind = p_category end
$$;

-- paid seats per active booking, summed over the votes of each option
create function public.party_menu_tally(p_party_id uuid)
returns table (category text, option_id uuid, label text, sort_order integer, weight integer)
language sql stable security definer set search_path = public as $$
  with w as (
    select b.id as booking_id, count(*)::int as seats
    from public.party_bookings b join public.party_seats s on s.booking_id = b.id and s.status = 'paid'
    where b.party_id = p_party_id and b.status = 'active' group by b.id)
  select o.category, o.id, o.label, o.sort_order, coalesce(sum(w.seats), 0)::int
  from public.party_menu_options o
  left join public.party_menu_votes v on v.option_id = o.id
  left join w on w.booking_id = v.booking_id
  where o.party_id = p_party_id
  group by o.category, o.id, o.label, o.sort_order
$$;

-- top N per category with tie detection. A tie exists when more options share the cut-off weight than there are slots left.
create function public.party_menu_calc(p_party_id uuid)
returns table (category text, option_id uuid, label text, sort_order integer, weight integer, pct numeric,
               winners integer, in_tie boolean, tie_slots integer, picked boolean, is_winner boolean, tie_resolved boolean)
language sql stable security definer set search_path = public as $$
  with t as (select * from public.party_menu_tally(p_party_id)),
  r as (
    select t.*, c.winners as n,
           row_number() over (partition by t.category order by t.weight desc, t.sort_order, t.label) as rn,
           sum(t.weight) over (partition by t.category) as total
    from t join public.party_menu_categories c on c.party_id = p_party_id and c.category = t.category),
  cut as (select r.category as cat, coalesce(max(r.weight) filter (where r.rn = r.n), 0) as wn from r group by r.category),
  x as (select r.*, cut.wn from r join cut on cut.cat = r.category),
  y as (
    select x.*,
           count(*) filter (where x.weight > x.wn) over (partition by x.category) as above,
           count(*) filter (where x.wn > 0 and x.weight = x.wn) over (partition by x.category) as gsize,
           (case when exists (select 1 from public.party_menu_tie_picks p where p.option_id = x.option_id) then 1 else 0 end) as pk
    from x),
  z as (
    select y.*, (y.n - y.above) as slots,
           sum(case when y.wn > 0 and y.weight = y.wn then y.pk else 0 end) over (partition by y.category) as picks_in_group
    from y)
  select z.category, z.option_id, z.label, z.sort_order, z.weight,
         case when z.total > 0 then round(100.0 * z.weight / z.total, 1) else 0 end,
         z.n,
         (z.wn > 0 and z.weight = z.wn and z.gsize > z.slots),
         case when z.wn > 0 and z.weight = z.wn and z.gsize > z.slots then z.slots::int else 0 end,
         (z.pk = 1),
         (z.weight > z.wn) or (z.wn > 0 and z.weight = z.wn and (z.gsize <= z.slots or z.pk = 1)),
         (z.gsize <= z.slots or z.picks_in_group = z.slots)
  from z
$$;

-- ================= 3. admin: voting setup =================
create function public.party_admin_menu_items(p_party_id uuid)
returns table (item_id uuid, name text, category_name text, category_kind text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.party_assert_admin();
  return query
  select i.id, i.name, c.name, c.kind
  from public.parties p join public.menu_items i on i.venue_id = p.venue_id join public.menu_categories c on c.id = i.category_id
  where p.id = p_party_id and i.is_available order by c.sort_order, c.name, i.name;
end $$;

create function public.party_admin_get_menu(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s record;
begin
  perform public.party_assert_admin();
  select * into s from public.party_menu_state where party_id = p_party_id;
  return jsonb_build_object(
    'voting_closes_at', s.voting_closes_at,
    'effective_closes_at', public.party_menu_close_at(p_party_id),
    'locked_at', s.locked_at,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', c.category, 'winners', c.winners,
        'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'menu_item_id', o.menu_item_id, 'label', o.label) order by o.sort_order, o.label)
                              from public.party_menu_options o where o.party_id = c.party_id and o.category = c.category), '[]'::jsonb))
        order by c.sort_order, c.category)
      from public.party_menu_categories c where c.party_id = p_party_id), '[]'::jsonb));
end $$;

-- p_config: [{ "category": "starter_veg", "winners": 2, "options": [{ "menu_item_id": "...", "label": "optional" }, { "label": "Custom dish" }] }, ...]
create function public.party_admin_set_menu(p_party_id uuid, p_voting_closes_at timestamptz, p_config jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  p record; s record; c jsonb; o jsonb; v_cat text; v_win int; v_label text; v_item uuid; v_kind text; v_name text;
  v_i int := 0; v_j int; v_keep uuid[]; v_oid uuid; v_cats text[] := '{}';
begin
  perform public.party_assert_admin();
  select * into p from public.parties where id = p_party_id for update;
  if not found then raise exception 'Party not found.'; end if;
  if p.status in ('cancelled', 'completed') then raise exception 'This party is %, its menu cannot be changed.', p.status; end if;
  select * into s from public.party_menu_state where party_id = p_party_id;
  if s.locked_at is not null then raise exception 'The menu is locked and can no longer be changed.'; end if;
  if jsonb_typeof(p_config) is distinct from 'array' then raise exception 'Menu setup must be a list of categories.'; end if;
  if p_voting_closes_at is not null and p_voting_closes_at > p.starts_at then raise exception 'Voting must close before the party starts.'; end if;

  insert into public.party_menu_state (party_id, voting_closes_at) values (p_party_id, p_voting_closes_at)
  on conflict (party_id) do update set voting_closes_at = excluded.voting_closes_at;

  for c in select * from jsonb_array_elements(p_config) loop
    v_cat := c->>'category';
    if v_cat is null or v_cat not in ('starter_veg','starter_non_veg','main_veg','main_non_veg','dessert','drinks') then raise exception 'Unknown menu category.'; end if;
    if v_cat = any (v_cats) then raise exception 'Category % is listed twice.', v_cat; end if;
    v_cats := v_cats || v_cat;
    begin v_win := (c->>'winners')::int; exception when others then v_win := null; end;
    if v_win is null or v_win < 1 or v_win > 10 then raise exception 'Choose how many winners are served (1 to 10) for %.', v_cat; end if;
    if jsonb_typeof(c->'options') is distinct from 'array' or jsonb_array_length(c->'options') < 1 then raise exception 'Add at least one option for %.', v_cat; end if;
    if jsonb_array_length(c->'options') > 40 then raise exception 'At most 40 options per category.'; end if;
    v_i := v_i + 1;
    insert into public.party_menu_categories (party_id, category, winners, sort_order) values (p_party_id, v_cat, v_win, v_i)
    on conflict (party_id, category) do update set winners = excluded.winners, sort_order = excluded.sort_order;

    v_keep := '{}'; v_j := 0;
    for o in select * from jsonb_array_elements(c->'options') loop
      v_j := v_j + 1;
      v_item := nullif(o->>'menu_item_id', '')::uuid;
      v_label := nullif(btrim(coalesce(o->>'label', '')), '');
      if v_item is not null then
        select i.name, k.kind into v_name, v_kind from public.menu_items i join public.menu_categories k on k.id = i.category_id
         where i.id = v_item and i.venue_id = p.venue_id;
        if v_name is null then raise exception 'A chosen dish does not belong to this party''s venue.'; end if;
        if not public.party_menu_kind_ok(v_cat, v_kind) then raise exception 'The dish "%" does not belong in %.', v_name, v_cat; end if;
        v_label := coalesce(v_label, v_name);
      end if;
      if v_label is null then raise exception 'Every option needs a name.'; end if;
      if char_length(v_label) > 120 then raise exception 'Option names can be at most 120 characters.'; end if;
      select id into v_oid from public.party_menu_options where party_id = p_party_id and category = v_cat and lower(btrim(label)) = lower(v_label);
      if v_oid is null then
        insert into public.party_menu_options (party_id, category, menu_item_id, label, sort_order) values (p_party_id, v_cat, v_item, v_label, v_j) returning id into v_oid;
      else
        update public.party_menu_options set menu_item_id = v_item, sort_order = v_j where id = v_oid;
      end if;
      v_keep := v_keep || v_oid;
    end loop;
    delete from public.party_menu_options where party_id = p_party_id and category = v_cat and not (id = any (v_keep));
  end loop;
  delete from public.party_menu_categories where party_id = p_party_id and not (category = any (v_cats));
end $$;

-- ================= 4. admin: results, ties, lock =================
create function public.party_admin_menu_results(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s record; v_close timestamptz; v_eligible int;
begin
  perform public.party_assert_admin();
  select * into s from public.party_menu_state where party_id = p_party_id;
  v_close := public.party_menu_close_at(p_party_id);
  select count(*)::int into v_eligible from public.party_bookings b join public.party_seats x on x.booking_id = b.id and x.status = 'paid'
   where b.party_id = p_party_id and b.status = 'active';
  return jsonb_build_object(
    'closes_at', v_close, 'voting_closed', now() >= v_close, 'locked_at', s.locked_at, 'eligible_seats', v_eligible,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category', mc.category, 'winners', mc.winners,
        'anything_seats', (select coalesce(sum(w.seats), 0)::int from public.party_menu_votes v
                            join (select b.id as bid, count(*)::int as seats from public.party_bookings b join public.party_seats x on x.booking_id = b.id and x.status = 'paid'
                                   where b.party_id = p_party_id and b.status = 'active' group by b.id) w on w.bid = v.booking_id
                           where v.party_id = p_party_id and v.category = mc.category and v.option_id is null),
        'tie_slots', (select coalesce(max(k.tie_slots), 0) from public.party_menu_calc(p_party_id) k where k.category = mc.category),
        'tie_resolved', (select coalesce(bool_and(k.tie_resolved), true) from public.party_menu_calc(p_party_id) k where k.category = mc.category),
        'options', coalesce((select jsonb_agg(jsonb_build_object('id', k.option_id, 'label', k.label, 'weight', k.weight, 'pct', k.pct,
                    'winner', k.is_winner, 'in_tie', k.in_tie, 'picked', k.picked) order by k.weight desc, k.sort_order, k.label)
                    from public.party_menu_calc(p_party_id) k where k.category = mc.category), '[]'::jsonb))
        order by mc.sort_order)
      from public.party_menu_categories mc where mc.party_id = p_party_id), '[]'::jsonb));
end $$;

create function public.party_admin_pick_tie(p_party_id uuid, p_category text, p_option_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare s record; v_slots int; v_group uuid[]; v_n int;
begin
  perform public.party_assert_admin();
  select * into s from public.party_menu_state where party_id = p_party_id;
  if s.party_id is null then raise exception 'No menu is set up for this party.'; end if;
  if s.locked_at is not null then raise exception 'The menu is locked.'; end if;
  if now() < public.party_menu_close_at(p_party_id) then raise exception 'Ties can be decided once voting has closed.'; end if;
  select max(k.tie_slots), array_agg(k.option_id) filter (where k.in_tie) into v_slots, v_group from public.party_menu_calc(p_party_id) k where k.category = p_category;
  if coalesce(v_slots, 0) = 0 then raise exception 'There is no tie in this category.'; end if;
  v_n := coalesce(array_length(p_option_ids, 1), 0);
  if v_n <> v_slots then raise exception 'Pick exactly % of the tied options.', v_slots; end if;
  if exists (select 1 from unnest(p_option_ids) x where x is null or not (x = any (v_group))) or
     (select count(distinct x) from unnest(p_option_ids) x) <> v_n then raise exception 'Pick distinct options from the tied ones.'; end if;
  delete from public.party_menu_tie_picks where party_id = p_party_id and category = p_category;
  insert into public.party_menu_tie_picks (party_id, category, option_id) select p_party_id, p_category, x from unnest(p_option_ids) x;
end $$;

create function public.party_admin_lock_menu(p_party_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; v_open text;
begin
  perform public.party_assert_admin();
  select * into s from public.party_menu_state where party_id = p_party_id for update;
  if s.party_id is null or not exists (select 1 from public.party_menu_categories where party_id = p_party_id) then raise exception 'No menu is set up for this party.'; end if;
  if s.locked_at is not null then raise exception 'The menu is already locked.'; end if;
  if now() < public.party_menu_close_at(p_party_id) then raise exception 'Voting is still open. The menu can be locked after it closes.'; end if;
  select string_agg(distinct k.category, ', ') into v_open from public.party_menu_calc(p_party_id) k where not k.tie_resolved;
  if v_open is not null then raise exception 'Decide the tie first in: %.', v_open; end if;
  delete from public.party_menu_final where party_id = p_party_id;
  insert into public.party_menu_final (party_id, category, rank, option_id, label, weight, by_tiebreak)
  select p_party_id, k.category, row_number() over (partition by k.category order by k.weight desc, k.sort_order, k.label), k.option_id, k.label, k.weight, k.in_tie
  from public.party_menu_calc(p_party_id) k where k.is_winner;
  update public.party_menu_state set locked_at = now(), locked_by = auth.uid() where party_id = p_party_id;
  return public.party_menu_final(p_party_id);
end $$;

-- the locked menu: shown to everyone on the party page (no votes, no weights)
create function public.party_menu_final(p_party_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when s.locked_at is null then null else (
    select coalesce(jsonb_agg(jsonb_build_object('category', c.category,
        'items', coalesce((select jsonb_agg(f.label order by f.rank) from public.party_menu_final f where f.party_id = c.party_id and f.category = c.category), '[]'::jsonb))
        order by c.sort_order), '[]'::jsonb)
    from public.party_menu_categories c where c.party_id = p_party_id) end
  from public.party_menu_state s
  join public.parties p on p.id = s.party_id and p.status in ('published','confirmed','closed','completed')
  where s.party_id = p_party_id
$$;

-- ================= 5. customer: voting =================
create function public.party_menu_voting(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_bid uuid; p record; s record; v_seats int := 0; v_close timestamptz; v_open boolean;
begin
  select * into p from public.parties where id = p_party_id and status in ('published','confirmed','closed','completed');
  select * into s from public.party_menu_state where party_id = p_party_id;
  if p.id is null or s.party_id is null or not exists (select 1 from public.party_menu_categories where party_id = p_party_id) then
    return jsonb_build_object('configured', false);
  end if;
  if v_uid is not null then
    select id into v_bid from public.party_bookings where party_id = p_party_id and customer_id = v_uid and status = 'active';
    if v_bid is not null then select count(*)::int into v_seats from public.party_seats where booking_id = v_bid and status = 'paid'; end if;
  end if;
  v_close := public.party_menu_close_at(p_party_id);
  v_open := s.locked_at is null and now() < v_close and p.status in ('published','confirmed');
  return jsonb_build_object(
    'configured', true, 'locked', s.locked_at is not null, 'closes_at', v_close,
    'my_seats', v_seats, 'can_vote', v_seats > 0 and v_open,
    'categories', (
      select jsonb_agg(jsonb_build_object(
        'category', c.category, 'winners', c.winners,
        -- totals only for guests with paid seats; nobody ever gets a list of who voted
        'my_choice', case when v_seats = 0 then null
                          else (select case when v.option_id is null then 'any' else v.option_id::text end
                                  from public.party_menu_votes v where v.booking_id = v_bid and v.category = c.category) end,
        'options', (select jsonb_agg(
            case when v_seats > 0 then jsonb_build_object('id', k.option_id, 'label', k.label, 'weight', k.weight, 'pct', k.pct)
                 else jsonb_build_object('id', k.option_id, 'label', k.label) end
            order by k.sort_order, k.label)
          from public.party_menu_calc(p_party_id) k where k.category = c.category))
        order by c.sort_order)
      from public.party_menu_categories c where c.party_id = p_party_id));
end $$;

-- p_option_id null = "Anything is fine"
create function public.party_cast_vote(p_party_id uuid, p_category text, p_option_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); b record; p record; s record; v_seats int;
begin
  if v_uid is null then raise exception 'Please sign in to continue.'; end if;
  select * into p from public.parties where id = p_party_id;
  if not found or p.status not in ('published','confirmed') then raise exception 'Voting is not open for this party.'; end if;
  select * into s from public.party_menu_state where party_id = p_party_id;
  if s.party_id is null then raise exception 'There is no menu vote for this party.'; end if;
  if s.locked_at is not null or now() >= public.party_menu_close_at(p_party_id) then raise exception 'Voting has closed.'; end if;
  select * into b from public.party_bookings where party_id = p_party_id and customer_id = v_uid and status = 'active';
  if not found then raise exception 'Only guests with a paid seat can vote.'; end if;
  select count(*)::int into v_seats from public.party_seats where booking_id = b.id and status = 'paid';
  if v_seats < 1 then raise exception 'Only guests with a paid seat can vote.'; end if;
  if not exists (select 1 from public.party_menu_categories where party_id = p_party_id and category = p_category) then raise exception 'This category is not part of the vote.'; end if;
  if p_option_id is not null and not exists (select 1 from public.party_menu_options where id = p_option_id and party_id = p_party_id and category = p_category) then
    raise exception 'That option is not part of this vote.';
  end if;
  insert into public.party_menu_votes (booking_id, party_id, category, option_id, updated_at) values (b.id, p_party_id, p_category, p_option_id, now())
  on conflict (booking_id, category) do update set option_id = excluded.option_id, updated_at = now();
  return public.party_menu_voting(p_party_id);
end $$;

-- ================= 6. admin: guest list =================
create function public.party_admin_guest_list(p_party_id uuid)
returns table (booking_id uuid, booker_name text, phone text, email text, seats integer, male integer, female integer,
               amount_paid numeric, balance_due numeric, balance_due_by timestamptz, balance_status text)
language plpgsql stable security definer set search_path = public as $$
declare v_status text;
begin
  perform public.party_assert_admin();
  select pp.status into v_status from public.parties pp where pp.id = p_party_id;
  return query
  select b.id, pr.full_name, pr.phone, pr.email,
         (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status = 'paid'),
         (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status = 'paid' and s.gender = 'male'),
         (select count(*)::int from public.party_seats s where s.booking_id = b.id and s.status = 'paid' and s.gender = 'female'),
         coalesce((select sum(x.amount) from public.party_payments x where x.booking_id = b.id and x.status = 'paid' and x.refund_status = 'none'), 0),
         public.party_booking_remaining(b.id),
         b.balance_due_by,
         case when public.party_booking_remaining(b.id) <= 0 then 'Paid in full'
              when v_status = 'confirmed' then 'Balance due'
              else 'Deposit paid (balance due after confirmation)' end
  from public.party_bookings b left join public.profiles pr on pr.id = b.customer_id
  where b.party_id = p_party_id and b.status = 'active'
    and exists (select 1 from public.party_seats s where s.booking_id = b.id and s.status = 'paid')
  order by b.created_at;
end $$;

-- ================= 7. invoice data =================
-- One record per booking, created when the booking is fully paid (deposit + balance, or 100% in one go).
-- Re-checked whenever a payment or a seat changes, so the order of the writes inside the payment function does not matter.
create function public.party_try_invoice(p_booking_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record; p record; pr record; v_venue text; v_n int; v_m int; v_f int; v_paid numeric; v_inv uuid;
begin
  select * into b from public.party_bookings where id = p_booking_id;
  if not found or b.status <> 'active' then return; end if;
  select count(*)::int, count(*) filter (where gender = 'male')::int, count(*) filter (where gender = 'female')::int
    into v_n, v_m, v_f from public.party_seats where booking_id = b.id and status = 'paid';
  if v_n = 0 then return; end if;
  if public.party_booking_remaining(b.id) > 0 then return; end if;
  select coalesce(sum(amount), 0) into v_paid from public.party_payments where booking_id = b.id and status = 'paid' and refund_status = 'none';
  if v_paid <= 0 then return; end if;
  select id into v_inv from public.party_invoices where booking_id = b.id and status = 'issued';
  if v_inv is not null then
    update public.party_invoices set seats = v_n, male = v_m, female = v_f, amount_paid = v_paid where id = v_inv;
    return;
  end if;
  if exists (select 1 from public.party_invoices where booking_id = b.id) then return; end if;
  select * into p from public.parties where id = b.party_id;
  select name into v_venue from public.venues where id = p.venue_id;
  select full_name, phone, email into pr from public.profiles where id = b.customer_id;
  insert into public.party_invoices (invoice_no, booking_id, party_id, customer_id, buyer_name, buyer_phone, buyer_email,
                                     party_title, venue_name, party_date, seats, male, female, amount_paid)
  values ('PP-' || lpad(nextval('public.party_invoice_seq')::text, 6, '0'), b.id, p.id, b.customer_id, pr.full_name, pr.phone, pr.email,
          p.title, v_venue, p.party_date, v_n, v_m, v_f, v_paid);
end $$;

create function public.party_invoice_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.booking_id is not null then perform public.party_try_invoice(new.booking_id); end if;
  return null;
end $$;
create trigger trg_party_invoice_payment after insert or update of status on public.party_payments
  for each row when (new.status = 'paid') execute function public.party_invoice_trg();
create trigger trg_party_invoice_seat after insert or update of status on public.party_seats
  for each row when (new.status = 'paid') execute function public.party_invoice_trg();

-- a cancelled or forfeited booking voids its invoice (the record stays, the number is never reused)
create function public.party_invoice_void_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.party_invoices set status = 'void', voided_at = now() where booking_id = new.id and status = 'issued';
  return null;
end $$;
create trigger trg_party_invoice_void after update of status on public.party_bookings
  for each row when (new.status in ('cancelled', 'forfeited') and old.status is distinct from new.status) execute function public.party_invoice_void_trg();

create function public.party_admin_invoices(p_party_id uuid default null)
returns setof public.party_invoices
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.party_assert_admin();
  return query select * from public.party_invoices i where p_party_id is null or i.party_id = p_party_id order by i.issued_at desc;
end $$;

create function public.party_my_invoices() returns setof public.party_invoices
language sql stable security definer set search_path = public as $$
  select * from public.party_invoices where customer_id = auth.uid() order by issued_at desc
$$;

-- ================= 8. grants =================
revoke all on function public.party_assert_admin(), public.party_menu_close_at(uuid), public.party_menu_kind_ok(text, text),
  public.party_menu_tally(uuid), public.party_menu_calc(uuid), public.party_try_invoice(uuid), public.party_invoice_trg(),
  public.party_invoice_void_trg() from public, anon, authenticated;
revoke all on function public.party_admin_menu_items(uuid), public.party_admin_get_menu(uuid), public.party_admin_set_menu(uuid, timestamptz, jsonb),
  public.party_admin_menu_results(uuid), public.party_admin_pick_tie(uuid, text, uuid[]), public.party_admin_lock_menu(uuid),
  public.party_admin_guest_list(uuid), public.party_admin_invoices(uuid), public.party_menu_voting(uuid),
  public.party_cast_vote(uuid, text, uuid), public.party_my_invoices(), public.party_menu_final(uuid) from public, anon, authenticated;
grant execute on function public.party_admin_menu_items(uuid), public.party_admin_get_menu(uuid), public.party_admin_set_menu(uuid, timestamptz, jsonb),
  public.party_admin_menu_results(uuid), public.party_admin_pick_tie(uuid, text, uuid[]), public.party_admin_lock_menu(uuid),
  public.party_admin_guest_list(uuid), public.party_admin_invoices(uuid), public.party_menu_voting(uuid),
  public.party_cast_vote(uuid, text, uuid), public.party_my_invoices() to authenticated;
grant execute on function public.party_menu_final(uuid) to anon, authenticated;

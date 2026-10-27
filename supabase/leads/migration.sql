-- "Find my venue" enquiries (leads). NOT APPLIED. Review first. Purely additive: one new table, one trigger, no change to
-- any existing table, function or policy.

create table public.venue_leads (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  name         text not null check (char_length(name) between 2 and 120),
  phone        text not null check (phone ~ '^[6-9][0-9]{9}$'),          -- 10-digit Indian mobile, digits only
  location     text not null check (char_length(location) between 2 and 200),
  party_date   date not null,
  guests       integer not null check (guests between 1 and 5000),        -- the "MG" the customer typed
  customer_id  uuid references auth.users(id) on delete set null,         -- set when the customer was signed in
  source       text not null default 'find_my_venue',
  status       text not null default 'new' check (status in ('new', 'contacted', 'booked', 'closed')),
  admin_notes  text check (char_length(admin_notes) <= 2000),
  contacted_at timestamptz,
  handled_by   uuid references public.admin_users(id),
  notified_at  timestamptz,                                               -- when the founder email was sent
  updated_at   timestamptz not null default now()
);
create index venue_leads_status_created_idx on public.venue_leads (status, created_at desc);
create index venue_leads_phone_created_idx  on public.venue_leads (phone, created_at desc);

alter table public.venue_leads enable row level security;
-- admins can read and work on leads; nobody else can read, write or delete anything
create policy venue_leads_admin_select on public.venue_leads for select
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()));
create policy venue_leads_admin_update on public.venue_leads for update
  using (exists (select 1 from public.admin_users au where au.id = auth.uid()))
  with check (exists (select 1 from public.admin_users au where au.id = auth.uid()));

-- Rows are CREATED only by the submit-lead edge function (service role: validation, rate limit, founder email).
revoke all on public.venue_leads from anon, authenticated;
grant select on public.venue_leads to authenticated;                                   -- RLS limits it to admins
grant update (status, admin_notes) on public.venue_leads to authenticated;             -- admins can change ONLY these two columns

-- Admin work stamps who handled it and when; the stamps cannot be set by hand.
create function public.venue_leads_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status then
    new.contacted_at := case when new.status = 'new' then null else coalesce(old.contacted_at, now()) end;
    new.handled_by   := case when new.status = 'new' then null else auth.uid() end;
  end if;
  return new;
end $$;
create trigger trg_venue_leads_touch before update on public.venue_leads
  for each row execute function public.venue_leads_touch();

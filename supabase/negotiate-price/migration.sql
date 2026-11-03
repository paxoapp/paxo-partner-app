-- "Open to negotiation": one boolean decides whether the customer app shows a Negotiate price button.
-- Purely additive. Admin-only for now: the same revert-for-non-admins pattern as enforce_venue_hold_admin_only.
alter table public.venues add column open_to_negotiation boolean not null default false;

create function public.enforce_venue_negotiation_admin_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or auth.role() = 'service_role' then return new; end if;
  if exists (select 1 from public.admin_users where id = auth.uid()) then return new; end if;
  if tg_op = 'INSERT' then new.open_to_negotiation := false;
  else new.open_to_negotiation := old.open_to_negotiation; end if;
  return new;
end $$;

create trigger trg_enforce_venue_negotiation_admin_only_upd before update on public.venues
  for each row execute function public.enforce_venue_negotiation_admin_only();
create trigger trg_enforce_venue_negotiation_admin_only_ins before insert on public.venues
  for each row execute function public.enforce_venue_negotiation_admin_only();

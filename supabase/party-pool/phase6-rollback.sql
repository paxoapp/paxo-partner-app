-- Rollback for phase6-party-visibility.sql. Everything returns to how it was before: the original functions are renamed back
-- (their text is untouched) and get their old grants; the column and the tester table are dropped.
-- Party Pool becomes visible to everyone again as soon as the customer app (partyAllowed) is also reverted or the mode was 'all'.
begin;
drop function if exists public.party_public(uuid);
drop function if exists public.party_quote(uuid, integer);
drop function if exists public.party_menu_voting(uuid);
drop function if exists public.party_menu_final(uuid);
drop function if exists public.party_cast_vote(uuid, text, uuid);
drop function if exists public.party_my_booking(uuid);
drop function if exists public.party_my_bookings();
drop function if exists public.party_my_invoices();
drop function if exists public.party_start_payment(uuid, text, jsonb, boolean, integer);

alter function public.party_public__ungated(uuid)                                rename to party_public;
alter function public.party_quote__ungated(uuid, integer)                        rename to party_quote;
alter function public.party_menu_voting__ungated(uuid)                           rename to party_menu_voting;
alter function public.party_menu_final__ungated(uuid)                            rename to party_menu_final;
alter function public.party_cast_vote__ungated(uuid, text, uuid)                 rename to party_cast_vote;
alter function public.party_my_booking__ungated(uuid)                            rename to party_my_booking;
alter function public.party_my_bookings__ungated()                               rename to party_my_bookings;
alter function public.party_my_invoices__ungated()                               rename to party_my_invoices;
alter function public.party_start_payment__ungated(uuid, text, jsonb, boolean, integer) rename to party_start_payment;

grant execute on function public.party_public(uuid)                           to anon, authenticated;
grant execute on function public.party_quote(uuid, integer)                   to anon, authenticated;
grant execute on function public.party_menu_final(uuid)                       to anon, authenticated;
grant execute on function public.party_menu_voting(uuid)                      to authenticated;
grant execute on function public.party_cast_vote(uuid, text, uuid)            to authenticated;
grant execute on function public.party_my_booking(uuid)                       to authenticated;
grant execute on function public.party_my_bookings()                          to authenticated;
grant execute on function public.party_my_invoices()                          to authenticated;
grant execute on function public.party_start_payment(uuid, text, jsonb, boolean, integer) to authenticated;

drop function if exists public.party_pool_access();
drop function if exists public.party_pool_allowed();
drop table if exists public.party_pool_testers;
alter table public.platform_settings drop constraint if exists platform_settings_party_pool_visibility_chk;
alter table public.platform_settings drop column if exists party_pool_visibility;
commit;

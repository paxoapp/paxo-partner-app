-- Rollback for phase5-party-venue.sql. Run only if no party-only venue is needed any more.
-- Venues created through admin_create_party_venue stay as ordinary approved, not-live venues (nothing is deleted from venues).
begin;
drop trigger if exists trg_guard_party_only_venue_live on public.venues;
drop function if exists public.guard_party_only_venue_live();
drop function if exists public.admin_create_party_venue(text, text, text, text, text, text, boolean);
drop function if exists public.admin_make_party_venue_normal(uuid);
drop table if exists public.party_only_venues;
commit;

-- Applied as migration "party_pool_remove_guest_cancel". Guests have NO self-cancel; the 30% deposit is non-refundable.
-- Removes party_cancel_my_booking and the 'guest_cancelled' refund reason, and restores party_my_booking to its Phase 2 shape.
-- Refunds exist only for: the party is cancelled by PAXO / the venue, the minimum is not reached, and late or unusable payments.
revoke all on function public.party_cancel_my_booking(uuid) from public, anon, authenticated;
drop function public.party_cancel_my_booking(uuid);
alter table public.party_payments drop constraint party_payments_refund_reason_check;
alter table public.party_payments add constraint party_payments_refund_reason_check
  check (refund_reason = any (array['party_cancelled','minimum_not_reached','late_payment']));
-- (party_my_booking recreated without can_cancel / cancel_until; see phase2-migration.sql for the definition)

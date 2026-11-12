# Party Pool on Cashfree — phase 4 (branch `party-cashfree`, NOT merged, NOT applied, NOT deployed)

| Piece | File | Status |
|---|---|---|
| Database | `phase4-cashfree-seats-tax.sql` (migration name `party_pool_phase4_cashfree_seats_tax`) | rollback-tested only; waits for "apply" |
| Rolled-back test | `phase4-test.sql` (run after the migration text in one call; ends with an error on purpose) | |
| Cashfree party function | `functions/party-cashfree/index.ts` + `cashfree.ts` (copy of the booking one) | not deployed |
| Razorpay party function | `functions/party-payment/index.ts` (now takes `guests`, refuses a Cashfree row) | not deployed |
| Webhook routing | `paxo-customer-app/supabase/cashfree/functions/cashfree.ts` (`PY…` → party functions, `PX…` unchanged) | not deployed; 39 booking checks + 11 party checks pass |
| Customer screens | `paxo-customer-app/src/parties.jsx`, `App.jsx` | on the branch |
| Admin screens | `src/partyPool.jsx`, `partyMoney.jsx`, `partyGuests.jsx` | on the branch |

## What changed for the guest
- Up to **5 seats per account** (hard cap in the database; the form also limits it).
- Name, **age** and gender for every seat; age must be at least the party's minimum age; one checkbox confirms the details and accepts the terms.
- Amount = seats × price per person. If the party's price **includes tax** the guest pays exactly that; otherwise tax is added on top (percent set on the party). The 30% deposit is taken on the total including tax.

## Order of go-live (each step waits for your word)
1. `apply` the migration.
2. Deploy `party-cashfree`, `party-payment` (new version), then the **webhook** (the booking webhook with the `PY…` routing).
3. Sandbox tests with `payment_provider='cashfree', cashfree_mode='sandbox'` on a preview build (switch back after).
4. One tiny live payment, refunded by hand.
5. `merge`.

## Sandbox test list
1. Join with 1, 3 and 5 guests; 6th is refused. 2. Under-age guest refused. 3. Tax included vs added. 4. Pay, close the tab right after paying (webhook finishes it). 5. Redirect return (`?cf_party_order=`). 6. Pay after the hold ran out (seats free → paid; seats gone → refund queued + urgent alert). 7. Same webhook delivered twice. 8. Wrong amount. 9. Two guests racing for the last seat. 10. Failed / abandoned payment gives the seats back. 11. Balance payment. 12. Party cancelled → refunds due, urgent alert, Mark refunded with the Cashfree refund id. 13. Not filled by closing time → same. 14. Test payments stay out of the live totals. 15. A normal booking payment still works. 16. Switch to Razorpay: party payment still works.

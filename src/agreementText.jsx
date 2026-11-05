// The PAXO Partner Agreement (version v1), word for word. This is the ONE place the text lives in the app:
// the login gate (onboarding.jsx, Checkpoint 3) and the public email-link page both render it from here.
// The two edge functions that email and PDF the agreement keep a copy of the same text; agreement-text-test.cjs
// fails if the copies ever differ.

export const AGREEMENT_VERSION = "v1";
export const AGREEMENT_COUNTERPARTY = "M/S PAXO, a proprietorship of Sushil Kumar";
export const AGREEMENT_INTRO = "By continuing, you agree to the following terms as a PAXO venue partner:";
export const AGREEMENT_ITEMS = [
  ["What PAXO is.", "PAXO is a booking platform connecting customers to venues. PAXO facilitates bookings, collects deposits, and processes settlements — your venue remains the actual service provider for every booking."],
  ["Your packages.", "You are responsible for honoring the food & beverage packages exactly as you've configured them, including all listed quotas and categories, for every confirmed booking."],
  ["Extra guests.", "If the number of guests attending exceeds the confirmed headcount, you may charge the customer additional amounts based on the increased guest count, as per your own venue policy — this is collected by you directly and is not calculated or collected by PAXO."],
  ["Platform fee.", "PAXO charges a platform fee on the deposit portion of each booking, tiered by total booking value: 5% below ₹1 lakh, 7% between ₹1–2 lakh, 10% at ₹2 lakh and above."],
  ["Deposits & refunds.", "A booking made more than 72 hours before the event takes a 20% deposit, which the customer can get back by the cancellation schedule (100% more than 72 hours before the event, 50% from 72 down to 48 hours, nothing after). A booking made within 72 hours takes a 50% deposit that is not refundable. If you decline, do not respond, cancel, or do not honour a booking, the customer gets back everything they paid. The remaining balance is paid directly to you by the customer at the venue."],
  ["Billing.", "You are responsible for issuing a proper bill/invoice to the customer for every booking, including GST, VAT, and any other applicable taxes or service charges."],
  ["Cancellations.", "You cannot cancel a confirmed booking yourself. If you need to cancel, contact PAXO Support — cancellations initiated this way refund the customer in full and no payout is made to you for that booking."],
  ["Settlement & payout.", "PAXO holds each deposit and shows its status on the booking. A deposit becomes ready to be released to you 48 hours before the event (Standard booking) or after the event (Late booking), and never before the payment has settled with the payment gateway. PAXO then pays it to your bank account."],
  ["Responding to requests.", "You must accept or decline booking requests within the response window shown for each request. Repeated non-response (not decline — decline is always fine) will place your venue on hold until PAXO reactivates it."],
  ["Conduct & liability.", "PAXO is not responsible for any misconduct, misbehavior, disputes, or illegal activity occurring at your venue or during any event, by any party. You are solely responsible for the safety, legality, and conduct of your venue and event operations."],
];

// The paragraph and numbered list, exactly as the login-gate screen has always shown them.
export function PartnerAgreementBody() {
  return (
    <>
      <p>{AGREEMENT_INTRO}</p>
      <ol className="list-decimal pl-4 space-y-2">
        {AGREEMENT_ITEMS.map(([title, body]) => (
          <li key={title}>
            <strong>{title}</strong> {body}
          </li>
        ))}
      </ol>
    </>
  );
}

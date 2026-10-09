// Deposit hold wording for partners and admins. The status and dates are set by the database
// (booking_deposit_holds); nothing here works out a date. Customers never receive this data.

export const oneHold = (b) => {
  const h = b?.booking_deposit_holds;
  return Array.isArray(h) ? h[0] || null : h || null;
};

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

export function holdText(h) {
  if (!h) return null;
  if (h.release_status === "held") return `Deposit held by PAXO until ${fmtWhen(h.deposit_release_at)}`;
  if (h.release_status === "releasable") return "Ready to be released to you";
  if (h.release_status === "released") return `Released on ${fmtDay(h.released_at || h.deposit_release_at)}`;
  return null;
}

// Same status, worded for PAXO staff (admin screens).
export function holdTextAdmin(h) {
  if (!h) return null;
  if (h.release_status === "held") return `Held by PAXO until ${fmtWhen(h.deposit_release_at)}`;
  if (h.release_status === "releasable") return "Ready to release to the venue";
  if (h.release_status === "released") return `Released on ${fmtDay(h.released_at || h.deposit_release_at)}`;
  return null;
}

export const holdBadgeClass = (h) =>
  h?.release_status === "released"
    ? "bg-emerald-100 text-emerald-800"
    : h?.release_status === "releasable"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-sky-100 text-sky-800";

export function DepositHoldLine({ hold }) {
  const text = holdText(hold);
  if (!text) return null;
  return (
    <span className={`text-xs font-medium px-2 py-1 rounded ${holdBadgeClass(hold)}`} data-testid="deposit-hold">
      {text}
    </span>
  );
}

// ---- admin Settlements: the amount to pay the venue ----
export const inr2 = (n) =>
  Number(n || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Amount to pay the venue = deposit paid - refund to the customer - the gateway fee deducted from that refund
// (which equals the forfeited amount). The gateway fee is never taken out of the venue's share.
// Example: deposit Rs 2,000, 50% slab, fee Rs 47.20 -> customer gets 1,000 - 47.20 = Rs 952.80; venue gets 2,000 - 952.80 - 47.20 = Rs 1,000.
export const depositToPass = (p) =>
  Math.max(
    0,
    Math.round((Number(p?.amount || 0) - Number(p?.refund_amount || 0) - Number(p?.gateway_fee_deducted || 0)) * 100) / 100
  );

export function SettlementTransfer({ p, b, Row, settlementText }) {
  const hold = oneHold(b);
  return (
    <div className="mb-4" data-testid="settlement-transfer">
      <h3 className="font-medium text-sm mb-2">3. Deposit to pass to the venue — PAXO → Partner</h3>
      <Row label="Deposit paid by the customer" value={inr2(p.amount)} />
      {Number(p.refund_amount) > 0 && <Row label="Refunded to the customer" value={inr2(p.refund_amount)} />}
      {Number(p.gateway_fee_deducted) > 0 && (
        <Row label="Gateway fee deducted from that refund (kept by PAXO)" value={inr2(p.gateway_fee_deducted)} />
      )}
      <Row label="To transfer to the venue" value={inr2(depositToPass(p))} />
      <p className="text-xs text-stone-400 py-1">Deposit paid − refund to the customer − gateway fee deducted from that refund.</p>
      {holdTextAdmin(hold) && <Row label="Release status" value={holdTextAdmin(hold)} />}
      <Row label="Settlement status" value={settlementText} />
    </div>
  );
}

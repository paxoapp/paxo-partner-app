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

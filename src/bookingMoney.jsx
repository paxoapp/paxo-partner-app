import { formatPercent, formatRupees, round2 } from "./tax";

// Booking money for the partner's "Transaction details" popup: what the booking
// costs, what the customer paid online, what the venue collects on the day, and
// PAXO's commission with its status. Partner-only — never shown to customers.

const inr = (n) =>
  Number(n || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

const fmtDateTime = (ts) =>
  ts
    ? new Date(ts).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

const fmtDate = (ts) =>
  ts ? new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";

const isDepositLike = (p) => p.payment_type === "deposit" || p.payment_type === "full";

// Money the customer has paid online for this booking (paid deposit/full
// payments), minus anything refunded. Each line is rounded to paise on its own.
export function paidOnlineAmount(booking) {
  return round2(
    (booking?.payments || [])
      .filter((p) => p.status === "paid" && isDepositLike(p))
      .reduce((sum, p) => sum + round2(Number(p.amount || 0)) - round2(Number(p.refund_amount || 0)), 0)
  );
}

export const hasPaidDeposit = (booking) =>
  (booking?.payments || []).some((p) => p.status === "paid" && isDepositLike(p));

// PAXO's commission row for this booking (from booking_commissions), or null for
// bookings made before commissions existed. Always the saved values — never
// computed in the app.
export function commissionOf(booking) {
  const rows = booking?.booking_commissions;
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  return list.find((c) => !c.kind || c.kind === "commission") || null;
}

function commissionStatusText(c) {
  switch (c.status) {
    case "pending":
      return "Fixed. Charged after the event";
    case "due":
      return `Due. Will be debited${c.due_at ? ` (${fmtDate(c.due_at)})` : ""}`;
    case "debited":
      return `Debited${c.debited_at ? ` on ${fmtDate(c.debited_at)}` : ""}`;
    case "failed":
      return `Debit failed${c.failure_reason ? `: ${c.failure_reason}` : ""}`;
    case "cancelled":
      return "Not charged (booking cancelled)";
    default:
      return c.status;
  }
}

const Row = ({ k, v, strong }) => (
  <div className="flex justify-between gap-4">
    <dt className="text-stone-500">{k}</dt>
    <dd className={`text-right ${strong ? "font-semibold" : "font-medium"}`}>{v}</dd>
  </div>
);

export default function BookingMoneyPanel({ b, payment, addonTotal = 0 }) {
  const paid = hasPaidDeposit(b);
  // Bookings made before taxes/commission were stored keep today's layout.
  const detailed = paid && b.package_value != null;
  const commission = detailed ? commissionOf(b) : null;
  const paidOnline = paidOnlineAmount(b);
  const toCollect = Math.max(0, round2(Number(b.total_amount || 0) - paidOnline));

  return (
    <>
      <div className="border-t border-stone-200 pt-3 mb-3">
        <p className="text-sm font-semibold text-stone-500 mb-1.5">Payment</p>
        <dl className="text-sm flex flex-col gap-1.5">
          {detailed ? (
            <>
              <Row k="Package value (before taxes)" v={formatRupees(b.package_value)} />
              {Number(b.tax_amount) > 0 && (
                <Row k="Taxes (the venue bills these)" v={formatRupees(b.tax_amount)} />
              )}
              <Row k="Booking total" v={formatRupees(b.total_amount)} strong />
              <Row k="Paid online (deposit)" v={formatRupees(paidOnline)} />
              <Row k="To collect at the venue" v={formatRupees(toCollect)} />
            </>
          ) : (
            <>
              <Row k="Booking total" v={inr(b.total_amount)} />
              <Row
                k={b.deposit_tier === "full" ? "Paid (full)" : `Deposit (${b.deposit_tier === "50pct" ? "50%" : "20%"})`}
                v={inr(payment?.amount ?? b.deposit_amount)}
              />
            </>
          )}
          {addonTotal > 0 && <Row k="Confirmed add-ons" v={inr(addonTotal)} />}
          <Row k="Payment status" v={<span className="capitalize">{payment?.status || "pending"}</span>} />
          <Row k="Paid at" v={fmtDateTime(payment?.paid_at)} />
        </dl>
      </div>

      {paid && (
        <div className="border-t border-stone-200 pt-3 mb-3">
          <p className="text-sm font-semibold text-stone-500 mb-1.5">Deposit settlement</p>
          <dl className="text-sm flex flex-col gap-1.5">
            <Row
              k="Deposit passed to you"
              v={payment?.settlement_status === "settled" ? `Settled on ${fmtDate(payment.settled_at)}` : "Pending"}
            />
            {payment?.settlement_notes && <Row k="Notes" v={payment.settlement_notes} />}
          </dl>
        </div>
      )}

      {commission && (
        <div className="border border-stone-200 bg-stone-50 rounded-lg p-3 mb-3" data-testid="commission-box">
          <p className="text-sm font-semibold text-stone-500 mb-1.5">PAXO commission</p>
          <dl className="text-sm flex flex-col gap-1.5">
            <Row k="Commission base" v={formatRupees(commission.base_amount)} />
            <Row k="Rate" v={`${formatPercent(commission.percent)}%`} />
            <Row k="Commission" v={formatRupees(commission.amount)} strong />
            <Row k="Status" v={commissionStatusText(commission)} />
          </dl>
        </div>
      )}
    </>
  );
}

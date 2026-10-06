import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, sb, signedFeeProofUrl, uploadFeeProof } from "./supabase";

// PAXO platform fee dues, payment reporting and receipts (partner side), plus the
// receipt itself, which the admin screens reuse. No GST anywhere in this step.
// Wording: "PAXO platform fee" — never "commission".

export const inr2 = (n) =>
  "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDay = (d) =>
  d
    ? new Date(String(d).length <= 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

export const fmtIST = (ts) =>
  ts
    ? new Date(ts).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }) + " IST"
    : "—";

const MODE_LABELS = { upi: "UPI", bank_transfer: "Bank transfer", other: "Other" };
export const MAX_TDS_RATE = 0.2;
const MAX_PROOF_BYTES = 10 * 1024 * 1024;

// What a fee looks like to the venue, from the fee status plus its payments.
export function feeState(fee, payments) {
  const mine = (payments || [])
    .filter((p) => p.fee_id === fee.id)
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
  if (fee.status === "pending") return { key: "upcoming", label: "Upcoming" };
  if (fee.status === "due") {
    if (mine.some((p) => p.status === "submitted")) return { key: "waiting", label: "Waiting for PAXO to confirm" };
    if (mine[0]?.status === "rejected") return { key: "rejected", label: "Payment rejected", reason: mine[0].rejection_reason };
    return { key: "due", label: "Due now" };
  }
  if (fee.status === "debited") return { key: "paid", label: "Paid" };
  if (fee.status === "failed") return { key: "failed", label: "Payment problem — contact PAXO" };
  return { key: "cancelled", label: "Not charged" };
}

const CHIP = {
  upcoming: "bg-stone-100 text-stone-600",
  due: "bg-amber-100 text-amber-900 ring-1 ring-amber-300 font-semibold",
  waiting: "bg-sky-100 text-sky-800",
  rejected: "bg-rose-100 text-rose-800",
  paid: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-stone-100 text-stone-500",
};
export const StateChip = ({ state }) => (
  <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${CHIP[state.key] || CHIP.upcoming}`}>{state.label}</span>
);

// ---------------------------------------------------------------- receipt ----

export function FeeReceipt({ data }) {
  const paxo = data.paxo || {};
  const v = data.venue || {};
  const b = data.booking || {};
  const f = data.fee || {};
  const p = data.payment || {};
  const Row = ({ k, v: val, strong }) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-stone-100 text-sm">
      <span className="text-stone-500">{k}</span>
      <span className={`text-right ${strong ? "font-semibold" : "font-medium"} text-stone-900`}>{val}</span>
    </div>
  );
  const H = ({ children }) => <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 mt-5 mb-1">{children}</p>;
  const venueAddress = [v.address, v.area, v.city].filter(Boolean).join(", ");
  return (
    <div className="bg-white text-stone-900 p-6" data-testid="fee-receipt" style={{ width: "100%" }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-2xl font-black tracking-tight">PAXO</p>
          <p className="text-lg font-semibold">Platform fee receipt</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-mono font-semibold">{data.receipt_number}</p>
          <p className="text-stone-500">{fmtIST(data.approved_at)}</p>
          <p className="text-emerald-700 font-medium">Approved</p>
        </div>
      </div>

      <H>Received by (PAXO)</H>
      <p className="text-sm font-medium">{paxo.legal_name || "PAXO"}</p>
      {paxo.address && <p className="text-sm text-stone-600">{paxo.address}</p>}
      {paxo.pan && <p className="text-sm text-stone-600">PAN: {paxo.pan}</p>}
      {paxo.support_email && <p className="text-sm text-stone-600">{paxo.support_email}</p>}

      <H>Received from (Venue)</H>
      <p className="text-sm font-medium">{v.name}</p>
      {venueAddress && <p className="text-sm text-stone-600">{venueAddress}</p>}
      {v.gst_no && <p className="text-sm text-stone-600">GSTIN: {v.gst_no}</p>}
      {v.owner_name && <p className="text-sm text-stone-600">Contact person: {v.owner_name}</p>}
      {v.contact_phone && <p className="text-sm text-stone-600">Phone: {v.contact_phone}</p>}

      <H>Booking details</H>
      <Row k="Booking reference" v={b.ref} />
      <Row k="Package" v={b.package || "—"} />
      <Row k="Guests" v={b.headcount} />
      <Row k="Event" v={`${fmtDay(b.event_date)}${b.event_time ? ", " + String(b.event_time).slice(0, 5) : ""}`} />
      <Row k="Booking total" v={inr2(b.total_amount)} />
      <Row k="Deposit paid online by the customer (passed to the venue)" v={inr2(b.paid_online)} />
      <Row k="Balance collected by the venue" v={inr2(b.to_collect_at_venue)} />

      <H>Platform fee</H>
      <Row k="Fee rate" v={`${Number(f.percent)}% of booking value ${inr2(f.base_amount)}`} />
      <Row k="Platform fee amount" v={inr2(f.amount)} />
      <Row k="TDS deducted" v={inr2(f.tds_amount)} />
      <Row k="Total received" v={inr2(f.amount_paid)} strong />

      <H>Payment details</H>
      <Row k="Paid on" v={fmtIST(p.paid_at)} />
      <Row k="Mode" v={MODE_LABELS[p.mode] || p.mode} />
      <Row k="UTR / reference" v={p.utr} />
      {paxo.account_last4 && <Row k="Paid to account" v={`ending ${paxo.account_last4}`} />}
      <Row k="Approved by" v={`${p.approved_by || "PAXO"}, ${fmtIST(p.approved_at)}`} />

      <p className="text-xs text-stone-500 mt-6 leading-relaxed">
        This platform fee is for services provided by PAXO to the venue. The venue's final bill to the customer is the
        venue's own tax invoice. This is a receipt of payment, not a tax invoice. This is a computer-generated receipt
        and needs no signature.
      </p>
    </div>
  );
}

// Render the receipt block to an A4 PDF and download it (same method as the
// customer app's receipt: html2pdf on an off-screen clone).
export async function downloadReceiptPdf(node, receiptNumber) {
  const { default: html2pdf } = await import("html2pdf.js");
  const clone = node.cloneNode(true);
  clone.style.width = "700px";
  clone.style.color = "#1c1917";
  clone.style.background = "#ffffff";
  const holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-10000px;top:0;background:#ffffff";
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    await html2pdf()
      .set({
        margin: 10,
        filename: `${receiptNumber || "platform-fee-receipt"}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: "#ffffff", useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(clone)
      .save();
  } finally {
    document.body.removeChild(holder);
  }
}

export function ReceiptModal({ data, onClose, autoDownload }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const download = useCallback(async () => {
    if (!ref.current || busy) return;
    setBusy(true);
    setErr("");
    try {
      await downloadReceiptPdf(ref.current, data.receipt_number);
    } catch (e) {
      console.error(e);
      setErr("Couldn't create the PDF. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, data.receipt_number]);
  useEffect(() => {
    if (autoDownload) download();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Platform fee receipt" onClick={onClose}>
      <div className="bg-stone-100 rounded-xl max-w-2xl w-full shadow-xl my-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-stone-200 bg-white rounded-t-xl print:hidden">
          <p className="font-medium text-sm">Platform fee receipt</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={download} disabled={busy} className="text-sm bg-accent text-slate-900 font-medium px-3 py-1.5 rounded-lg disabled:opacity-60">
              {busy ? "Preparing…" : "Download PDF"}
            </button>
            <button type="button" onClick={onClose} className="text-sm text-stone-500 hover:text-stone-800 px-2">Close</button>
          </div>
        </div>
        {err && <p className="text-xs text-rose-600 px-4 pt-2">{err}</p>}
        <div ref={ref}>
          <FeeReceipt data={data} />
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- Pay now ----

const inputCls = "border border-stone-300 rounded px-3 py-2 text-sm w-full bg-white";

export function PayNowSheet({ fee, company, onClose, onSubmit, busy, error }) {
  const today = new Date().toISOString().slice(0, 10);
  const [tds, setTds] = useState("");
  const [mode, setMode] = useState("upi");
  const [utr, setUtr] = useState("");
  const [date, setDate] = useState(today);
  const [file, setFile] = useState(null);
  const [localErr, setLocalErr] = useState("");
  const fee_amount = Number(fee.amount);
  const tdsNum = tds === "" ? 0 : Number(tds);
  const maxTds = Math.round(fee_amount * MAX_TDS_RATE * 100) / 100;
  const amountPaid = Math.round((fee_amount - (Number.isFinite(tdsNum) ? tdsNum : 0)) * 100) / 100;
  const hasDetails = !!(company && (company.account_number || company.upi_id));
  const ref = fee.bookings?.booking_ref;

  function submit(e) {
    e.preventDefault();
    setLocalErr("");
    if (!Number.isFinite(tdsNum) || tdsNum < 0) return setLocalErr("TDS must be 0 or more.");
    if (tdsNum > maxTds) return setLocalErr("TDS cannot be more than 20% of the fee.");
    if (!utr.trim()) return setLocalErr("Enter the UTR / reference number.");
    if (!date || date > today) return setLocalErr("Choose the payment date (not in the future).");
    if (!file) return setLocalErr("Upload a screenshot or PDF of the payment.");
    if (file.size > MAX_PROOF_BYTES) return setLocalErr("The proof file must be under 10 MB.");
    if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type)) return setLocalErr("Upload a JPG, PNG, WebP or PDF file.");
    onSubmit({ tds: tdsNum, mode, utr: utr.trim(), paidAt: date === today ? new Date().toISOString() : `${date}T12:00:00+05:30`, file });
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Pay PAXO platform fee" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 shadow-xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="font-serif text-xl">Pay PAXO platform fee</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 text-sm">Close</button>
        </div>

        <div className="border border-stone-200 rounded-lg p-3 mb-4 bg-stone-50 text-sm" data-testid="paxo-bank-details">
          <p className="text-xs font-semibold text-stone-500 mb-1.5">Pay to PAXO</p>
          {hasDetails ? (
            <dl className="flex flex-col gap-1">
              {[
                ["Account holder", company.account_holder],
                ["Bank", company.bank_name],
                ["Account number", company.account_number],
                ["IFSC", company.ifsc],
                ["UPI ID", company.upi_id],
              ]
                .filter(([, val]) => val)
                .map(([k, val]) => (
                  <div key={k} className="flex justify-between gap-3">
                    <dt className="text-stone-500">{k}</dt>
                    <dd className="font-medium text-right break-all">{val}</dd>
                  </div>
                ))}
              <p className="text-xs text-stone-500 mt-1.5">
                Quote <span className="font-mono font-semibold text-stone-800">{ref}</span> in the payment note.
              </p>
            </dl>
          ) : (
            <p className="text-stone-600">PAXO will share payment details soon.</p>
          )}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <fieldset disabled={!hasDetails || busy} className="flex flex-col gap-3 disabled:opacity-50">
            <div>
              <label className="text-sm font-medium block mb-1">Platform fee</label>
              <input className={`${inputCls} bg-stone-100`} readOnly value={inr2(fee_amount)} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">TDS deducted (optional)</label>
              <input type="number" min="0" step="0.01" className={inputCls} value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0" />
              <p className="text-xs text-stone-500 mt-1">Up to {inr2(maxTds)} (20% of the fee).</p>
            </div>
            <div className="flex justify-between items-center text-sm bg-stone-50 border border-stone-200 rounded px-3 py-2">
              <span className="text-stone-500">Amount to pay (fee minus TDS)</span>
              <span className="font-semibold">{inr2(amountPaid)}</span>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Payment mode</label>
              <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="upi">UPI</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">UTR / reference number</label>
              <input className={inputCls} value={utr} onChange={(e) => setUtr(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Payment date</label>
              <input type="date" max={today} className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Proof (screenshot or PDF)</label>
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
          </fieldset>
          {(localErr || error) && <p className="text-sm text-rose-600">{localErr || error}</p>}
          <button type="submit" disabled={!hasDetails || busy} className="bg-accent text-slate-900 font-medium rounded-lg px-4 py-2.5 text-sm disabled:opacity-50">
            {busy ? "Submitting…" : "Submit payment for review"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the screen ----

export function FeesView({ fees, payments, tab, setTab, onPay, onViewReceipt, onDownloadReceipt, loading }) {
  const sum = (arr) => arr.reduce((s, f) => s + Number(f.amount || 0), 0);
  const dueFees = fees.filter((f) => f.status === "due");
  const upcomingFees = fees.filter((f) => f.status === "pending");
  const paidFees = fees.filter((f) => f.status === "debited");
  const approvedFor = (fee) =>
    (payments || []).filter((p) => p.fee_id === fee.id && p.status === "approved").sort((a, b) => new Date(b.reviewed_at) - new Date(a.reviewed_at))[0];
  const order = { due: 0, rejected: 1, waiting: 2, upcoming: 3, failed: 4 };
  const dues = fees
    .filter((f) => ["due", "pending", "failed"].includes(f.status))
    .map((f) => ({ fee: f, state: feeState(f, payments) }))
    .sort((a, b) => (order[a.state.key] ?? 9) - (order[b.state.key] ?? 9) || String(a.fee.bookings?.event_date).localeCompare(String(b.fee.bookings?.event_date)));
  const cleared = paidFees
    .map((f) => ({ fee: f, pay: approvedFor(f) }))
    .filter((r) => r.pay)
    .sort((a, b) => new Date(b.pay.paid_at) - new Date(a.pay.paid_at));
  const tdsTotal = cleared.reduce((s, r) => s + Number(r.pay.tds_amount || 0), 0);

  return (
    <div>
      <h1 className="font-serif text-2xl mb-1">PAXO fees</h1>
      <p className="text-sm text-stone-500 mb-5">The PAXO platform fee on each booking. You receive the full booking money; this fee is paid to PAXO separately.</p>

      <div className="flex flex-wrap gap-4 mb-6">
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-5 flex-1 min-w-[200px]" data-testid="card-due">
          <p className="text-xs text-amber-800 font-medium">Due now</p>
          <p className="text-2xl font-semibold text-amber-900">{inr2(sum(dueFees))}</p>
          <p className="text-xs text-amber-800 mt-0.5">{dueFees.length} fee{dueFees.length === 1 ? "" : "s"}</p>
        </div>
        <div className="bg-white border border-stone-200 rounded-xl p-5 flex-1 min-w-[200px]" data-testid="card-upcoming">
          <p className="text-xs text-stone-500">Upcoming</p>
          <p className="text-2xl font-medium">{inr2(sum(upcomingFees))}</p>
          <p className="text-xs text-stone-500 mt-0.5">{upcomingFees.length} booking{upcomingFees.length === 1 ? "" : "s"} not finished yet</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-5 flex-1 min-w-[200px]" data-testid="card-paid">
          <p className="text-xs text-emerald-800">Paid to PAXO</p>
          <p className="text-2xl font-medium text-emerald-900">{inr2(sum(paidFees))}</p>
          <p className="text-xs text-emerald-800 mt-0.5">{paidFees.length} fee{paidFees.length === 1 ? "" : "s"}{tdsTotal > 0 ? ` · TDS ${inr2(tdsTotal)}` : ""}</p>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {[["dues", "Dues"], ["cleared", "Cleared"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`text-sm px-3 py-1.5 rounded border ${tab === k ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600"}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="text-stone-400 text-sm">Loading…</p>}

      {tab === "dues" && (
        <div className="flex flex-col gap-3" data-testid="dues-list">
          {dues.map(({ fee, state }) => {
            const bk = fee.bookings || {};
            return (
              <div key={fee.id} className={`rounded-xl p-4 bg-white flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${state.key === "due" ? "border-2 border-amber-300" : "border border-stone-200"}`}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm flex-1">
                  <div>
                    <p className="text-xs text-stone-400">Booking</p>
                    <p className="font-mono font-medium">{bk.booking_ref || fee.booking_id.slice(0, 8).toUpperCase()}</p>
                    <p className="text-xs text-stone-500">{fmtDay(bk.event_date)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-stone-400">Booking value</p>
                    <p className="font-medium">{inr2(fee.base_amount)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-stone-400">Platform fee</p>
                    <p className="font-medium">{inr2(fee.amount)}</p>
                    <p className="text-xs text-stone-500">{Number(fee.percent)}% rate</p>
                  </div>
                  <div>
                    <p className="text-xs text-stone-400">Due date</p>
                    <p className="font-medium">{fee.status === "pending" ? "After the event" : fmtDay(fee.due_at)}</p>
                  </div>
                </div>
                <div className="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
                  <StateChip state={state} />
                  {state.key === "rejected" && state.reason && <p className="text-xs text-rose-700 max-w-[240px] sm:text-right">Reason: {state.reason}</p>}
                  {(state.key === "due" || state.key === "rejected") && (
                    <button type="button" onClick={() => onPay(fee)} className="bg-accent text-slate-900 text-sm font-medium px-4 py-1.5 rounded-lg">
                      {state.key === "rejected" ? "Pay again" : "Pay now"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!loading && dues.length === 0 && <p className="text-stone-400 text-sm">Nothing to pay right now.</p>}
        </div>
      )}

      {tab === "cleared" && (
        <div className="flex flex-col gap-3" data-testid="cleared-list">
          {cleared.map(({ fee, pay }) => (
            <div key={fee.id} className="border border-stone-200 rounded-xl p-4 bg-white flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm flex-1">
                <div>
                  <p className="text-xs text-stone-400">Booking</p>
                  <p className="font-mono font-medium">{fee.bookings?.booking_ref}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-400">Fee / TDS</p>
                  <p className="font-medium">{inr2(fee.amount)}</p>
                  <p className="text-xs text-stone-500">TDS {inr2(pay.tds_amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-400">Paid on</p>
                  <p className="font-medium">{fmtDay(pay.paid_at)}</p>
                </div>
                <div>
                  <p className="text-xs text-stone-400">Receipt</p>
                  <p className="font-mono font-medium">{pay.receipt_number}</p>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={() => onViewReceipt(pay)} className="border border-stone-300 text-stone-700 text-sm px-3 py-1.5 rounded-lg hover:bg-stone-50">View receipt</button>
                <button type="button" onClick={() => onDownloadReceipt(pay)} className="bg-accent text-slate-900 text-sm font-medium px-3 py-1.5 rounded-lg">Download</button>
              </div>
            </div>
          ))}
          {!loading && cleared.length === 0 && <p className="text-stone-400 text-sm">No paid fees yet.</p>}
        </div>
      )}
    </div>
  );
}

// Container: loads this venue's fees, payments and PAXO's payment details.
export default function PartnerFees({ token, venueId }) {
  const [fees, setFees] = useState([]);
  const [payments, setPayments] = useState([]);
  const [company, setCompany] = useState(null);
  const [tab, setTab] = useState("dues");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [payFee, setPayFee] = useState(null);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState("");
  const [receipt, setReceipt] = useState(null); // { data, autoDownload }

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [f, p, c] = await Promise.all([
        sb(`/rest/v1/booking_commissions?venue_id=eq.${venueId}&kind=eq.commission&select=id,booking_id,base_amount,percent,amount,status,due_at,debited_at,bookings(booking_ref,event_date,event_time,package_value,total_amount)&order=created_at.desc`, { token }),
        sb(`/rest/v1/platform_fee_payments?venue_id=eq.${venueId}&select=id,fee_id,status,amount_paid,tds_amount,paid_at,receipt_number,rejection_reason,submitted_at,reviewed_at&order=submitted_at.desc`, { token }),
        sb(`/rest/v1/platform_company_details?select=account_holder,bank_name,account_number,ifsc,upi_id`, { token }),
      ]);
      setFees(f || []);
      setPayments(p || []);
      setCompany((c || [])[0] || null);
    } catch (e) {
      console.error(e);
      setLoadError("Couldn't load your PAXO fees. Please refresh.");
    } finally {
      setLoading(false);
    }
  }, [token, venueId]);
  useEffect(() => {
    load();
  }, [load]);

  async function submitPayment({ tds, mode, utr, paidAt, file }) {
    setBusy(true);
    setPayError("");
    try {
      const proofPath = await uploadFeeProof(token, venueId, payFee.id, file);
      await rpc(token, "submit_platform_fee_payment", {
        p_fee_id: payFee.id,
        p_tds: tds,
        p_mode: mode,
        p_utr: utr,
        p_paid_at: paidAt,
        p_proof_path: proofPath,
      });
      setPayFee(null);
      await load();
    } catch (e) {
      setPayError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openReceipt(pay, autoDownload) {
    try {
      const data = await rpc(token, "get_platform_fee_receipt", { p_payment_id: pay.id });
      setReceipt({ data, autoDownload });
    } catch (e) {
      setLoadError(e.message);
    }
  }

  return (
    <div>
      {loadError && <p className="text-sm text-rose-600 mb-3">{loadError}</p>}
      <FeesView
        fees={fees}
        payments={payments}
        tab={tab}
        setTab={setTab}
        loading={loading}
        onPay={(fee) => {
          setPayError("");
          setPayFee(fee);
        }}
        onViewReceipt={(pay) => openReceipt(pay, false)}
        onDownloadReceipt={(pay) => openReceipt(pay, true)}
      />
      {payFee && <PayNowSheet fee={payFee} company={company} busy={busy} error={payError} onClose={() => setPayFee(null)} onSubmit={submitPayment} />}
      {receipt && <ReceiptModal data={receipt.data} autoDownload={receipt.autoDownload} onClose={() => setReceipt(null)} />}
    </div>
  );
}

export { signedFeeProofUrl };

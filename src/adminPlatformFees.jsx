import { useCallback, useEffect, useState } from "react";
import { rpc, sb, signedFeeProofUrl, uploadFeeProof } from "./supabase";
import { ReceiptModal, feeState, fmtDay, fmtIST, inr2 } from "./platformFees";

// Admin "Platform fees" section: review queue, ledger, record a payment received
// directly, and PAXO's own company / bank details. The old settlement screens are
// untouched. No GST anywhere.

const MODE_LABELS = { upi: "UPI", bank_transfer: "Bank transfer", other: "Other" };
const inputCls = "border border-slate-300 rounded px-3 py-2 text-sm w-full bg-white";
const pill = (active) =>
  `text-sm px-3 py-1.5 rounded border ${active ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"}`;

const LEDGER_STATUS = [
  ["all", "All"],
  ["upcoming", "Upcoming"],
  ["due", "Due"],
  ["waiting", "Waiting"],
  ["paid", "Paid"],
  ["cancelled", "Cancelled"],
];

// ---- presentational pieces (data comes in as props) ----

export function ReviewQueueView({ queue, onApprove, onReject, onOpenProof, busyId, rejectingId, setRejectingId, reason, setReason, error }) {
  return (
    <div className="flex flex-col gap-3" data-testid="review-queue">
      {queue.map((p) => (
        <div key={p.id} className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium">{p.venues?.name || "—"}</p>
              <p className="text-xs text-slate-500 font-mono">{p.bookings?.booking_ref}</p>
            </div>
            <p className="text-xs text-slate-400">Submitted {fmtIST(p.submitted_at)}</p>
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm mt-3">
            <div><dt className="text-xs text-slate-400">Platform fee</dt><dd className="font-medium">{inr2(p.booking_commissions?.amount)}</dd></div>
            <div><dt className="text-xs text-slate-400">TDS</dt><dd className="font-medium">{inr2(p.tds_amount)}</dd></div>
            <div><dt className="text-xs text-slate-400">Amount paid</dt><dd className="font-semibold">{inr2(p.amount_paid)}</dd></div>
            <div><dt className="text-xs text-slate-400">Mode</dt><dd className="font-medium">{MODE_LABELS[p.payment_mode] || p.payment_mode}</dd></div>
            <div><dt className="text-xs text-slate-400">UTR</dt><dd className="font-mono font-medium break-all">{p.utr}</dd></div>
            <div><dt className="text-xs text-slate-400">Paid on</dt><dd className="font-medium">{fmtIST(p.paid_at)}</dd></div>
            <div>
              <dt className="text-xs text-slate-400">Proof</dt>
              <dd>
                {p.proof_path ? (
                  <button type="button" onClick={() => onOpenProof(p)} className="text-sky-700 underline underline-offset-2 text-sm">Open file</button>
                ) : (
                  <span className="text-slate-400">—</span>
                )}
              </dd>
            </div>
          </dl>
          {rejectingId === p.id ? (
            <div className="mt-3 flex flex-col gap-2">
              <textarea className={inputCls} rows={2} placeholder="Reason for rejecting (the venue will see this)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2">
                <button type="button" disabled={busyId === p.id || !reason.trim()} onClick={() => onReject(p)} className="bg-rose-600 text-white text-sm px-3 py-1.5 rounded-lg disabled:opacity-50">Confirm reject</button>
                <button type="button" onClick={() => { setRejectingId(null); setReason(""); }} className="text-sm text-slate-500 px-2">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={busyId === p.id} onClick={() => onApprove(p)} className="bg-emerald-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg disabled:opacity-50">Approve</button>
              <button type="button" disabled={busyId === p.id} onClick={() => { setRejectingId(p.id); setReason(""); }} className="border border-rose-300 text-rose-700 text-sm px-4 py-1.5 rounded-lg">Reject</button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {queue.length === 0 && <p className="text-slate-400 text-sm">No payments waiting for review.</p>}
    </div>
  );
}

const LEDGER_CHIP = {
  upcoming: "bg-slate-100 text-slate-600",
  due: "bg-amber-100 text-amber-900",
  waiting: "bg-sky-100 text-sky-800",
  rejected: "bg-amber-100 text-amber-900",
  paid: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-slate-100 text-slate-500",
};

// Ledger bucket for a fee: a rejected payment leaves the fee "due".
const ledgerKey = (state) => (state.key === "rejected" ? "due" : state.key);

export function LedgerView({ fees, payments, venues, venueFilter, setVenueFilter, statusFilter, setStatusFilter, onReceipt }) {
  const rows = fees
    .filter((f) => !venueFilter || f.venue_id === venueFilter)
    .map((f) => ({ fee: f, state: feeState(f, payments) }));
  const totals = {};
  for (const r of rows) {
    const k = ledgerKey(r.state);
    totals[k] = totals[k] || { n: 0, sum: 0 };
    totals[k].n += 1;
    totals[k].sum += Number(r.fee.amount || 0);
  }
  const shown = rows.filter((r) => statusFilter === "all" || ledgerKey(r.state) === statusFilter);
  const approvedFor = (fee) => payments.find((p) => p.fee_id === fee.id && p.status === "approved");
  return (
    <div data-testid="ledger">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="border border-slate-300 rounded px-3 py-1.5 text-sm bg-white" value={venueFilter} onChange={(e) => setVenueFilter(e.target.value)}>
          <option value="">All venues</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {LEDGER_STATUS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setStatusFilter(k)} className={pill(statusFilter === k)}>{label}</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 mb-4 text-sm">
        {LEDGER_STATUS.filter(([k]) => k !== "all").map(([k, label]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-lg px-3 py-2 min-w-[120px]">
            <p className="text-xs text-slate-400">{label}</p>
            <p className="font-semibold">{inr2(totals[k]?.sum || 0)}</p>
            <p className="text-xs text-slate-400">{totals[k]?.n || 0} fee{(totals[k]?.n || 0) === 1 ? "" : "s"}</p>
          </div>
        ))}
      </div>
      <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 border-b border-slate-200">
              <th className="px-4 py-2 font-medium">Venue</th>
              <th className="px-4 py-2 font-medium">Booking</th>
              <th className="px-4 py-2 font-medium text-right">Fee</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ fee, state }) => {
              const pay = approvedFor(fee);
              return (
                <tr key={fee.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5">{fee.venues?.name || "—"}</td>
                  <td className="px-4 py-2.5"><span className="font-mono">{fee.bookings?.booking_ref}</span><span className="block text-xs text-slate-400">{fmtDay(fee.bookings?.event_date)}</span></td>
                  <td className="px-4 py-2.5 text-right">{inr2(fee.amount)}<span className="block text-xs text-slate-400">{Number(fee.percent)}% of {inr2(fee.base_amount)}</span></td>
                  <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full ${LEDGER_CHIP[state.key] || LEDGER_CHIP.upcoming}`}>{state.key === "rejected" ? "Due (payment rejected)" : state.label}</span></td>
                  <td className="px-4 py-2.5">
                    {pay ? (
                      <button type="button" onClick={() => onReceipt(pay)} className="text-sky-700 underline underline-offset-2 font-mono text-xs">{pay.receipt_number}</button>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-slate-400">No fees match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RecordPaymentView({ dueFees, onSubmit, busy, message, error }) {
  const today = new Date().toISOString().slice(0, 10);
  const [feeId, setFeeId] = useState("");
  const [tds, setTds] = useState("");
  const [mode, setMode] = useState("bank_transfer");
  const [utr, setUtr] = useState("");
  const [date, setDate] = useState(today);
  const [file, setFile] = useState(null);
  const fee = dueFees.find((f) => f.id === feeId);
  const tdsNum = tds === "" ? 0 : Number(tds);
  return (
    <form
      className="bg-white border border-slate-200 rounded-xl p-5 max-w-lg flex flex-col gap-3"
      data-testid="record-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ feeId, fee, tds: tdsNum, mode, utr: utr.trim(), paidAt: date === today ? new Date().toISOString() : `${date}T12:00:00+05:30`, file });
      }}
    >
      <p className="text-sm text-slate-500">Use this when a venue paid PAXO and told you directly. It creates an approved payment and a receipt straight away.</p>
      <div>
        <label className="text-sm font-medium block mb-1">Fee</label>
        <select required className={inputCls} value={feeId} onChange={(e) => setFeeId(e.target.value)}>
          <option value="">Choose a due fee…</option>
          {dueFees.map((f) => (
            <option key={f.id} value={f.id}>{f.venues?.name} · {f.bookings?.booking_ref} · {inr2(f.amount)}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium block mb-1">TDS deducted</label>
          <input type="number" min="0" step="0.01" className={inputCls} value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">Amount received</label>
          <input readOnly className={`${inputCls} bg-slate-100`} value={fee ? inr2(Math.round((Number(fee.amount) - (Number.isFinite(tdsNum) ? tdsNum : 0)) * 100) / 100) : "—"} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium block mb-1">Mode</label>
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="upi">UPI</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">Payment date</label>
          <input type="date" max={today} required className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="text-sm font-medium block mb-1">UTR / reference (required)</label>
        <input required className={inputCls} value={utr} onChange={(e) => setUtr(e.target.value)} />
      </div>
      <div>
        <label className="text-sm font-medium block mb-1">Proof (optional)</label>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {message && <p className="text-sm text-emerald-700">{message}</p>}
      <button type="submit" disabled={busy || !feeId} className="bg-slate-900 text-white text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50 self-start">
        {busy ? "Recording…" : "Record payment and issue receipt"}
      </button>
    </form>
  );
}

const COMPANY_FIELDS = [
  ["legal_name", "Legal entity name"],
  ["address", "Address"],
  ["pan", "PAN"],
  ["support_email", "Support email"],
  ["account_holder", "Bank account holder"],
  ["bank_name", "Bank"],
  ["account_number", "Account number"],
  ["ifsc", "IFSC"],
  ["upi_id", "UPI ID"],
];

export function CompanyDetailsView({ values, setValues, onSave, busy, message, error }) {
  return (
    <form className="bg-white border border-slate-200 rounded-xl p-5 max-w-lg flex flex-col gap-3" data-testid="company-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <p className="text-sm text-slate-500">These appear on platform fee receipts (only the last 4 digits of the account number) and in the venues' Pay now screen.</p>
      {COMPANY_FIELDS.map(([k, label]) => (
        <div key={k}>
          <label className="text-sm font-medium block mb-1">{label}</label>
          <input className={inputCls} value={values[k] || ""} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
        </div>
      ))}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {message && <p className="text-sm text-emerald-700">{message}</p>}
      <button type="submit" disabled={busy} className="bg-slate-900 text-white text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-50 self-start">{busy ? "Saving…" : "Save details"}</button>
    </form>
  );
}

// ---- container ----

export default function PlatformFeesAdmin({ session }) {
  const token = session.token;
  const [tab, setTab] = useState("queue");
  const [fees, setFees] = useState([]);
  const [payments, setPayments] = useState([]);
  const [venues, setVenues] = useState([]);
  const [company, setCompany] = useState({});
  const [loadError, setLoadError] = useState("");
  const [venueFilter, setVenueFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [busyId, setBusyId] = useState(null);
  const [rejectingId, setRejectingId] = useState(null);
  const [reason, setReason] = useState("");
  const [queueError, setQueueError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [recBusy, setRecBusy] = useState(false);
  const [recMsg, setRecMsg] = useState("");
  const [recErr, setRecErr] = useState("");
  const [coBusy, setCoBusy] = useState(false);
  const [coMsg, setCoMsg] = useState("");
  const [coErr, setCoErr] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const [f, p, v, c] = await Promise.all([
        sb(`/rest/v1/booking_commissions?kind=eq.commission&select=id,venue_id,booking_id,base_amount,percent,amount,status,due_at,debited_at,venues(name),bookings(booking_ref,event_date)&order=created_at.desc&limit=2000`, { token }),
        sb(`/rest/v1/platform_fee_payments?select=*,venues(name),bookings(booking_ref),booking_commissions(amount,percent,base_amount)&order=submitted_at.desc&limit=2000`, { token }),
        sb(`/rest/v1/venues?select=id,name&order=name.asc`, { token }),
        sb(`/rest/v1/platform_company_details?select=*`, { token }),
      ]);
      setFees(f || []);
      setPayments(p || []);
      setVenues(v || []);
      setCompany((c || [])[0] || {});
    } catch (e) {
      console.error(e);
      setLoadError("Couldn't load platform fees. Please refresh.");
    }
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const queue = payments.filter((p) => p.status === "submitted");
  const dueFees = fees.filter((f) => feeState(f, payments).key === "due" || feeState(f, payments).key === "rejected");

  async function approve(p) {
    setBusyId(p.id);
    setQueueError("");
    try {
      await rpc(token, "review_platform_fee_payment", { p_payment_id: p.id, p_approve: true, p_reason: null });
      await load();
    } catch (e) {
      setQueueError(e.message);
    } finally {
      setBusyId(null);
    }
  }
  async function reject(p) {
    setBusyId(p.id);
    setQueueError("");
    try {
      await rpc(token, "review_platform_fee_payment", { p_payment_id: p.id, p_approve: false, p_reason: reason.trim() });
      setRejectingId(null);
      setReason("");
      await load();
    } catch (e) {
      setQueueError(e.message);
    } finally {
      setBusyId(null);
    }
  }
  async function openProof(p) {
    try {
      const url = await signedFeeProofUrl(token, p.proof_path);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setQueueError(e.message);
    }
  }
  async function openReceipt(pay) {
    try {
      const data = await rpc(token, "get_platform_fee_receipt", { p_payment_id: pay.id });
      setReceipt(data);
    } catch (e) {
      setLoadError(e.message);
    }
  }
  async function record({ feeId, fee, tds, mode, utr, paidAt, file }) {
    setRecBusy(true);
    setRecErr("");
    setRecMsg("");
    try {
      const proof = file ? await uploadFeeProof(token, fee.venue_id, feeId, file) : null;
      const no = await rpc(token, "admin_record_platform_fee_payment", {
        p_fee_id: feeId, p_tds: tds, p_mode: mode, p_utr: utr, p_paid_at: paidAt, p_proof_path: proof,
      });
      setRecMsg(`Recorded. Receipt ${no} issued.`);
      await load();
    } catch (e) {
      setRecErr(e.message);
    } finally {
      setRecBusy(false);
    }
  }
  async function saveCompany() {
    setCoBusy(true);
    setCoErr("");
    setCoMsg("");
    try {
      const body = Object.fromEntries(COMPANY_FIELDS.map(([k]) => [k, (company[k] || "").trim() || null]));
      await sb(`/rest/v1/platform_company_details?id=eq.true`, { method: "PATCH", token, body, prefer: "return=minimal" });
      setCoMsg("Saved.");
    } catch (e) {
      setCoErr(e.message);
    } finally {
      setCoBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Platform fees</h1>
      {loadError && <p className="text-sm text-rose-600 mb-3">{loadError}</p>}
      <div className="flex flex-wrap gap-2 mb-5">
        {[["queue", `Review queue${queue.length ? ` (${queue.length})` : ""}`], ["ledger", "Ledger"], ["record", "Record payment received"], ["company", "PAXO company details"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={pill(tab === k)}>{label}</button>
        ))}
      </div>
      {tab === "queue" && (
        <ReviewQueueView queue={queue} onApprove={approve} onReject={reject} onOpenProof={openProof} busyId={busyId} rejectingId={rejectingId} setRejectingId={setRejectingId} reason={reason} setReason={setReason} error={queueError} />
      )}
      {tab === "ledger" && (
        <LedgerView fees={fees} payments={payments} venues={venues} venueFilter={venueFilter} setVenueFilter={setVenueFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} onReceipt={openReceipt} />
      )}
      {tab === "record" && <RecordPaymentView dueFees={dueFees} onSubmit={record} busy={recBusy} message={recMsg} error={recErr} />}
      {tab === "company" && <CompanyDetailsView values={company} setValues={setCompany} onSave={saveCompany} busy={coBusy} message={coMsg} error={coErr} />}
      {receipt && <ReceiptModal data={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

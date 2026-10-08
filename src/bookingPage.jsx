import { useState } from "react";
import { rpc } from "./supabase";
import { formatRupees, round2 } from "./tax";
import { commissionOf, hasPaidDeposit, paidOnlineAmount } from "./bookingMoney";
import { feeState, fmtDay, fmtIST, StateChip } from "./platformFees";

// One page per booking: timeline, money, check-in, balance received (with the
// customer's 6-digit code), and PAXO's platform fee. Partner side only.

const CASH_WARNING_LIMIT = 200000;
export const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const oneRow = (v) => (Array.isArray(v) ? v[0] || null : v || null);
export const balanceOf = (b) => oneRow(b?.booking_balance_payments);

// What the venue sees when the check-in call returns a code problem.
export function checkinErrorText(res) {
  switch (res?.reason) {
    case "wrong_code":
      return `That code isn't right. ${res.attempts_left} ${res.attempts_left === 1 ? "try" : "tries"} left.`;
    case "locked":
      return "Too many wrong tries. Ask the customer to generate a new code.";
    case "expired":
      return "This code has expired. Ask the customer to generate a new code.";
    case "no_code":
      return "The customer hasn't generated a check-in code yet. Ask them to open their booking and tap “Generate check-in code”.";
    case "already_checked_in":
      return "This booking is already checked in.";
    default:
      return "Couldn't check the code. Please try again.";
  }
}

// What the venue sees when the balance call returns a code problem.
export function balanceErrorText(res) {
  switch (res?.reason) {
    case "wrong_code":
      return `That code isn't right. ${res.attempts_left} ${res.attempts_left === 1 ? "try" : "tries"} left.`;
    case "locked":
      return "Too many wrong tries. Ask the customer to generate a new code.";
    case "expired":
      return "This code has expired. Ask the customer to generate a new code.";
    case "no_code":
      return "The customer hasn't generated a code yet. Ask them to tap “Pay at the venue” in their app.";
    default:
      return "Couldn't record the balance. Please try again.";
  }
}

const Row = ({ k, v, strong }) => (
  <div className="flex justify-between gap-4 py-1.5 border-b border-stone-100 text-sm">
    <span className="text-stone-500">{k}</span>
    <span className={`text-right ${strong ? "font-semibold" : "font-medium"} text-stone-900`}>{v}</span>
  </div>
);
const Section = ({ title, children, testid }) => (
  <section className="border-t border-stone-200 pt-4 mt-4" data-testid={testid}>
    <p className="text-sm font-semibold text-stone-500 mb-2">{title}</p>
    {children}
  </section>
);

function buildTimeline(b, pays, balance) {
  const dep = pays.filter((p) => p.status === "paid" && (p.payment_type === "deposit" || p.payment_type === "full"))
    .sort((a, c) => new Date(a.paid_at) - new Date(c.paid_at))[0];
  const accepted = !["pending", "rejected"].includes(b.status);
  const steps = [
    { key: "requested", label: "Requested", time: b.requested_at, done: true },
    {
      key: "accepted",
      label: b.status === "rejected" ? "Rejected" : "Accepted",
      time: b.status === "rejected" || accepted ? b.responded_at : null,
      done: b.status === "rejected" || accepted,
    },
  ];
  if (b.status !== "rejected") {
    steps.push({
      key: "deposit",
      label: dep ? `Deposit received — ${formatRupees(dep.amount)}` : "Deposit received",
      time: dep?.paid_at,
      done: !!dep,
    });
    steps.push({ key: "checkin", label: "Check-in done", time: b.event_started_at, done: !!b.event_started_at });
    steps.push({
      key: "balance",
      label: balance ? `Balance received — ${formatRupees(balance.amount_received)}, ${balance.mode === "cash" ? "cash" : "online"}` : "Balance received",
      time: balance?.received_at,
      done: !!balance,
    });
    steps.push({
      key: "completed",
      label: "Completed",
      time: b.completed_at || (b.status === "completed" ? balance?.received_at : null),
      done: b.status === "completed",
    });
  }
  if (["cancelled", "payment_expired", "no_show"].includes(b.status)) {
    steps.push({
      key: "ended",
      label: b.status === "cancelled" ? "Cancelled" : b.status === "no_show" ? "Marked as no-show" : "Payment window expired",
      time: b.cancelled_at,
      done: true,
    });
  }
  return steps;
}

export function Timeline({ steps }) {
  return (
    <ol className="flex flex-col gap-2.5" data-testid="timeline">
      {steps.map((s) => (
        <li key={s.key} className="flex items-start gap-3 text-sm">
          <span className={`mt-1 inline-block w-2.5 h-2.5 rounded-full shrink-0 ${s.done ? "bg-emerald-500" : "bg-stone-300"}`} />
          <div className={s.done ? "text-stone-900" : "text-stone-400"}>
            <p className="font-medium">{s.label}</p>
            {s.time && <p className="text-xs text-stone-500">{fmtIST(s.time)}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// The "Record balance received" form. `onSubmit` returns the RPC result.
export function RecordBalanceForm({ expected, onSubmit }) {
  const [mode, setMode] = useState("cash");
  const [amount, setAmount] = useState(String(expected));
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const amt = Number(amount);
  const cashWarn = mode === "cash" && Number.isFinite(amt) && amt >= CASH_WARNING_LIMIT;
  const inputCls = "border border-stone-300 rounded px-3 py-2 text-sm w-full bg-white";

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!Number.isFinite(amt) || amt <= 0) return setError("Enter the amount received.");
    if (!/^[0-9]{6}$/.test(code.trim())) return setError("Enter the customer's 6-digit code.");
    setBusy(true);
    try {
      const res = await onSubmit({ mode, amount: round2(amt), code: code.trim(), note: note.trim() });
      if (!res?.ok) {
        setError(balanceErrorText(res));
        if (res?.reason !== "wrong_code") setCode("");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border border-stone-200 rounded-lg p-3 bg-stone-50 flex flex-col gap-3" data-testid="record-balance">
      <p className="text-sm font-medium">Record balance received</p>
      <div className="flex gap-2">
        {[["cash", "Cash"], ["online", "Online"]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`text-sm px-3 py-1.5 rounded border ${mode === k ? "bg-slate-900 text-white border-slate-900" : "border-stone-300 text-stone-600 bg-white"}`}>{label}</button>
        ))}
      </div>
      <div>
        <label className="text-xs text-stone-500 block mb-1">Amount received (expected {formatRupees(expected)})</label>
        <input type="number" min="0" step="0.01" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-stone-500 block mb-1">Customer's 6-digit code</label>
        <input inputMode="numeric" maxLength={6} placeholder="6-digit code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <p className="text-xs text-stone-500 mt-1">The customer gets this code in their app under “Pay at the venue”. It works for about 10 minutes.</p>
      </div>
      <div>
        <label className="text-xs text-stone-500 block mb-1">Note (optional)</label>
        <input className={inputCls} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {cashWarn && (
        <p className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-3 py-2" data-testid="cash-warning">
          Cash payments of Rs 2,00,000 or more may not be allowed under income tax rules. Please ask the customer to pay online.
        </p>
      )}
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <button type="submit" disabled={busy} className="bg-accent text-slate-900 text-sm font-semibold rounded-lg px-4 py-2 disabled:opacity-60 self-start">
        {busy ? "Recording…" : "Received"}
      </button>
    </form>
  );
}

// Pure view of a booking page: everything comes in as props so it can be rendered
// and tested without a login.
export function BookingPageView({ b, menuNode, checkin, onRecord, onClose, onGoToFees, categoriesLabel }) {
  const pays = b.payments || [];
  const balance = balanceOf(b);
  const paid = hasPaidDeposit(b);
  const paidOnline = paidOnlineAmount(b);
  const expected = Math.max(0, round2(Number(b.total_amount || 0) - paidOnline));
  const depPay = pays.filter((p) => p.status === "paid" && (p.payment_type === "deposit" || p.payment_type === "full"))
    .sort((a, c) => new Date(a.paid_at) - new Date(c.paid_at))[0];
  const detailed = paid && b.package_value != null;
  const fee = commissionOf(b);
  const feeStatus = fee ? feeState({ id: fee.id, status: fee.status }, b.platform_fee_payments || []) : null;
  const eventDayCame = String(b.event_date).slice(0, 10) <= todayIST();
  const canRecord = b.status === "confirmed" && paid && eventDayCame && !balance && expected > 0;
  const refundPay = pays.find((p) => p.refund_status && p.refund_status !== "none");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Booking" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-xl w-full p-5 shadow-xl my-2" onClick={(e) => e.stopPropagation()} data-testid="booking-page">
        {/* 1. header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-stone-400 font-mono">{b.booking_ref || b.id.slice(0, 8).toUpperCase()}</p>
            <h2 className="font-serif text-xl">{b.venue_packages?.name || "Booking"}</h2>
            <p className="text-sm text-stone-600">
              {fmtDay(b.event_date)}, {String(b.event_time).slice(0, 5)} · {b.headcount} {Number(b.headcount) === 1 ? "guest" : "guests"}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <span className="text-xs font-medium px-2 py-1 rounded bg-stone-100 text-stone-700 capitalize">{String(b.status).replace("_", " ")}</span>
            <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600 text-sm">Close</button>
          </div>
        </div>
        <p className="text-sm text-stone-500 mt-1">{b.contact_name}</p>

        {/* 2. timeline */}
        <Section title="Timeline" testid="sec-timeline">
          <Timeline steps={buildTimeline(b, pays, balance)} />
        </Section>

        {/* 3. money */}
        <Section title="Money" testid="sec-money">
          <div>
            {detailed && <Row k="Package value" v={formatRupees(b.package_value)} />}
            {detailed && Number(b.tax_amount) > 0 && <Row k="Taxes (the venue bills these)" v={formatRupees(b.tax_amount)} />}
            <Row k="Booking total" v={formatRupees(b.total_amount)} strong />
            {paid && (
              <Row k="Paid online (deposit)" v={`${formatRupees(paidOnline)}${depPay?.paid_at ? ` · ${fmtIST(depPay.paid_at)}` : ""}`} />
            )}
            {paid && <Row k={balance ? "Expected at the venue" : "To collect at the venue"} v={formatRupees(balance ? balance.expected_balance : expected)} />}
            {balance && <Row k={`Balance received (${balance.mode === "cash" ? "cash" : "online"})`} v={`${formatRupees(balance.amount_received)} · ${fmtIST(balance.received_at)}`} strong />}
            {balance && Number(balance.difference) !== 0 && (
              <Row k="Difference" v={`${Number(balance.difference) > 0 ? "+" : "−"}${formatRupees(Math.abs(Number(balance.difference)))}`} />
            )}
            {balance?.note && <Row k="Note" v={balance.note} />}
          </div>
          {refundPay && (
            <div className="mt-3 border border-stone-200 rounded-lg p-3 text-sm">
              <p className="text-xs font-semibold text-stone-500 mb-1">Refund</p>
              <p>{formatRupees(refundPay.refund_amount)}{refundPay.refund_percent != null ? ` (${refundPay.refund_percent}%)` : ""} · {refundPay.refund_status}</p>
            </div>
          )}
        </Section>

        {/* 4. check-in and balance */}
        <Section title="Check-in and balance" testid="sec-checkin">
          {b.event_started_at ? (
            <p className="text-sm font-medium text-emerald-700 mb-3">✓ Checked in at {fmtIST(b.event_started_at)}</p>
          ) : b.status === "confirmed" ? (
            String(b.event_date).slice(0, 10) > todayIST() ? (
              <p className="text-xs text-stone-500 mb-3">Check-in opens on the day of the event.</p>
            ) : (
              <div className="mb-3">
                <p className="text-sm font-medium mb-1">Confirm event started</p>
                <p className="text-xs text-stone-500 mb-2">Enter the 6-digit code the customer shows you on arrival. They get it in their app under “Generate check-in code”.</p>
                <div className="flex flex-wrap gap-2">
                  <input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={checkin?.value || ""} onChange={(e) => checkin?.onChange(e.target.value)} className="border border-stone-300 rounded px-3 py-2 text-sm w-40" />
                  <button type="button" disabled={checkin?.busy} onClick={checkin?.onConfirm} className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-60">{checkin?.busy ? "Checking…" : "Confirm"}</button>
                </div>
                {checkin?.error && <p className="text-xs text-rose-600 mt-1">{checkin.error}</p>}
              </div>
            )
          ) : (
            <p className="text-xs text-stone-500 mb-3">No check-in for this booking.</p>
          )}
          {balance ? (
            <p className="text-sm text-emerald-700 font-medium">✓ Balance recorded — {formatRupees(balance.amount_received)}, {balance.mode === "cash" ? "cash" : "online"}.</p>
          ) : canRecord ? (
            <RecordBalanceForm expected={expected} onSubmit={onRecord} />
          ) : b.status === "confirmed" && paid ? (
            <p className="text-xs text-stone-500">You can record the balance received from the day of the event.</p>
          ) : null}
        </Section>

        {/* 5. PAXO platform fee */}
        {fee && (
          <Section title="PAXO platform fee" testid="sec-fee">
            <Row k="Platform fee" v={formatRupees(fee.amount)} strong />
            <Row k="Fee rate" v={`${Number(fee.percent)}% of booking value ${formatRupees(fee.base_amount)}`} />
            <div className="flex items-center justify-between gap-3 pt-2">
              <StateChip state={feeStatus} />
              <button type="button" onClick={onGoToFees} className="text-sm text-accent-ink underline underline-offset-2">Go to PAXO fees</button>
            </div>
          </Section>
        )}

        {/* 6. guests, menu, requests */}
        <Section title="Guests, menu and requests" testid="sec-guests">
          <Row k="Guests" v={`${b.headcount} (${b.male_count || 0} male, ${b.female_count || 0} female)`} />
          {b.special_request && <Row k="Special request" v={b.special_request} />}
          {Array.isArray(b.booking_addon_requests) && b.booking_addon_requests.length > 0 && (
            <div className="py-1.5 border-b border-stone-100 text-sm">
              <p className="text-stone-500 mb-1">Add-ons requested</p>
              {b.booking_addon_requests.map((a) => (
                <p key={a.id} className="text-stone-800">{a.addon_name} <span className="text-xs text-stone-400">· {a.status}{a.price != null ? ` · ${formatRupees(a.price)}` : ""}</span></p>
              ))}
            </div>
          )}
          <div className="pt-2">
            <p className="text-sm text-stone-500 mb-1">Finalized menu</p>
            {b.menu_finalized_at ? menuNode : <p className="text-xs text-stone-500">Menu not yet finalized.</p>}
          </div>
        </Section>
      </div>
    </div>
  );
}

// Container: wires the page to the database.
export default function BookingPage({ b, token, menuNode, checkin, onClose, onChanged, onGoToFees }) {
  async function record({ mode, amount, code, note }) {
    const res = await rpc(token, "record_balance_payment", {
      p_booking_id: b.id,
      p_mode: mode,
      p_amount: amount,
      p_code: code,
      p_note: note || null,
    });
    if (res?.ok) await onChanged();
    return res;
  }
  return <BookingPageView b={b} menuNode={menuNode} checkin={checkin} onRecord={record} onClose={onClose} onGoToFees={onGoToFees} />;
}

// ---- Completed list: newest first, with total received and fee status ----

export function CompletedList({ bookings, onOpen }) {
  const when = (b) => new Date(b.completed_at || balanceOf(b)?.received_at || `${b.event_date}T${b.event_time}`).getTime();
  const rows = bookings.filter((b) => b.status === "completed").sort((a, c) => when(c) - when(a));
  if (rows.length === 0) return <p className="text-stone-400 text-sm">No completed bookings yet.</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="completed-list">
      {rows.map((b) => {
        const balance = balanceOf(b);
        const fee = commissionOf(b);
        const received = round2(paidOnlineAmount(b) + Number(balance?.amount_received || 0));
        const state = fee ? feeState({ id: fee.id, status: fee.status }, b.platform_fee_payments || []) : null;
        return (
          <button type="button" key={b.id} onClick={() => onOpen(b.id)} className="text-left border border-stone-200 rounded-xl p-4 bg-white hover:border-stone-300 hover:shadow-sm transition-shadow w-full flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs text-stone-400 font-mono">{b.booking_ref || b.id.slice(0, 8).toUpperCase()}</p>
              <p className="font-medium text-stone-900">{b.contact_name}</p>
              <p className="text-sm text-stone-500">{b.venue_packages?.name} · {fmtDay(b.event_date)}</p>
              {b.completed_at || balance ? <p className="text-xs text-stone-400">Completed {fmtIST(b.completed_at || balance.received_at)}</p> : null}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-stone-400">Total received</p>
              <p className="text-lg font-medium">{formatRupees(received)}</p>
              {state && <div className="mt-1"><StateChip state={state} /></div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

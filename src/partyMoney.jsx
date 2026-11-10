import { useState, useEffect, useCallback } from "react";
import { rpc } from "./supabase";

// Admin "Party Pool" money panel (Phase 2): paid seats, deposits, balances, forfeits, refunds due, settlement.
// Everything comes from admin-only database functions (they check admin_users themselves), so nothing here is visible
// to customers or partners. "Mark refunded" and "Mark settled" only record what the admin did by hand.

const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const REASON = { party_cancelled: "Party cancelled", minimum_not_reached: "Minimum not reached", late_payment: "Paid too late" };
const inputCls = "w-full border border-slate-300 rounded px-3 py-2 text-sm";

function Stat({ label, value, tone, testid }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone || "bg-white border-slate-200"}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-semibold text-slate-900" data-testid={testid}>{value}</p>
    </div>
  );
}

function GatewayTag({ r }) {
  return (
    <p className="text-xs mt-1" data-testid="refund-gateway">
      <span className={`font-semibold ${r.provider === "cashfree" ? "text-violet-700" : "text-sky-700"}`}>{r.provider === "cashfree" ? "Cashfree" : "Razorpay"}</span>
      {r.gateway_mode === "test" && <span className="ml-1 rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 font-semibold" data-testid="refund-test-badge">TEST</span>}
      {r.gateway_payment_id ? <span className="text-slate-500 font-mono"> · {r.gateway_payment_id}</span> : null}
    </p>
  );
}

function RefundRow({ r, session, onDone }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayIst());
  const [note, setNote] = useState("");
  const [cfRefundId, setCfRefundId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function mark() {
    setBusy(true);
    setError("");
    try {
      await rpc(session.token, "party_mark_refunded", { p_payment_id: r.payment_id, p_date: date, p_note: note.trim() || null, p_cashfree_refund_id: r.provider === "cashfree" ? cfRefundId.trim() || null : null });
      setOpen(false);
      await onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const due = r.refund_status === "due";
  return (
    <tr className="border-t border-slate-200 align-top" data-testid={`refund-row-${r.payment_id}`}>
      <td className="py-2 pr-3">
        <p className="font-medium text-slate-900">{r.customer_name || "Customer"}</p>
        <p className="text-xs text-slate-500">{r.phone || ""} {r.email || ""}</p>
        <GatewayTag r={r} />
      </td>
      <td className="py-2 pr-3 text-sm"><span className="font-semibold" data-testid="refund-exact">{inr(r.refund_amount)}</span><p className="text-xs text-slate-500">of {inr(r.paid_amount)} paid ({r.kind})</p>{due && r.provider === "cashfree" && <p className="text-xs text-violet-700">Refund exactly this amount in the Cashfree dashboard.</p>}</td>
      <td className="py-2 pr-3 text-sm">{REASON[r.reason] || r.reason}<p className="text-xs text-slate-500">queued {fmtAt(r.queued_at)}</p></td>
      <td className="py-2 text-sm">
        {due ? (
          open ? (
            <div className="flex flex-col gap-2 min-w-[200px]">
              <input type="date" className={inputCls} value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} data-testid="refund-date" />
              {r.provider === "cashfree" && <input className={inputCls} placeholder="Cashfree refund id (optional)" value={cfRefundId} onChange={(e) => setCfRefundId(e.target.value)} maxLength={100} data-testid="refund-cf-id" />}
              <input className={inputCls} placeholder="Note (bank reference…)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-testid="refund-note" />
              <div className="flex gap-3 items-center">
                <button onClick={mark} disabled={busy} className="bg-emerald-600 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50" data-testid="refund-confirm">{busy ? "Saving…" : "Save"}</button>
                <button onClick={() => setOpen(false)} className="text-slate-500 underline text-sm">Close</button>
              </div>
              {error && <p className="text-rose-700 text-xs">{error}</p>}
            </div>
          ) : (
            <button onClick={() => setOpen(true)} className="bg-slate-900 text-white rounded px-3 py-1.5 text-sm" data-testid="refund-mark">Mark refunded</button>
          )
        ) : (
          <span className="text-emerald-700">Refunded {fmtDay(r.refunded_on)}{r.cashfree_refund_id ? <span className="text-slate-500 font-mono"> · {r.cashfree_refund_id}</span> : null}{r.note ? <span className="text-slate-500"> · {r.note}</span> : null}</span>
        )}
      </td>
    </tr>
  );
}

export default function PartyMoney({ session, party }) {
  const [sum, setSum] = useState(null);
  const [guests, setGuests] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [error, setError] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [sDate, setSDate] = useState(todayIst());
  const [sNote, setSNote] = useState("");
  const [sBusy, setSBusy] = useState(false);
  const [sMsg, setSMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, g, r] = await Promise.all([
        rpc(session.token, "party_admin_summary", { p_party_id: party.id, p_include_test: showTest }),
        rpc(session.token, "party_admin_bookings", { p_party_id: party.id }),
        rpc(session.token, "party_admin_refunds", { p_party_id: party.id }),
      ]);
      setSum(s);
      setGuests(g || []);
      setRefunds(r || []);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [session.token, party.id, showTest]);
  useEffect(() => {
    load();
  }, [load, party.status]);

  async function settle() {
    setSBusy(true);
    setSMsg("");
    try {
      await rpc(session.token, "party_mark_settled", { p_party_id: party.id, p_date: sDate, p_note: sNote.trim() || null });
      setSMsg("Marked as settled.");
      await load();
    } catch (e) {
      setSMsg(e.message);
    } finally {
      setSBusy(false);
    }
  }

  if (error) return <p className="text-sm text-rose-700 mb-4" data-testid="money-error">{error}</p>;
  if (!sum) return <p className="text-sm text-slate-500 mb-4">Loading money…</p>;
  const canSettle = party.status === "confirmed" || party.status === "completed";
  const dueRefunds = refunds.filter((r) => r.refund_status === "due");

  return (
    <div className="mb-6" data-testid="party-money">
      <h3 className="text-lg font-semibold mb-2">Seats and money</h3>
      <label className="flex items-center gap-2 text-sm text-slate-600 mb-2">
        <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} data-testid="money-show-test" />
        Include test payments in these totals{Number(sum.test_payments_count) > 0 ? ` (${sum.test_payments_count} test payment${Number(sum.test_payments_count) === 1 ? "" : "s"}, ${inr(sum.test_total_collected)})` : ""}
      </label>
      <p className="text-xs text-slate-500 mb-2" data-testid="money-mode-note">{sum.includes_test ? "Money totals include test payments." : "Money totals count live payments only. Seat counts include every paid seat."}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Stat label="Paid seats" value={sum.paid_seats} testid="sum-paid" />
        <Stat label="Male / Female paid" value={`${sum.paid_male} / ${sum.paid_female}`} testid="sum-split" />
        <Stat label="Seats on hold now" value={sum.held_seats} />
        <Stat label="Forfeited seats" value={sum.forfeited_seats} testid="sum-forfeited" />
        <Stat label="Deposits collected (30%)" value={inr(sum.deposits_collected)} testid="sum-deposits" />
        <Stat label="Paid in full (after confirmation)" value={inr(sum.full_collected)} />
        <Stat label="Balances collected" value={inr(sum.balances_collected)} />
        <Stat label="Balances still due" value={inr(sum.balances_due)} testid="sum-balances-due" />
        <Stat label="Forfeited deposits kept" value={inr(sum.forfeited_amount)} />
        <Stat label="Total collected" value={inr(sum.total_collected)} tone="bg-emerald-50 border-emerald-200" testid="sum-total" />
        <Stat label="Refunds due" value={`${inr(sum.refunds_due)} (${sum.refunds_due_count})`} tone={Number(sum.refunds_due) > 0 ? "bg-rose-50 border-rose-200" : undefined} testid="sum-refunds-due" />
        <Stat label="Refunded so far" value={inr(sum.refunded)} />
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <p className="text-sm font-medium mb-2">Refunds due ({dueRefunds.length})</p>
        <p className="text-xs text-slate-500 mb-2">Send each refund by hand (full amount, PAXO bears the gateway fee), then mark it here. The guest sees "Refund in 7 to 10 working days" until you do.</p>
        {refunds.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="refunds-empty">No refunds for this party.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500"><tr><th className="pr-3">Guest</th><th className="pr-3">Refund</th><th className="pr-3">Reason</th><th>Status</th></tr></thead>
              <tbody>{refunds.map((r) => <RefundRow key={r.payment_id} r={r} session={session} onDone={load} />)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <p className="text-sm font-medium mb-2">Guests ({guests.length})</p>
        {guests.length === 0 ? (
          <p className="text-sm text-slate-500">Nobody has paid yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="guests-table">
              <thead className="text-xs text-slate-500"><tr><th className="pr-3">Guest</th><th className="pr-3">M / F</th><th className="pr-3">Paid</th><th className="pr-3">Balance due</th><th>Status</th></tr></thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.booking_id} className="border-t border-slate-200">
                    <td className="py-2 pr-3">{g.customer_name || "Customer"}<p className="text-xs text-slate-500">{g.phone || ""}</p></td>
                    <td className="py-2 pr-3">{g.male} / {g.female}</td>
                    <td className="py-2 pr-3">{inr(g.paid_amount)}</td>
                    <td className="py-2 pr-3">{Number(g.balance_due) > 0 ? <>{inr(g.balance_due)}<p className="text-xs text-slate-500">by {fmtAt(g.balance_due_by)}</p></> : "—"}</td>
                    <td className="py-2 capitalize">{g.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4" data-testid="settle-box">
        <p className="text-sm font-medium text-amber-900">Venue settlement — admin only</p>
        {sum.settled_on ? (
          <p className="text-sm text-emerald-800 mt-1" data-testid="settled-line">Settled on {fmtDay(sum.settled_on)}{sum.settled_note ? ` · ${sum.settled_note}` : ""}</p>
        ) : canSettle ? (
          <>
            <p className="text-xs text-amber-800 mb-2">After you pay the venue, record the date and a note here.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input type="date" className={inputCls} value={sDate} max={todayIst()} onChange={(e) => setSDate(e.target.value)} data-testid="settle-date" />
              <input className={inputCls} placeholder="Note (bank reference…)" value={sNote} onChange={(e) => setSNote(e.target.value)} maxLength={2000} data-testid="settle-note-input" />
              <button onClick={settle} disabled={sBusy} className="bg-slate-900 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50" data-testid="settle-save">{sBusy ? "Saving…" : "Mark settled"}</button>
            </div>
          </>
        ) : (
          <p className="text-xs text-amber-800 mt-1">Available once the party is confirmed.</p>
        )}
        {sMsg && <p className="text-sm mt-2" data-testid="settle-msg">{sMsg}</p>}
      </div>
    </div>
  );
}

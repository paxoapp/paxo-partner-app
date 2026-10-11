import { useState } from "react";
import { formatRupees, round2 } from "./tax";
import { fmtIST } from "./platformFees";

// The venue's own record of how the remaining balance was collected. It is optional, PAXO does not
// verify it, and the customer never sees it. The database keeps it in booking_balance_notes.

export const BALANCE_METHODS = [
  ["upi", "UPI"],
  ["cash", "Cash"],
  ["card", "Card"],
  ["bank_transfer", "Bank transfer"],
  ["multiple", "More than one way"],
  ["not_collected", "Not collected / handled outside PAXO"],
];
export const methodLabel = (m) => (BALANCE_METHODS.find(([k]) => k === m) || [, m])[1];

export const BALANCE_NOTE_DISCLAIMER =
  "This is your own record. PAXO does not verify it and is not responsible for how the balance is collected.";
export const CHECKIN_NEEDED_TEXT = "Check-in is needed before you can mark this completed";

const oneRow = (v) => (Array.isArray(v) ? v[0] || null : v || null);
export const noteOf = (b) => oneRow(b?.booking_balance_notes);

// What is left to collect at the venue: booking total minus what was paid online.
export function remainingBalance(totalAmount, paidOnline) {
  return Math.max(0, round2(Number(totalAmount || 0) - Number(paidOnline || 0)));
}

// "₹4,000 by UPI · recorded 12 Oct, 9:41 pm"  (or "Not collected / handled outside PAXO · recorded …")
export function noteLine(n) {
  if (!n) return null;
  const what = n.method === "not_collected" ? methodLabel(n.method) : `${formatRupees(n.amount)} by ${methodLabel(n.method)}`;
  return `${what} · recorded ${fmtIST(n.updated_at)}`;
}

const inputCls = "border border-stone-300 rounded px-3 py-2 text-sm w-full bg-white";

// Method + amount. `children` are the buttons; `onSubmit({method, amount})` gets the values.
export function BalanceFields({ method, setMethod, amount, setAmount, expected }) {
  return (
    <>
      <div>
        <label className="text-xs text-stone-500 block mb-1">How was the remaining balance collected?</label>
        <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)} data-testid="balance-method">
          <option value="">Choose…</option>
          {BALANCE_METHODS.map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
      </div>
      {method && method !== "not_collected" && (
        <div>
          <label className="text-xs text-stone-500 block mb-1">Amount collected (₹)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="balance-amount"
          />
          <p className="text-xs text-stone-400 mt-1">Remaining balance on this booking: {formatRupees(expected)}</p>
        </div>
      )}
      <p className="text-xs text-stone-500">{BALANCE_NOTE_DISCLAIMER}</p>
    </>
  );
}

function useBalanceFields(expected, initial) {
  const [method, setMethod] = useState(initial?.method || "");
  const [amount, setAmount] = useState(String(initial ? Number(initial.amount) : expected));
  const [error, setError] = useState("");
  function values() {
    if (!method) {
      setError("Choose how the balance was collected, or skip.");
      return null;
    }
    const amt = method === "not_collected" ? 0 : Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      setError("Enter the amount collected.");
      return null;
    }
    setError("");
    return { method, amount: round2(amt) };
  }
  return { method, setMethod, amount, setAmount, error, setError, values };
}

// The dialog behind "Mark as Completed". The balance record is optional; the venue can skip it.
// onComplete(null) = skip, onComplete({method, amount}) = save the record and complete.
export function CompleteDialog({ b, expected, checkedIn, busy, error, onComplete, onClose }) {
  const f = useBalanceFields(expected, null);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Mark as completed" onClick={busy ? undefined : onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="complete-dialog">
        <p className="text-xs text-stone-400 font-mono">{b.booking_ref || b.id.slice(0, 8).toUpperCase()}</p>
        <h3 className="font-serif text-lg mb-3">Mark as Completed</h3>
        {!checkedIn ? (
          <>
            <p className="text-sm text-stone-700" data-testid="checkin-needed">{CHECKIN_NEEDED_TEXT}</p>
            <button type="button" onClick={onClose} className="mt-4 text-sm border border-stone-300 rounded-lg px-4 py-2">Close</button>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            <BalanceFields {...f} expected={expected} />
            {(f.error || error) && <p className="text-sm text-rose-600" role="alert">{f.error || error}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const v = f.values();
                  if (v) onComplete(v);
                }}
                className="bg-accent text-[#170D0B] text-sm font-semibold rounded-lg px-4 py-2 disabled:opacity-60"
              >
                {busy ? "Working…" : "Save record and complete"}
              </button>
              <button type="button" disabled={busy} onClick={() => onComplete(null)} className="text-sm border border-stone-300 rounded-lg px-4 py-2 disabled:opacity-60">
                Skip, just complete
              </button>
              <button type="button" disabled={busy} onClick={onClose} className="text-sm text-stone-500 px-2 py-2">Back</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The optional "Balance collected" note on a booking page (checked in, before or after completion).
// Shows the saved record; "Add"/"Change" opens the same fields. `onSave({method, amount})` returns after saving.
export function BalanceNoteSection({ note, expected, onSave }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const f = useBalanceFields(expected, note);
  async function save() {
    const v = f.values();
    if (!v) return;
    setBusy(true);
    setErr("");
    try {
      await onSave(v);
      setOpen(false);
    } catch (e) {
      setErr(e.message || "Couldn't save. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 border border-stone-200 rounded-lg p-3 bg-stone-50" data-testid="balance-note">
      <p className="text-sm font-medium mb-1">Balance collected <span className="text-xs text-stone-400 font-normal">(optional)</span></p>
      {note && !open && (
        <p className="text-sm text-stone-800" data-testid="balance-note-line">{noteLine(note)}</p>
      )}
      {!open ? (
        <>
          {!note && <p className="text-xs text-stone-500 mb-2">{BALANCE_NOTE_DISCLAIMER}</p>}
          <button type="button" onClick={() => setOpen(true)} className="text-sm text-accent-ink underline underline-offset-2">
            {note ? "Change" : "Add a note"}
          </button>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <BalanceFields {...f} expected={expected} />
          {(f.error || err) && <p className="text-sm text-rose-600" role="alert">{f.error || err}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={save} className="bg-accent text-[#170D0B] text-sm font-semibold rounded-lg px-4 py-2 disabled:opacity-60">
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="text-sm text-stone-500 px-2 py-2">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { sb } from "./supabase";

// "Open to negotiation": venues.open_to_negotiation is the single switch. When on, the customer app shows a
// "Negotiate price" button that opens PAXO's WhatsApp. Admin-only for now (the database refuses a partner's change).

export function NegotiableTag() {
  return (
    <span className="ml-2 align-middle text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-800" data-testid="negotiable-tag">
      Negotiable
    </span>
  );
}

export function NegotiationToggle({ session, venue, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = !!venue.open_to_negotiation;

  async function flip() {
    setBusy(true);
    setError("");
    try {
      const [row] = await sb(`/rest/v1/venues?id=eq.${venue.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: { open_to_negotiation: !on },
      });
      if (!row) throw new Error("Could not save. Please try again.");
      onUpdated(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4" data-testid="negotiation-toggle">
      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" checked={on} disabled={busy} onChange={flip} className="mt-1 w-4 h-4" data-testid="negotiation-checkbox" />
        <span>
          <span className="block text-sm font-medium">Open to negotiation</span>
          <span className="block text-xs text-slate-500">Customers will see a Negotiate price button that opens PAXO WhatsApp.</span>
        </span>
      </label>
      {error && <p className="text-rose-600 text-xs mt-2">{error}</p>}
    </div>
  );
}

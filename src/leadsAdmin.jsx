import { useState, useEffect, useCallback } from "react";
import { sb } from "./supabase";

// Admin "Leads" tab: the "Find my venue" enquiries from the customer app. The team calls the customer back, then marks
// the lead Contacted / Booked / Closed and keeps notes. Admins can change only the status and the notes (database rule).

const STATUSES = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["booked", "Booked"],
  ["closed", "Closed"],
];
const TONE = {
  new: "bg-amber-100 text-amber-800",
  contacted: "bg-sky-100 text-sky-800",
  booked: "bg-emerald-100 text-emerald-800",
  closed: "bg-stone-200 text-stone-600",
};
const fmtWhen = (d) =>
  d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
const fmtDay = (d) => (d ? new Date(d + "T00:00:00+05:30").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");

function LeadCard({ lead, token, onChanged }) {
  const [notes, setNotes] = useState(lead.admin_notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function patch(body) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const [row] = await sb(`/rest/v1/venue_leads?id=eq.${lead.id}`, { method: "PATCH", token, prefer: "return=representation", body });
      onChanged(row);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4" data-testid={`lead-${lead.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">
            {lead.name} <span className={`ml-2 text-xs px-2 py-0.5 rounded-full font-medium ${TONE[lead.status]}`}>{lead.status}</span>
            {lead.customer_id && <span className="ml-2 text-xs text-slate-400">signed-in customer</span>}
          </p>
          <p className="text-sm mt-1">
            <a href={`tel:+91${lead.phone}`} className="text-slate-900 underline">
              +91 {lead.phone}
            </a>
            <a href={`https://wa.me/91${lead.phone}`} target="_blank" rel="noopener noreferrer" className="ml-3 text-emerald-700 underline text-xs">
              WhatsApp
            </a>
          </p>
          <p className="text-sm text-slate-600 mt-1">
            {lead.location} · {fmtDay(lead.party_date)} · {lead.guests} guests (MG)
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Received {fmtWhen(lead.created_at)}
            {lead.contacted_at ? ` · first contacted ${fmtWhen(lead.contacted_at)}` : ""}
          </p>
        </div>
        <label className="text-xs text-slate-500">
          Status
          <select
            value={lead.status}
            disabled={busy}
            onChange={(e) => patch({ status: e.target.value })}
            className="block mt-1 border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900"
            data-testid="lead-status"
          >
            {STATUSES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3">
        <textarea
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
          placeholder="Notes (what they want, budget, call outcome…)"
          className="w-full border border-slate-300 rounded px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-3 mt-1">
          <button
            disabled={busy || notes === (lead.admin_notes || "")}
            onClick={() => patch({ admin_notes: notes.trim() || null })}
            className="text-xs bg-slate-900 text-white rounded px-3 py-1.5 disabled:opacity-40"
          >
            Save notes
          </button>
          {saved && <span className="text-xs text-emerald-700">Saved</span>}
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      </div>
    </div>
  );
}

export default function LeadsAdmin({ session }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("new");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await sb("/rest/v1/venue_leads?select=*&order=created_at.desc&limit=1000", { token: session.token });
      setLeads(rows || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = leads.reduce((a, l) => ({ ...a, [l.status]: (a[l.status] || 0) + 1 }), {});
  const q = search.trim().toLowerCase();
  const shown = leads
    .filter((l) => filter === "all" || l.status === filter)
    .filter((l) => !q || [l.name, l.phone, l.location].some((x) => String(x || "").toLowerCase().includes(q)));

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <button onClick={load} className="text-sm border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50">
          Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        People who used “Find my venue” in the customer app. Call them back, then update the status. {leads.length} in total.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {[["new", "New"], ["contacted", "Contacted"], ["booked", "Booked"], ["closed", "Closed"], ["all", "All"]].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`text-sm px-3 py-1.5 rounded-full border ${filter === k ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
          >
            {l} ({k === "all" ? leads.length : counts[k] || 0})
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone, location"
          className="ml-auto border border-slate-300 rounded px-3 py-1.5 text-sm w-full sm:w-64"
        />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-slate-400 text-sm">{leads.length === 0 ? "No enquiries yet." : "Nothing matches this filter."}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((l) => (
            <LeadCard key={l.id} lead={l} token={session.token} onChanged={(row) => setLeads((ls) => ls.map((x) => (x.id === row.id ? { ...x, ...row } : x)))} />
          ))}
        </div>
      )}
    </div>
  );
}

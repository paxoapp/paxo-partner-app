import { useState, useEffect, useCallback } from "react";
import { sb, uploadPartyCover } from "./supabase";
import PartyMoney from "./partyMoney";
import PartyMenu from "./partyMenu";
import PartyGuests from "./partyGuests";

// Admin "Party Pool" (Phase 1): create, edit, publish and cancel themed group parties that PAXO sells seats for.
// The database enforces the rules (status path, locks once seats exist, "confirmed" only by the system), this screen
// just shows its messages. The venue settlement is admin-only and lives in its own table, never shown to customers.

const STATUS_TONE = {
  draft: "bg-slate-200 text-slate-700",
  published: "bg-sky-100 text-sky-800",
  confirmed: "bg-emerald-100 text-emerald-800",
  closed: "bg-amber-100 text-amber-800",
  completed: "bg-stone-200 text-stone-600",
  cancelled: "bg-rose-100 text-rose-700",
};
const FILTERS = [["all", "All"], ["draft", "Draft"], ["published", "Published"], ["confirmed", "Confirmed"], ["closed", "Closed"], ["completed", "Completed"], ["cancelled", "Cancelled"]];
// Suggestions only: the admin can type anything. Customers filter the Parties list by these two values and the venue's city.
const PACKAGE_OPTIONS = ["Standard", "Premium", "Unlimited food + drinks", "Unlimited drinks only", "Veg", "Non-veg"];
const LIQUOR_OPTIONS = ["IMFL", "Premium liquor", "Beer & wine", "Cocktails", "No alcohol"];
const IDEAS = ["Halloween Night", "New Year Eve", "Christmas", "Get Together", "Let's Fun", "Kitty Party", "Weekend"];

const hhmm = (t) => (t || "").slice(0, 5);
// closing time is typed and shown in India time
const toIstLocal = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16) : "");
const fromIstLocal = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");
const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

function StatusPill({ status }) {
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_TONE[status] || STATUS_TONE.draft}`}>{status}</span>;
}

function Field({ label, hint, children }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-600 text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400 mt-0.5">{hint}</span>}
    </label>
  );
}
const inputCls = "mt-1 w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white disabled:bg-slate-100 disabled:text-slate-500";

const emptyForm = {
  title: "", description: "", venue_id: "", party_date: "", start_time: "20:00", end_time: "01:00", package_type: "", liquor_type: "",
  price_per_person: "", male_seats: "", female_seats: "", min_paid_seats: "30", closes_local: "", max_seats_per_booking: "10",
  cover_photo_url: "", terms_text: "", settlement_type: "", settlement_value: "", settlement_note: "",
  inclusions: "", dress_code: "", min_age: "21", highlights: "",
};

function PartyEditor({ session, party, venues, seatCounts, onBack, onSaved }) {
  const [f, setF] = useState(() =>
    party
      ? {
          title: party.title, description: party.description || "", venue_id: party.venue_id, party_date: party.party_date,
          start_time: hhmm(party.start_time), end_time: hhmm(party.end_time), package_type: party.package_type || "",
          liquor_type: party.liquor_type || "", price_per_person: String(party.price_per_person), male_seats: String(party.male_seats),
          female_seats: String(party.female_seats), min_paid_seats: String(party.min_paid_seats), closes_local: toIstLocal(party.closes_at),
          max_seats_per_booking: String(party.max_seats_per_booking), cover_photo_url: party.cover_photo_url || "", terms_text: party.terms_text || "",
          settlement_type: "", settlement_value: "", settlement_note: "",
          inclusions: party.inclusions || "", dress_code: party.dress_code || "", min_age: String(party.min_age ?? 21), highlights: party.highlights || "",
        }
      : emptyForm
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [current, setCurrent] = useState(party);
  const editing = !!current; // true once a new party has been saved, so Save then updates it instead of creating another

  const status = current?.status || "draft";
  const final = status === "cancelled" || status === "completed";
  const seats = (current && seatCounts[current.id]) || { paid_male: 0, paid_female: 0, held: 0 };
  const locked = editing && seats.paid_male + seats.paid_female + seats.held > 0;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  // the admin-only settlement is its own table; load it for this party
  useEffect(() => {
    if (!party) return;
    let cancelled = false;
    sb(`/rest/v1/party_venue_settlement?party_id=eq.${party.id}&select=*`, { token: session.token })
      .then((rows) => {
        const s = rows?.[0];
        if (!cancelled && s) setF((x) => ({ ...x, settlement_type: s.settlement_type || "", settlement_value: s.settlement_value ?? "", settlement_note: s.note || "" }));
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [party, session.token]);

  async function onCover(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const url = await uploadPartyCover(session.token, file);
      setF((x) => ({ ...x, cover_photo_url: url }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  function validate() {
    const price = Number(f.price_per_person);
    const m = Number(f.male_seats);
    const fe = Number(f.female_seats);
    const min = Number(f.min_paid_seats);
    const max = Number(f.max_seats_per_booking);
    if (f.title.trim().length < 2) return "Enter a title.";
    if (!f.venue_id) return "Choose the venue.";
    if (!f.party_date || !f.start_time || !f.end_time) return "Enter the party date, start time and end time.";
    if (!(price > 0)) return "Enter the price per person.";
    if (!Number.isInteger(m) || m < 0 || !Number.isInteger(fe) || fe < 0 || m + fe < 1) return "Enter the male and female seats (whole numbers).";
    if (!Number.isInteger(min) || min < 1 || min > m + fe) return `Minimum paid seats must be between 1 and ${m + fe} (the total seats).`;
    if (!Number.isInteger(max) || max < 1) return "Maximum seats per booking must be at least 1.";
    const age = Number(f.min_age);
    if (!Number.isInteger(age) || age < 18 || age > 25) return "Minimum age must be a whole number from 18 to 25.";
    if (f.settlement_type === "percentage" && Number(f.settlement_value) > 100) return "A settlement percentage cannot be above 100.";
    if (f.settlement_type && f.settlement_value === "") return "Enter the settlement amount or percentage.";
    return "";
  }

  async function save() {
    const bad = validate();
    if (bad) return setError(bad);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = {
        title: f.title.trim(), description: f.description.trim(), venue_id: f.venue_id, party_date: f.party_date,
        start_time: f.start_time, end_time: f.end_time, package_type: f.package_type.trim(), liquor_type: f.liquor_type.trim(),
        price_per_person: Number(f.price_per_person), male_seats: Number(f.male_seats), female_seats: Number(f.female_seats),
        min_paid_seats: Number(f.min_paid_seats), max_seats_per_booking: Number(f.max_seats_per_booking),
        cover_photo_url: f.cover_photo_url || null,
        inclusions: f.inclusions.trim(), dress_code: f.dress_code.trim(), min_age: Number(f.min_age), highlights: f.highlights.trim(),
      };
      if (f.closes_local) body.closes_at = fromIstLocal(f.closes_local);
      else if (!editing) body.closes_at = null; // the database sets it to 3 days before the start
      if (editing) body.terms_text = f.terms_text;
      else if (f.terms_text.trim()) body.terms_text = f.terms_text; // empty = the standard PAXO terms (database default)

      let row;
      if (editing) {
        [row] = await sb(`/rest/v1/parties?id=eq.${current.id}`, { method: "PATCH", token: session.token, prefer: "return=representation", body });
      } else {
        [row] = await sb("/rest/v1/parties", { method: "POST", token: session.token, prefer: "return=representation", body });
      }
      if (!row) throw new Error("Could not save. Please try again.");
      if (f.settlement_type || f.settlement_value !== "" || f.settlement_note.trim()) {
        await sb("/rest/v1/party_venue_settlement?on_conflict=party_id", {
          method: "POST",
          token: session.token,
          prefer: "resolution=merge-duplicates,return=representation",
          body: {
            party_id: row.id,
            settlement_type: f.settlement_type || null,
            settlement_value: f.settlement_value === "" ? null : Number(f.settlement_value),
            note: f.settlement_note.trim() || null,
          },
        });
      }
      setCurrent(row);
      setF((x) => ({ ...x, terms_text: row.terms_text, closes_local: toIstLocal(row.closes_at) }));
      setNotice(editing ? "Saved." : "Party created as a draft. Review it, then publish.");
      onSaved(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(next, extra = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const [row] = await sb(`/rest/v1/parties?id=eq.${current.id}`, { method: "PATCH", token: session.token, prefer: "return=representation", body: { status: next, ...extra } });
      if (!row) throw new Error("Could not update. Please try again.");
      setCurrent(row);
      setCancelling(false);
      setNotice(next === "published" ? "Published. Customers can now see this party." : "Party cancelled.");
      onSaved(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!window.confirm("Delete this draft permanently? This cannot be undone.")) return;
    setBusy(true);
    setError("");
    try {
      await sb(`/rest/v1/parties?id=eq.${current.id}&status=eq.draft`, { method: "DELETE", token: session.token });
      onSaved(null, current.id);
      onBack();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  const totalSeats = (Number(f.male_seats) || 0) + (Number(f.female_seats) || 0);

  return (
    <div data-testid="party-editor">
      <button onClick={onBack} className="text-sm text-slate-500 mb-4">← Back to parties</button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <h2 className="text-2xl font-semibold">{editing ? current.title : "New party"}</h2>
        {editing && <StatusPill status={status} />}
      </div>

      {error && <p className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2 mb-3" data-testid="party-error">{error}</p>}
      {notice && <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 mb-3" data-testid="party-notice">{notice}</p>}

      {editing && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-medium mb-1">Seats</p>
          <p className="text-slate-600">
            Paid: {seats.paid_male + seats.paid_female} of {current.min_paid_seats} needed ({seats.paid_male} male, {seats.paid_female} female) · {seats.held} on hold · {totalSeats} seats in total
          </p>
          {locked && <p className="text-xs text-amber-700 mt-1">Guests have joined, so the venue, date, times, price and seat numbers are locked. To change them, cancel the party.</p>}
        </div>
      )}

      <fieldset disabled={final || busy} className="bg-white border border-slate-200 rounded-lg p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <Field label="Title">
            <input className={inputCls} value={f.title} onChange={set("title")} maxLength={120} placeholder="e.g. Halloween Night" list="party-ideas" data-testid="party-title" />
          </Field>
          <datalist id="party-ideas">{IDEAS.map((i) => <option key={i} value={i} />)}</datalist>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description">
            <textarea className={inputCls} rows={3} value={f.description} onChange={set("description")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Highlights" hint="One per line, e.g. Live DJ, Karaoke night. Shown as a short list on the party page.">
            <textarea className={inputCls} rows={3} maxLength={2000} value={f.highlights} onChange={set("highlights")} data-testid="party-highlights" />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="What is included" hint="One per line, e.g. Unlimited IMFL, Starters, Entry.">
            <textarea className={inputCls} rows={3} maxLength={2000} value={f.inclusions} onChange={set("inclusions")} data-testid="party-inclusions" />
          </Field>
        </div>
        <Field label="Dress code">
          <input className={inputCls} maxLength={300} value={f.dress_code} onChange={set("dress_code")} placeholder="e.g. Smart casual" data-testid="party-dress" />
        </Field>
        <Field label="Minimum age (18 to 25)">
          <input type="number" min="18" max="25" className={inputCls} value={f.min_age} onChange={set("min_age")} data-testid="party-minage" />
        </Field>
        <Field label="Venue">
          <select className={inputCls} value={f.venue_id} onChange={set("venue_id")} disabled={locked} data-testid="party-venue">
            <option value="">Choose a venue…</option>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>{v.name}{v.city ? ` — ${v.city}` : ""}</option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" className={inputCls} value={f.party_date} onChange={set("party_date")} disabled={locked} data-testid="party-date" />
        </Field>
        <Field label="Start time">
          <input type="time" className={inputCls} value={f.start_time} onChange={set("start_time")} disabled={locked} data-testid="party-start" />
        </Field>
        <Field label="End time" hint="An end time before the start means it finishes after midnight.">
          <input type="time" className={inputCls} value={f.end_time} onChange={set("end_time")} disabled={locked} data-testid="party-end" />
        </Field>
        <Field label="Package type">
          <input className={inputCls} list="party-package-options" value={f.package_type} onChange={set("package_type")} placeholder="Pick or type, e.g. Premium" data-testid="party-package" />
          <datalist id="party-package-options">{PACKAGE_OPTIONS.map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        <Field label="Liquor type">
          <input className={inputCls} list="party-liquor-options" value={f.liquor_type} onChange={set("liquor_type")} placeholder="Pick or type, e.g. IMFL" data-testid="party-liquor" />
          <datalist id="party-liquor-options">{LIQUOR_OPTIONS.map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        <Field label="Price per person (₹)">
          <input type="number" min="1" className={inputCls} value={f.price_per_person} onChange={set("price_per_person")} disabled={locked} data-testid="party-price" />
        </Field>
        <Field label="Maximum seats per booking">
          <input type="number" min="1" className={inputCls} value={f.max_seats_per_booking} onChange={set("max_seats_per_booking")} />
        </Field>
        <Field label="Male seats">
          <input type="number" min="0" className={inputCls} value={f.male_seats} onChange={set("male_seats")} disabled={locked} data-testid="party-male" />
        </Field>
        <Field label="Female seats" hint={totalSeats ? `${totalSeats} seats in total` : ""}>
          <input type="number" min="0" className={inputCls} value={f.female_seats} onChange={set("female_seats")} disabled={locked} data-testid="party-female" />
        </Field>
        <Field label="Minimum paid seats to confirm">
          <input type="number" min="1" className={inputCls} value={f.min_paid_seats} onChange={set("min_paid_seats")} data-testid="party-min" />
        </Field>
        <Field label="Joining closes at (India time)" hint="Leave empty for 3 days before the party starts.">
          <input type="datetime-local" className={inputCls} value={f.closes_local} onChange={set("closes_local")} data-testid="party-closes" />
        </Field>

        <div className="sm:col-span-2">
          <p className="text-slate-600 text-xs font-medium mb-1">Cover photo</p>
          <div className="flex items-center gap-3">
            {f.cover_photo_url && <img src={f.cover_photo_url} alt="Cover" className="w-28 h-20 object-cover rounded border border-slate-200" />}
            <label className="text-sm border border-slate-300 rounded px-3 py-1.5 cursor-pointer hover:bg-slate-50">
              {uploading ? "Uploading…" : f.cover_photo_url ? "Replace photo" : "Upload photo"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onCover} disabled={uploading} data-testid="party-cover" />
            </label>
            {f.cover_photo_url && (
              <button type="button" className="text-xs text-slate-500 underline" onClick={() => setF((x) => ({ ...x, cover_photo_url: "" }))}>
                Remove
              </button>
            )}
          </div>
          <span className="block text-xs text-slate-400 mt-1">JPEG, PNG or WebP, up to 5 MB.</span>
        </div>

        <div className="sm:col-span-2">
          <Field
            label="Terms shown to guests"
            hint={editing ? "Changing the terms creates a new terms version. Guests accept the version in force when they join." : "Leave empty to use the standard PAXO terms. You can edit them after saving."}
          >
            <textarea className={`${inputCls} font-mono text-xs`} rows={editing ? 14 : 3} value={f.terms_text} onChange={set("terms_text")} data-testid="party-terms" />
          </Field>
          {editing && <p className="text-xs text-slate-400 mt-1">Terms version {current.terms_version}. The standard text mentions 30 seats, 50 guests, 10 seats per booking and 3 days: update it if this party uses different numbers.</p>}
        </div>
      </fieldset>

      <fieldset disabled={final || busy} className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-3">
          <p className="text-sm font-medium text-amber-900">Venue settlement — admin only</p>
          <p className="text-xs text-amber-800">What PAXO pays the venue for this party. Customers and partners never see this. Paid manually, recorded here.</p>
        </div>
        <Field label="Type">
          <select className={inputCls} value={f.settlement_type} onChange={set("settlement_type")} data-testid="settlement-type">
            <option value="">Not set</option>
            <option value="per_head">Amount per head (₹)</option>
            <option value="percentage">Percentage of sales (%)</option>
          </select>
        </Field>
        <Field label={f.settlement_type === "percentage" ? "Percentage (%)" : "Amount per head (₹)"}>
          <input type="number" min="0" className={inputCls} value={f.settlement_value} onChange={set("settlement_value")} data-testid="settlement-value" />
        </Field>
        <Field label="Note">
          <input className={inputCls} value={f.settlement_note} onChange={set("settlement_note")} maxLength={2000} data-testid="settlement-note" />
        </Field>
      </fieldset>

      {editing && status !== "draft" && <PartyMoney session={session} party={{ ...current, status }} />}
      {editing && status !== "draft" && <PartyGuests session={session} party={{ ...current, status }} />}
      {editing && <PartyMenu session={session} party={{ ...current, status, venue_name: venues.find((x) => x.id === current.venue_id)?.name || "" }} />}

      {!final && (
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <button onClick={save} disabled={busy || uploading} className="bg-slate-900 text-white text-sm font-medium rounded px-5 py-2 disabled:opacity-50" data-testid="party-save">
            {busy ? "Saving…" : editing ? "Save changes" : "Create draft"}
          </button>
          {editing && status === "draft" && (
            <button onClick={() => changeStatus("published")} disabled={busy} className="bg-emerald-600 text-white text-sm font-medium rounded px-5 py-2 disabled:opacity-50" data-testid="party-publish">
              Publish to customers
            </button>
          )}
          {editing && status === "draft" && (
            <button onClick={deleteDraft} disabled={busy} className="text-sm text-slate-500 underline">Delete draft</button>
          )}
          {editing && !cancelling && (
            <button onClick={() => setCancelling(true)} disabled={busy} className="bg-rose-100 text-rose-800 text-sm font-medium rounded px-5 py-2 ml-auto" data-testid="party-cancel-open">
              Cancel party
            </button>
          )}
        </div>
      )}

      {cancelling && (
        <div className="border border-rose-200 bg-rose-50 rounded-lg p-4 mb-6" data-testid="party-cancel-box">
          <p className="text-sm font-medium text-rose-800 mb-1">Cancel this party?</p>
          <p className="text-xs text-rose-700 mb-3">It disappears from the customer app and cannot be reopened. Cancelling also puts every paid guest on the 100% refund list (under Seats and money).</p>
          <input className={inputCls} placeholder="Reason (kept for your records)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} />
          <div className="flex gap-3 mt-3">
            <button onClick={() => changeStatus("cancelled", { cancel_reason: cancelReason.trim() || null })} disabled={busy} className="bg-rose-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50" data-testid="party-cancel-confirm">
              {busy ? "Cancelling…" : "Yes, cancel the party"}
            </button>
            <button onClick={() => setCancelling(false)} className="text-sm text-slate-600 underline">Keep it</button>
          </div>
        </div>
      )}

      {status === "cancelled" && current.cancel_reason && <p className="text-sm text-slate-500">Cancelled: {current.cancel_reason}</p>}
    </div>
  );
}

export default function PartyPoolAdmin({ session }) {
  const [parties, setParties] = useState([]);
  const [venues, setVenues] = useState([]);
  const [seatRows, setSeatRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState(null); // null = list, "new", or a party id

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, v, s] = await Promise.all([
        sb("/rest/v1/parties?select=*&order=starts_at.desc&limit=1000", { token: session.token }),
        sb("/rest/v1/venues?select=id,name,city&order=name.asc&limit=2000", { token: session.token }),
        sb("/rest/v1/party_seats?select=party_id,gender,status&limit=20000", { token: session.token }),
      ]);
      setParties(p || []);
      setVenues(v || []);
      setSeatRows(s || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const seatCounts = seatRows.reduce((acc, s) => {
    const c = (acc[s.party_id] ||= { paid_male: 0, paid_female: 0, held: 0 });
    if (s.status === "paid") c[s.gender === "male" ? "paid_male" : "paid_female"] += 1;
    else if (s.status === "held") c.held += 1;
    return acc;
  }, {});
  const venueName = (id) => venues.find((v) => v.id === id)?.name || "—";
  const shown = parties.filter((p) => filter === "all" || p.status === filter);

  function onSaved(row, deletedId) {
    if (deletedId) return setParties((ps) => ps.filter((p) => p.id !== deletedId));
    setParties((ps) => (ps.some((p) => p.id === row.id) ? ps.map((p) => (p.id === row.id ? row : p)) : [row, ...ps]));
  }

  if (view) {
    const party = view === "new" ? null : parties.find((p) => p.id === view);
    return <PartyEditor key={view} session={session} party={party} venues={venues} seatCounts={seatCounts} onBack={() => { setView(null); load(); }} onSaved={onSaved} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold">Party Pool</h1>
        <button onClick={() => setView("new")} className="bg-slate-900 text-white rounded px-4 py-2 text-sm" data-testid="new-party">New party</button>
      </div>
      <p className="text-sm text-slate-500 mb-4">Themed group parties where PAXO sells the seats and the venue provides the services.</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={`text-sm px-3 py-1.5 rounded-full border ${filter === k ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"}`}>
            {l}{k !== "all" ? ` (${parties.filter((p) => p.status === k).length})` : ` (${parties.length})`}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-slate-400 text-sm" data-testid="parties-empty">{parties.length === 0 ? "No parties yet. Create the first one." : "No parties in this view."}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Party</th>
                <th className="text-left px-4 py-2 hidden sm:table-cell">Venue</th>
                <th className="text-left px-4 py-2">Date</th>
                <th className="text-left px-4 py-2 hidden md:table-cell">Price</th>
                <th className="text-left px-4 py-2">Paid seats</th>
                <th className="text-left px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const c = seatCounts[p.id] || { paid_male: 0, paid_female: 0 };
                return (
                  <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setView(p.id)} data-testid={`party-row-${p.id}`}>
                    <td className="px-4 py-2.5 font-medium">{p.title}</td>
                    <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">{venueName(p.venue_id)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{fmtDay(p.party_date)} · {hhmm(p.start_time)}</td>
                    <td className="px-4 py-2.5 text-slate-600 hidden md:table-cell">{inr(p.price_per_person)}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.paid_male + c.paid_female} of {p.min_paid_seats} <span className="text-xs text-slate-400">({c.paid_male}M / {c.paid_female}F)</span></td>
                    <td className="px-4 py-2.5"><StatusPill status={p.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

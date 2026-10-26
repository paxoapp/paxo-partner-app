import { useState, useEffect, useCallback } from "react";
import { sb, SUPABASE_URL, ANON_KEY } from "./supabase";
import { VENUE_TYPES } from "./onboarding";

// Admin "Managed venues" tab: PAXO adds a venue on the owner's behalf, runs its partner login, and later hands it over.
// Passwords are made and shown by the admin-only edge functions. Here a password lives only in this component's state,
// is shown once with copy buttons, and is dropped as soon as the box is closed. It is never written anywhere.

async function callFn(slug, token, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_e) {
    data = {};
  }
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Same rule as the server (the server decides; this only saves a round trip).
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const isEmail = (v) => v.length <= 200 && !v.includes("..") && EMAIL_RE.test(v);
const EMAIL_HELP = 'Enter a valid email: letters, digits and . _ + - only, no spaces, no "mailto:".';

const newRequestId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

const EMPTY = {
  name: "",
  venue_type: "",
  city: "",
  area: "",
  address: "",
  google_maps_url: "",
  guest_capacity: "",
  contact_person_name: "",
  contact_phone: "",
  owner_contact_email: "",
  gst_no: "",
};

function CopyField({ label, value, testid }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) {
      /* the value is on screen to copy by hand */
    }
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 text-slate-500 shrink-0">{label}</span>
      <code className="flex-1 bg-white border border-slate-200 rounded px-2 py-1 break-all select-all" data-testid={testid}>
        {value}
      </code>
      <button type="button" onClick={copy} className="text-xs border border-slate-300 rounded px-2 py-1 hover:bg-slate-50">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Shown ONCE. Closing it forgets the password.
function CredentialsBox({ title, creds, onClose }) {
  return (
    <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-4 mb-5" data-testid="credentials-box">
      <p className="font-semibold text-emerald-800">{title}</p>
      <p className="text-xs text-emerald-700 mt-1 mb-3">
        Save the password now. It is shown only this once, is not stored anywhere, and cannot be looked up later. If you lose it, use
        “Reset managed password”.
      </p>
      <div className="flex flex-col gap-2">
        <CopyField label="Login email" value={creds.login_email} testid="cred-email" />
        <CopyField label="Password" value={creds.password} testid="cred-password" />
      </div>
      <button type="button" onClick={onClose} className="mt-3 text-sm bg-slate-900 text-white rounded px-3 py-1.5">
        I have saved it
      </button>
    </div>
  );
}

// Module-level on purpose: a component defined INSIDE AddVenueForm is a new component on every keystroke, so React
// throws the old input away and the cursor is lost after each character.
function Field({ label, required, hint, value, onChange, children }) {
  return (
    <label className="block text-sm">
      <span className="block mb-1 font-medium">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children || <input value={value} onChange={onChange} className="w-full border border-slate-300 rounded px-3 py-2" />}
      {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
    </label>
  );
}

function AddVenueForm({ session, onDone, onCancel }) {
  const [f, setF] = useState(EMPTY);
  const [requestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dup, setDup] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e, allowDuplicate = false) {
    e?.preventDefault();
    setError("");
    const ownerEmail = f.owner_contact_email.trim().toLowerCase();
    if (ownerEmail && !isEmail(ownerEmail)) return setError(EMAIL_HELP);
    setBusy(true);
    try {
      const r = await callFn("admin-create-managed-venue", session.token, { ...f, owner_contact_email: ownerEmail, request_id: requestId, allow_duplicate: allowDuplicate });
      onDone(r);
    } catch (err) {
      if (err.status === 409 && err.data?.duplicate) setDup(true);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-white border border-slate-200 rounded-lg p-5 mb-6" data-testid="add-venue-form">
      <h2 className="text-lg font-semibold mb-1">Add a venue (managed by PAXO)</h2>
      <p className="text-xs text-slate-500 mb-4">
        PAXO creates the venue's login and runs it until you hand the dashboard over to the owner. The owner receives nothing before then.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field value={f.name} onChange={set("name")} label="Venue name" required />
        <Field label="Venue type" required>
          <select value={f.venue_type} onChange={set("venue_type")} className="w-full border border-slate-300 rounded px-3 py-2 bg-white">
            <option value="">Select…</option>
            {VENUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field value={f.city} onChange={set("city")} label="City" required />
        <Field value={f.area} onChange={set("area")} label="Area" />
        <div className="sm:col-span-2">
          <Field value={f.address} onChange={set("address")} label="Address" />
        </div>
        <div className="sm:col-span-2">
          <Field value={f.google_maps_url} onChange={set("google_maps_url")} label="Google Maps link (optional)" />
        </div>
        <Field value={f.guest_capacity} onChange={set("guest_capacity")} label="Guest capacity" />
        <Field value={f.contact_person_name} onChange={set("contact_person_name")} label="Contact person" required />
        <Field value={f.contact_phone} onChange={set("contact_phone")} label="Contact phone" required />
        <Field
          value={f.owner_contact_email} onChange={set("owner_contact_email")}
          label="Owner email (private)"
          hint="Stored only. Nothing is sent to it until you press “Send dashboard to owner”."
        />
        <Field value={f.gst_no} onChange={set("gst_no")} label="GST number (optional)" hint="FSSAI and liquor documents can be added later from the partner dashboard." />
      </div>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      <div className="flex gap-3 mt-4 items-center">
        <button disabled={busy} className="bg-slate-900 text-white rounded px-4 py-2 text-sm disabled:opacity-50">
          {busy ? "Adding…" : "Add venue"}
        </button>
        {dup && (
          <button type="button" disabled={busy} onClick={(e) => submit(e, true)} className="text-sm underline text-slate-700">
            It is a different venue — add it anyway
          </button>
        )}
        <button type="button" onClick={onCancel} className="text-sm text-slate-500">
          Cancel
        </button>
      </div>
    </form>
  );
}

function HandoverBox({ session, venue, onClose, onDone }) {
  const [email, setEmail] = useState(venue.owner_contact_email || "");
  const cleanEmail = email.trim().toLowerCase();
  const [step, setStep] = useState("edit"); // 'edit' | 'confirm'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    try {
      await callFn("admin-handover-managed-venue", session.token, { venue_id: venue.id, owner_email: cleanEmail, confirm: true });
      onDone();
    } catch (e) {
      setError(e.message);
      setStep("edit");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg p-4 mt-3" data-testid="handover-box">
      <p className="font-semibold text-sm">Send dashboard to owner — {venue.name}</p>
      {step === "edit" ? (
        <>
          <label className="block text-sm mt-2">
            <span className="block mb-1">Owner's email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 bg-white" />
          </label>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex gap-3 mt-3">
            <button disabled={!cleanEmail} onClick={() => (isEmail(cleanEmail) ? (setError(""), setStep("confirm")) : setError(EMAIL_HELP))} className="bg-slate-900 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50">
              Continue
            </button>
            <button onClick={onClose} className="text-sm text-slate-500">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm mt-2">
            This moves the venue's login to <strong>{cleanEmail}</strong>, switches off PAXO management, ends the PAXO login's sessions, and emails the
            owner a link to set their password. PAXO can no longer use the managed login afterwards. Continue?
          </p>
          <div className="flex gap-3 mt-3">
            <button disabled={busy} onClick={go} className="bg-amber-600 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50">
              {busy ? "Sending…" : "Yes, send the dashboard"}
            </button>
            <button disabled={busy} onClick={() => setStep("edit")} className="text-sm text-slate-500">
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function ManagedVenuesAdmin({ session }) {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [creds, setCreds] = useState(null); // { title, login_email, password } — memory only
  const [handoverId, setHandoverId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await sb(
        "/rest/v1/venues?managed_by_paxo=eq.true&select=id,name,city,venue_type,is_live,status,business_email,owner_contact_email,contact_person_name,contact_phone,created_at&order=created_at.desc",
        { token: session.token }
      );
      setVenues(rows || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  async function resetPassword(v) {
    if (!window.confirm(`Make a new password for ${v.name}'s managed login? The old password stops working and anyone logged in with it is signed out.`)) return;
    setBusyId(v.id);
    setError("");
    setNotice("");
    try {
      const r = await callFn("admin-reset-managed-password", session.token, { venue_id: v.id });
      setCreds({ title: `New password for ${v.name}`, login_email: r.login_email, password: r.password });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Managed venues</h1>
          <p className="text-sm text-slate-500">Venues PAXO runs for the owner until the dashboard is handed over.</p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="bg-slate-900 text-white rounded px-4 py-2 text-sm" data-testid="add-venue-btn">
            Add venue
          </button>
        )}
      </div>

      {notice && (
        <p className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-3 py-2 mb-4" data-testid="venue-notice">
          {notice}
        </p>
      )}
      {creds && <CredentialsBox title={creds.title} creds={creds} onClose={() => setCreds(null)} />}
      {adding && (
        <AddVenueForm
          session={session}
          onCancel={() => setAdding(false)}
          onDone={(r) => {
            setAdding(false);
            setNotice(r.already_created ? "This venue was already added." : "Venue added successfully");
            if (r.password) setCreds({ title: "Login for the new venue", login_email: r.login_email, password: r.password });
            load();
          }}
        />
      )}

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : venues.length === 0 ? (
        <p className="text-slate-400 text-sm">No managed venues yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {venues.map((v) => (
            <div key={v.id} className="bg-white border border-slate-200 rounded-lg p-4" data-testid={`managed-${v.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{v.name}</p>
                  <p className="text-xs text-slate-500">
                    {[v.venue_type, v.city].filter(Boolean).join(" · ")} · {v.is_live ? "Live for customers" : "Not published yet"}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">Managed login: {v.business_email}</p>
                  <p className="text-xs text-slate-500">
                    Owner: {v.contact_person_name || "—"} {v.contact_phone ? `· ${v.contact_phone}` : ""} {v.owner_contact_email ? `· ${v.owner_contact_email}` : ""}
                  </p>
                </div>
                <div className="flex flex-col gap-2 items-end shrink-0">
                  <button
                    disabled={busyId === v.id}
                    onClick={() => resetPassword(v)}
                    className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Reset managed password
                  </button>
                  <button onClick={() => setHandoverId(handoverId === v.id ? null : v.id)} className="text-xs bg-slate-900 text-white rounded px-3 py-1.5">
                    Send dashboard to owner
                  </button>
                </div>
              </div>
              {!v.is_live && (
                <p className="text-xs text-slate-500 mt-2">To publish: Onboarding → Approved → open this venue → “Publish to customers” (needs address, 3+ photos, menu, 2+ packages).</p>
              )}
              {handoverId === v.id && (
                <HandoverBox
                  session={session}
                  venue={v}
                  onClose={() => setHandoverId(null)}
                  onDone={() => {
                    setHandoverId(null);
                    setNotice(`Dashboard sent. ${v.name} is no longer managed by PAXO.`);
                    load();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

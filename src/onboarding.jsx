import { useState } from "react";
import { sb, uploadPartnerDocument } from "./supabase";
import StatusStepper from "./StatusStepper";

export const VENUE_TYPES = [
  "Banquet Hall",
  "Hotel",
  "Restaurant",
  "Rooftop",
  "Lawn / Farmhouse",
  "Club / Lounge",
  "Resort",
  "Conference / Community Hall",
  "Other",
];

// Standard rejection reasons — a UI dropdown only. The final free text is what
// gets stored in venues.rejection_note.
export const REJECTION_REASONS = [
  "Venue created by an unauthorized person",
  "Venue not found / doesn't exist at the given address during verification",
  "Duplicate submission — venue already exists on PAXO",
  "Contact details could not be verified (invalid/unreachable phone or email)",
  "GST details do not match the venue/business name",
  "Submitted documents are unclear, invalid, or expired",
  "Other",
];

export const VENUE_STATUS_LABELS = {
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
};

const inputCls =
  "bg-stone-900 border border-white/10 rounded-2xl px-4 py-3 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent w-full";
const labelCls = "text-xs font-medium text-stone-300 mb-1 block";

function Field({ label, children }) {
  return (
    <div>
      <span className={labelCls}>{label}</span>
      {children}
    </div>
  );
}

/**
 * Stage 1 — Basic Details. Used both for a first-time submission (creates the
 * venue + links partner_users) and for a resubmission after rejection (patches
 * the existing venue and bumps submitted_at so it resurfaces in the admin queue;
 * status stays 'rejected' because the DB trigger blocks partners changing it).
 */
export function VenueSubmissionForm({ session, initial, onSubmitted, onCancel }) {
  const isResubmit = !!initial?.id;
  const [f, setF] = useState({
    owner_name: initial?.owner_name || "",
    contact_person_name: initial?.contact_person_name || "",
    contact_phone: initial?.contact_phone || "",
    additional_contact_no: initial?.additional_contact_no || "",
    business_email: initial?.business_email || session?.email || "",
    name: initial?.name || "",
    venue_type: initial?.venue_type || "",
    city: initial?.city || "",
    area: initial?.area || "",
    address: initial?.address || "",
    guest_capacity: initial?.guest_capacity ?? "",
    serves_alcohol: initial?.serves_alcohol ?? false,
    description: initial?.description || "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError("");
    const required = ["owner_name", "contact_person_name", "contact_phone", "business_email", "name", "venue_type", "city", "address"];
    for (const k of required) {
      if (!String(f[k] ?? "").trim()) {
        setError("Please fill in all required fields.");
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        owner_name: f.owner_name.trim(),
        contact_person_name: f.contact_person_name.trim(),
        contact_phone: f.contact_phone.trim(),
        additional_contact_no: f.additional_contact_no.trim() || null,
        business_email: f.business_email.trim(),
        name: f.name.trim(),
        venue_type: f.venue_type,
        city: f.city.trim(),
        area: f.area.trim() || null,
        address: f.address.trim(),
        guest_capacity: f.guest_capacity === "" ? null : parseInt(f.guest_capacity, 10),
        serves_alcohol: !!f.serves_alcohol,
        description: f.description.trim() || null,
      };

      if (isResubmit) {
        // Partner may freely edit these fields; status/is_verified/rejection_note
        // are trigger-locked so we leave them. venues.updated_at is bumped by a
        // DB trigger on any update, which is what resurfaces the venue in the
        // admin queue after an edit.
        await sb(`/rest/v1/venues?id=eq.${initial.id}`, {
          method: "PATCH",
          token: session.token,
          prefer: "return=minimal",
          body: payload,
        });
      } else {
        // Mint the venue id client-side and use return=minimal. A freshly
        // inserted venue matches no SELECT policy yet (the partner_users link
        // below doesn't exist, status isn't 'approved', we're not an admin), so
        // Prefer: return=representation round-trips a SELECT that RLS blocks —
        // which PostgREST reports as a misleading "new row violates row-level
        // security policy for table venues" (42501), even though the INSERT
        // itself is allowed and the bearer token is valid.
        const venueId = crypto.randomUUID();
        await sb("/rest/v1/venues", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body: { id: venueId, ...payload, status: "submitted", submitted_at: new Date().toISOString() },
        });
        await sb("/rest/v1/partner_users", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body: {
            id: session.userId,
            venue_id: venueId,
            full_name: f.contact_person_name.trim(),
            phone: f.contact_phone.trim(),
          },
        });
      }
      await onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-white font-semibold text-lg">
        {isResubmit ? "Update your venue details" : "Tell us about your venue"}
      </h2>
      <p className="text-stone-400 text-xs -mt-1 mb-1">
        Step 1 of 2 — Basic details. Our team reviews this before asking for documents.
      </p>

      <Field label="Owner name *">
        <input className={inputCls} value={f.owner_name} onChange={set("owner_name")} />
      </Field>
      <Field label="Contact person name *">
        <input className={inputCls} value={f.contact_person_name} onChange={set("contact_person_name")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact phone *">
          <input className={inputCls} value={f.contact_phone} onChange={set("contact_phone")} />
        </Field>
        <Field label="Additional contact (optional)">
          <input className={inputCls} value={f.additional_contact_no} onChange={set("additional_contact_no")} />
        </Field>
      </div>
      <Field label="Business email *">
        <input type="email" className={inputCls} value={f.business_email} onChange={set("business_email")} />
      </Field>

      <Field label="Venue name *">
        <input className={inputCls} value={f.name} onChange={set("name")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Venue type *">
          <select className={inputCls} value={f.venue_type} onChange={set("venue_type")}>
            <option value="">Select…</option>
            {VENUE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="Guest capacity">
          <input type="number" min="0" className={inputCls} value={f.guest_capacity} onChange={set("guest_capacity")} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City *">
          <input className={inputCls} value={f.city} onChange={set("city")} />
        </Field>
        <Field label="Area">
          <input className={inputCls} value={f.area} onChange={set("area")} />
        </Field>
      </div>
      <Field label="Full address *">
        <textarea rows={2} className={inputCls} value={f.address} onChange={set("address")} />
      </Field>

      <Field label="Serves alcohol?">
        <div className="flex gap-2">
          {[["Yes", true], ["No", false]].map(([lbl, val]) => (
            <button
              type="button"
              key={lbl}
              onClick={() => setF({ ...f, serves_alcohol: val })}
              className={`px-4 py-2 rounded-2xl text-sm border ${
                f.serves_alcohol === val
                  ? "bg-accent text-[#170D0B] border-accent"
                  : "border-stone-700 text-stone-300"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Description">
        <textarea rows={3} className={inputCls} value={f.description} onChange={set("description")} />
      </Field>

      {error && <p className="text-rose-400 text-sm">{error}</p>}
      <div className="flex gap-2 mt-1">
        <button
          disabled={saving}
          className="bg-accent text-[#170D0B] rounded-full px-5 py-3 text-sm font-semibold disabled:opacity-50"
        >
          {saving ? "Submitting…" : isResubmit ? "Resubmit for review" : "Submit for review"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-stone-400 text-sm px-4">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Stage 2 — Documents. Only shown while status = 'under_review'. */
function DocumentsForm({ session, venue, onSubmitted }) {
  const [gstNo, setGstNo] = useState(venue.gst_no || "");
  const [gstFile, setGstFile] = useState(null);
  const [liquorFile, setLiquorFile] = useState(null);
  const [fssaiFile, setFssaiFile] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const hasGstDoc = !!venue.gst_document_url;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!gstNo.trim()) {
      setError("GST number is required.");
      return;
    }
    if (!hasGstDoc && !gstFile) {
      setError("Please upload your GST document.");
      return;
    }
    setSaving(true);
    try {
      const body = { gst_no: gstNo.trim() };
      if (gstFile) body.gst_document_url = await uploadPartnerDocument(session.token, venue.id, gstFile, "gst");
      if (liquorFile) body.liquor_license_url = await uploadPartnerDocument(session.token, venue.id, liquorFile, "liquor");
      if (fssaiFile) body.fssai_license_url = await uploadPartnerDocument(session.token, venue.id, fssaiFile, "fssai");
      // Deliberately NOT changing status — it stays 'under_review' until an admin acts.
      await sb(`/rest/v1/venues?id=eq.${venue.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body,
      });
      await onSubmitted();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const fileCls = "text-sm text-stone-300 file:mr-3 file:rounded-full file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-[#170D0B] file:text-xs file:font-semibold";

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <h2 className="text-white font-semibold text-lg">Submit your documents</h2>
      <p className="text-stone-400 text-xs -mt-1 mb-1">
        Step 2 of 2. GST is mandatory. Adding your Liquor License and FSSAI License makes your venue
        eligible for a <span className="text-emerald-400">Verified</span> badge.
      </p>

      <Field label="GST number *">
        <input className={inputCls} value={gstNo} onChange={(e) => setGstNo(e.target.value)} />
      </Field>
      <Field label={`GST document ${hasGstDoc ? "(uploaded — choose a file to replace)" : "*"}`}>
        <input type="file" className={fileCls} accept="image/*,application/pdf" onChange={(e) => setGstFile(e.target.files[0] || null)} />
      </Field>
      <Field label={`Liquor license (optional)${venue.liquor_license_url ? " — uploaded" : ""}`}>
        <input type="file" className={fileCls} accept="image/*,application/pdf" onChange={(e) => setLiquorFile(e.target.files[0] || null)} />
      </Field>
      <Field label={`FSSAI license (optional)${venue.fssai_license_url ? " — uploaded" : ""}`}>
        <input type="file" className={fileCls} accept="image/*,application/pdf" onChange={(e) => setFssaiFile(e.target.files[0] || null)} />
      </Field>

      {error && <p className="text-rose-400 text-sm">{error}</p>}
      <button
        disabled={saving}
        className="bg-accent text-[#170D0B] rounded-full px-5 py-3 text-sm font-semibold disabled:opacity-50 mt-1 self-start"
      >
        {saving ? "Uploading…" : "Submit documents"}
      </button>
    </form>
  );
}

/**
 * Status page — replaces the dashboard until the venue is approved.
 * `venue` is the joined venues row; `onChanged` re-fetches it.
 */
export function VenueStatusScreen({ session, venue, onChanged, onLogout }) {
  const [editingDocs, setEditingDocs] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const status = venue?.status;
  const hasDocs = !!venue?.gst_no;

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white px-6 py-10">
      <div className="max-w-md mx-auto w-full">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-baseline gap-2">
            <span className="font-black text-2xl">Paxo</span>
            <span className="text-xs text-accent font-medium">Partner</span>
          </div>
          <button onClick={onLogout} className="text-xs text-stone-400 hover:text-stone-200">
            Log out
          </button>
        </div>

        <div className="mb-6">
          <p className="text-xs font-medium text-stone-500 mb-1">Venue status</p>
          <h1 className="text-2xl font-bold">{venue?.name}</h1>
          <span
            className={`inline-block mt-2 text-xs px-2.5 py-1 rounded-full ${
              status === "approved"
                ? "bg-emerald-500/20 text-emerald-300"
                : status === "rejected"
                ? "bg-rose-500/20 text-rose-300"
                : status === "under_review"
                ? "bg-amber-500/20 text-amber-300"
                : "bg-sky-500/20 text-sky-300"
            }`}
          >
            {VENUE_STATUS_LABELS[status] || status}
          </span>
        </div>

        <div className="mb-6">
          <StatusStepper venue={venue} dark />
        </div>

        {status === "submitted" && (
          <div className="border border-stone-800 bg-stone-900/60 rounded-2xl p-5 text-sm text-stone-300">
            Your venue is under review. We'll notify you once the initial review is complete, then ask
            you to upload your documents.
          </div>
        )}

        {status === "under_review" && !resubmitting && (
          <div className="border border-stone-800 bg-stone-900/60 rounded-2xl p-5">
            {!hasDocs || editingDocs ? (
              <DocumentsForm
                session={session}
                venue={venue}
                onSubmitted={async () => {
                  setEditingDocs(false);
                  await onChanged();
                }}
              />
            ) : (
              <div className="text-sm text-stone-300 flex flex-col gap-3">
                <p className="text-emerald-300 font-medium">Documents submitted — awaiting final review.</p>
                <ul className="text-xs text-stone-400 list-disc pl-4">
                  <li>GST: {venue.gst_no}</li>
                  <li>Liquor license: {venue.liquor_license_url ? "uploaded" : "not provided"}</li>
                  <li>FSSAI license: {venue.fssai_license_url ? "uploaded" : "not provided"}</li>
                </ul>
                <button
                  onClick={() => setEditingDocs(true)}
                  className="self-start text-xs border border-stone-700 rounded-full px-3 py-1.5 text-stone-200"
                >
                  Edit / resubmit documents
                </button>
              </div>
            )}
          </div>
        )}

        {status === "rejected" && !resubmitting && (
          <div className="border border-rose-900/60 bg-rose-950/30 rounded-2xl p-5 flex flex-col gap-3">
            <div>
              <p className="text-rose-300 font-medium text-sm mb-1">Your submission was not approved</p>
              <p className="text-sm text-stone-200 whitespace-pre-wrap">
                {venue.rejection_note || "No reason was provided. Please contact support."}
              </p>
            </div>
            <button
              onClick={() => setResubmitting(true)}
              className="self-start bg-accent text-[#170D0B] rounded-full px-4 py-2 text-sm font-semibold"
            >
              Edit details & resubmit
            </button>
          </div>
        )}

        {resubmitting && (
          <div className="border border-stone-800 bg-stone-900/60 rounded-2xl p-5">
            <VenueSubmissionForm
              session={session}
              initial={venue}
              onSubmitted={async () => {
                setResubmitting(false);
                await onChanged();
              }}
              onCancel={() => setResubmitting(false)}
            />
            <p className="text-xs text-stone-500 mt-3">
              Resubmitting flags your venue for re-review. Its status stays “Rejected” until our team
              looks again.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { sb, signIn, fetchAdminRow, signedDocumentUrl } from "./supabase";
import { REJECTION_REASONS, VENUE_STATUS_LABELS } from "./onboarding";
import StatusStepper from "./StatusStepper";
import SocialLinks from "./SocialLinks";

const TABS = [
  ["submitted", "Submitted"],
  ["under_review", "Under Review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

const DEACTIVATION_REASONS = [
  "SLA not signed",
  "GST / compliance issue",
  "Repeated policy violations",
  "Fraudulent or misleading listing",
  "Other",
];

const HOLD_REASONS = [
  "Package price doesn't match the menu",
  "Menu needs to be updated",
  "GST document expired — please provide a new one",
  "Listing photos/details need correction",
  "Other",
];

const CUSTOMER_STATE_REASONS = [
  "Repeated no-shows",
  "Abusive behavior",
  "Fraudulent / suspicious booking activity",
  "Repeated last-minute cancellations",
  "Other",
];

const nowIso = () => new Date().toISOString();
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const inr = (n) =>
  Number(n || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

// Central place a real notification would fire from once providers exist.
function logStatusChange(venue, action, note) {
  // TODO: send email/SMS/WhatsApp notification once providers are configured
  // (transactional email + SMS/WhatsApp provider setup is not done yet).
  console.info("[admin action]", {
    venue_id: venue.id,
    venue_name: venue.name,
    action,
    note: note || null,
    at: nowIso(),
  });
}

function StatusBadge({ status, verified }) {
  const cls =
    status === "approved"
      ? "bg-emerald-100 text-emerald-800"
      : status === "rejected"
      ? "bg-rose-100 text-rose-800"
      : status === "under_review"
      ? "bg-amber-100 text-amber-800"
      : "bg-sky-100 text-sky-800";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{VENUE_STATUS_LABELS[status] || status}</span>
      {status === "approved" && verified && (
        <span className="text-xs px-2 py-0.5 rounded-full bg-teal-100 text-teal-800">Verified</span>
      )}
    </span>
  );
}

function DocLink({ path, label, onView }) {
  if (!path) return <span className="text-stone-400">{label}: not provided</span>;
  return (
    <button onClick={() => onView({ path, label })} className="text-teal-700 underline text-left w-fit">
      {label}: view document
    </button>
  );
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|avif)$/i;

// In-app document viewer. Signs a short-lived URL for the private object and
// renders it inline (image or PDF iframe). Closes on the X button, the Esc key,
// or a click on the backdrop.
function DocViewerModal({ session, doc, onClose }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    setUrl("");
    setErr("");
    signedDocumentUrl(session.token, doc.path)
      .then((u) => !cancelled && setUrl(u))
      .catch((e) => !cancelled && setErr(e.message || "Couldn't load document"));
    return () => {
      cancelled = true;
    };
  }, [session.token, doc.path]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isImage = IMAGE_EXT.test(doc.path);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={doc.label}
    >
      <div
        className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <p className="text-sm font-medium">{doc.label}</p>
          <button
            onClick={onClose}
            aria-label="Close document viewer"
            className="w-8 h-8 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-slate-100 flex items-center justify-center min-h-[300px]">
          {err ? (
            <p className="text-rose-600 text-sm p-6 text-center">{err}</p>
          ) : !url ? (
            <p className="text-slate-400 text-sm p-6">Loading…</p>
          ) : isImage ? (
            <img src={url} alt={doc.label} className="max-w-full max-h-[78vh] object-contain" />
          ) : (
            <iframe title={doc.label} src={url} className="w-full h-[78vh] border-0 bg-white" />
          )}
        </div>
        {url && (
          <div className="px-4 py-2 border-t border-slate-200 text-right">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-teal-700 underline"
            >
              Open in new tab
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function RejectForm({ onConfirm, onCancel, busy }) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  return (
    <div className="border border-rose-200 bg-rose-50 rounded-lg p-4 flex flex-col gap-3 mt-3">
      <p className="text-sm font-medium text-rose-800">Reject this venue</p>
      <select
        className="border border-stone-300 rounded px-3 py-2 text-sm"
        value={reason}
        onChange={(e) => {
          const r = e.target.value;
          setReason(r);
          if (r && r !== "Other") setText(r);
          if (r === "Other") setText("");
        }}
      >
        <option value="">Select a standard reason…</option>
        {REJECTION_REASONS.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <textarea
        rows={3}
        placeholder="Reason shown to the partner (required, editable)"
        className="border border-stone-300 rounded px-3 py-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !text.trim()}
          onClick={() => onConfirm(text.trim())}
          className="bg-rose-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Confirm rejection"}
        </button>
        <button onClick={onCancel} className="text-sm text-stone-500 px-3">Cancel</button>
      </div>
    </div>
  );
}

// Canned-reason + free-text form shared by venue hold/deactivate and package
// hold — same pattern as RejectForm above.
function StateReasonForm({ title, reasons, confirmLabel, tone, onConfirm, onCancel, busy }) {
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const toneCls =
    tone === "rose"
      ? { box: "border-rose-200 bg-rose-50", title: "text-rose-800", btn: "bg-rose-600" }
      : { box: "border-amber-200 bg-amber-50", title: "text-amber-800", btn: "bg-amber-600" };
  return (
    <div className={`border rounded-lg p-4 flex flex-col gap-3 mt-3 ${toneCls.box}`}>
      <p className={`text-sm font-medium ${toneCls.title}`}>{title}</p>
      <select
        className="border border-slate-300 rounded px-3 py-2 text-sm"
        value={reason}
        onChange={(e) => {
          const r = e.target.value;
          setReason(r);
          if (r && r !== "Other") setText(r);
          if (r === "Other") setText("");
        }}
      >
        <option value="">Select a standard reason…</option>
        {reasons.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <textarea
        rows={3}
        placeholder="Reason shown to the partner (required, editable)"
        className="border border-slate-300 rounded px-3 py-2 text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          disabled={busy || !text.trim()}
          onClick={() => onConfirm(text.trim())}
          className={`text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50 ${toneCls.btn}`}
        >
          {busy ? "Saving…" : confirmLabel}
        </button>
        <button onClick={onCancel} className="text-sm text-slate-500 px-3">Cancel</button>
      </div>
    </div>
  );
}

function VenueStatePill({ state }) {
  const cls =
    state === "deactivated"
      ? "bg-rose-100 text-rose-800"
      : state === "on_hold"
      ? "bg-amber-100 text-amber-800"
      : "bg-emerald-100 text-emerald-800";
  const label = state === "deactivated" ? "Deactivated" : state === "on_hold" ? "On Hold" : "Active";
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
}

function VenueDetail({ session, venue, onBack, onUpdated }) {
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewingDoc, setViewingDoc] = useState(null);

  const [addons, setAddons] = useState([]);
  const [addonsLoading, setAddonsLoading] = useState(true);
  const [addonBusyId, setAddonBusyId] = useState(null);
  const [addonError, setAddonError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAddonsLoading(true);
    sb(`/rest/v1/venue_addons?venue_id=eq.${venue.id}&select=*&order=created_at.asc`, {
      token: session.token,
    })
      .then((rows) => !cancelled && setAddons(rows))
      .catch((e) => !cancelled && setAddonError(e.message))
      .finally(() => !cancelled && setAddonsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [venue.id, session.token]);

  async function toggleAddon(addon) {
    setAddonError("");
    setAddonBusyId(addon.id);
    try {
      const [row] = await sb(`/rest/v1/venue_addons?id=eq.${addon.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: { is_active: !addon.is_active },
      });
      setAddons((rows) => rows.map((r) => (r.id === row.id ? row : r)));
    } catch (e) {
      setAddonError(e.message);
    } finally {
      setAddonBusyId(null);
    }
  }

  const [addonsEnabledBusy, setAddonsEnabledBusy] = useState(false);
  async function toggleAddonsEnabled() {
    setAddonError("");
    setAddonsEnabledBusy(true);
    try {
      const [row] = await sb(`/rest/v1/venues?id=eq.${venue.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: { addons_enabled: !venue.addons_enabled },
      });
      onUpdated(row);
    } catch (e) {
      setAddonError(e.message);
    } finally {
      setAddonsEnabledBusy(false);
    }
  }

  async function patch(body, action, note) {
    setBusy(true);
    setError("");
    try {
      const [row] = await sb(`/rest/v1/venues?id=eq.${venue.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body,
      });
      logStatusChange(venue, action, note);
      setRejecting(false);
      onUpdated(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const approveStage1 = () =>
    patch(
      {
        status: "under_review",
        reviewed_at: nowIso(),
        // Stamp the basic-review clearance once, permanently — the stepper uses
        // it to place a later rejection at the right step.
        ...(venue.stage1_cleared_at ? {} : { stage1_cleared_at: nowIso() }),
      },
      "approve_stage1"
    );
  const reject = (text) =>
    patch({ status: "rejected", rejection_note: text, reviewed_at: nowIso() }, "reject", text);
  const approveVerified = () =>
    patch({ status: "approved", is_verified: true, approved_at: nowIso(), reviewed_at: nowIso() }, "approve_verified");
  const approvePlain = () =>
    patch({ status: "approved", is_verified: false, approved_at: nowIso(), reviewed_at: nowIso() }, "approve_unverified");

  const hasGst = !!venue.gst_no;
  const canVerify = hasGst && !!venue.liquor_license_url && !!venue.fssai_license_url;
  // PostgREST returns this embed as a single object (the FK resolves to-one),
  // not an array — tolerate both shapes.
  const partner = Array.isArray(venue.partner_users)
    ? venue.partner_users[0]
    : venue.partner_users || null;

  const Row = ({ label, value }) => (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-stone-100 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="col-span-2 break-words">{value || "—"}</span>
    </div>
  );

  return (
    <div>
      <button onClick={onBack} className="text-sm text-stone-500 mb-4">← Back to queue</button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-semibold">{venue.name}</h2>
          <p className="text-stone-500 text-sm">{venue.venue_type} · {venue.city}</p>
        </div>
        <StatusBadge status={venue.status} verified={venue.is_verified} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <StatusStepper venue={venue} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Stage 1 — Basic details</h3>
        <Row label="Owner name" value={venue.owner_name} />
        <Row label="Contact person" value={venue.contact_person_name} />
        <Row label="Contact phone" value={venue.contact_phone} />
        <Row label="Additional contact" value={venue.additional_contact_no} />
        <Row label="Business email" value={venue.business_email} />
        <Row label="Venue type" value={venue.venue_type} />
        <Row label="Guest capacity" value={venue.guest_capacity} />
        <Row label="Serves alcohol" value={venue.serves_alcohol ? "Yes" : "No"} />
        <Row label="City / Area" value={[venue.city, venue.area].filter(Boolean).join(" / ")} />
        <Row label="Address" value={venue.address} />
        <Row label="Description" value={venue.description} />
        <Row label="Linked partner" value={partner ? `${partner.full_name || "—"} · ${partner.phone || "—"}` : "not linked"} />
        <Row label="Submitted" value={fmtDate(venue.submitted_at)} />
        <Row label="Reviewed" value={fmtDate(venue.reviewed_at)} />
        <Row label="Approved" value={fmtDate(venue.approved_at)} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Stage 2 — Documents</h3>
        {hasGst ? (
          <div className="flex flex-col gap-2 text-sm">
            <Row label="GST number" value={venue.gst_no} />
            <DocLink path={venue.gst_document_url} label="GST document" onView={setViewingDoc} />
            <DocLink path={venue.liquor_license_url} label="Liquor license" onView={setViewingDoc} />
            <DocLink path={venue.fssai_license_url} label="FSSAI license" onView={setViewingDoc} />
          </div>
        ) : (
          <p className="text-sm text-amber-700">Awaiting documents from partner.</p>
        )}
      </div>

      {venue.status === "rejected" && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-medium text-rose-800 mb-1">Rejection reason</p>
          <p className="whitespace-pre-wrap">{venue.rejection_note || "—"}</p>
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="font-medium text-sm">Add-Ons feature</h3>
            <p className="text-xs text-stone-500 mt-0.5">
              Turn the whole Add-Ons section on or off for this venue — customers won't see it, and the
              partner can't manage it, while it's off.
            </p>
          </div>
          <button
            type="button"
            disabled={addonsEnabledBusy}
            onClick={toggleAddonsEnabled}
            className={`text-xs font-medium px-3 py-1.5 rounded-full shrink-0 disabled:opacity-50 ${
              venue.addons_enabled
                ? "bg-emerald-100 text-emerald-700"
                : "bg-stone-200 text-stone-600"
            }`}
          >
            {addonsEnabledBusy ? "Saving…" : venue.addons_enabled ? "Enabled — turn off" : "Disabled — turn on"}
          </button>
        </div>

        <h3 className="font-medium text-sm mb-2">Add-ons offered</h3>
        <p className="text-xs text-stone-500 mb-2">
          What this partner has chosen to offer from PAXO's catalog. Deactivate here to hide anything
          inappropriate or duplicate.
        </p>
        {addonError && <p className="text-rose-600 text-xs mb-2">{addonError}</p>}
        {addonsLoading ? (
          <p className="text-stone-400 text-sm">Loading…</p>
        ) : addons.length === 0 ? (
          <p className="text-stone-400 text-sm">This venue hasn't added any add-ons yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {addons.map((a) => (
              <div key={a.id} className="flex items-start justify-between gap-3 py-1.5 border-b border-stone-100 last:border-b-0 text-sm">
                <div>
                  <span className="font-medium">{a.name}</span>
                  <span
                    className={`ml-2 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                      a.is_active ? "bg-emerald-100 text-emerald-700" : "bg-stone-200 text-stone-500"
                    }`}
                  >
                    {a.is_active ? "Visible" : "Hidden"}
                  </span>
                  {a.approval_status === "pending" && (
                    <span className="ml-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                      Pending approval
                    </span>
                  )}
                  {a.approval_status === "rejected" && (
                    <span className="ml-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">
                      Rejected
                    </span>
                  )}
                  {a.description && <p className="text-stone-500 text-xs mt-0.5">{a.description}</p>}
                </div>
                <button
                  type="button"
                  disabled={addonBusyId === a.id}
                  onClick={() => toggleAddon(a)}
                  className={`text-xs shrink-0 ${a.is_active ? "text-rose-600" : "text-emerald-600 font-medium"} disabled:opacity-50`}
                >
                  {addonBusyId === a.id ? "Saving…" : a.is_active ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      {venue.status === "submitted" && !rejecting && (
        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={approveStage1}
            className="bg-emerald-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
          >
            {busy ? "Working…" : "Approve → request documents"}
          </button>
          <button
            onClick={() => setRejecting(true)}
            className="border border-rose-300 text-rose-700 text-sm font-medium rounded px-4 py-2"
          >
            Reject
          </button>
        </div>
      )}

      {venue.status === "under_review" && !rejecting && (
        <div className="flex flex-wrap gap-2">
          <button
            disabled={busy || !hasGst || !canVerify}
            onClick={approveVerified}
            title={!canVerify ? "Needs GST + Liquor License + FSSAI" : ""}
            className="bg-teal-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
          >
            Approve with Verified tag
          </button>
          <button
            disabled={busy || !hasGst}
            onClick={approvePlain}
            className="bg-emerald-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
          >
            Approve without Verified tag
          </button>
          <button
            onClick={() => setRejecting(true)}
            className="border border-rose-300 text-rose-700 text-sm font-medium rounded px-4 py-2"
          >
            Reject
          </button>
          {!hasGst && (
            <p className="w-full text-xs text-amber-700 mt-1">
              Approve actions are disabled until the partner submits GST details.
            </p>
          )}
        </div>
      )}

      {(venue.status === "approved" || venue.status === "rejected") && !rejecting && (
        <p className="text-sm text-stone-500">
          This venue is {VENUE_STATUS_LABELS[venue.status].toLowerCase()}. Re-opening a decision isn't
          available yet.
        </p>
      )}

      {rejecting && (
        <RejectForm busy={busy} onConfirm={reject} onCancel={() => setRejecting(false)} />
      )}

      {viewingDoc && (
        <DocViewerModal session={session} doc={viewingDoc} onClose={() => setViewingDoc(null)} />
      )}
    </div>
  );
}

// Full picture of one transaction's money flow — what the customer paid PAXO,
// the platform fee PAXO retained, and what PAXO owes/paid the partner — plus
// the partner's bank details on file, so this doubles as settlement proof.
// Printable: the Print button and the app's header/nav carry print:hidden so
// only the receipt itself prints or "Save as PDF"s cleanly.
function TransactionReceipt({ session, payment: p, onBack }) {
  const [bank, setBank] = useState(null);
  const [bankLoading, setBankLoading] = useState(true);
  const b = p.bookings || {};
  const venueId = b.venues?.id;

  useEffect(() => {
    let cancelled = false;
    if (!venueId) {
      setBankLoading(false);
      return;
    }
    setBankLoading(true);
    sb(`/rest/v1/partner_bank_details?venue_id=eq.${venueId}&select=*`, { token: session.token })
      .then((rows) => !cancelled && setBank(rows[0] || null))
      .catch(() => !cancelled && setBank(null))
      .finally(() => !cancelled && setBankLoading(false));
    return () => {
      cancelled = true;
    };
  }, [venueId, session.token]);

  const Row = ({ label, value }) => (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-stone-100 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="col-span-2 break-words">{value ?? "—"}</span>
    </div>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-4 print:hidden">
        <button onClick={onBack} className="text-sm text-stone-500">
          ← Back to settlements
        </button>
        <button onClick={() => window.print()} className="text-sm bg-slate-900 text-white rounded px-4 py-2">
          Print / Save as PDF
        </button>
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-6 max-w-2xl mx-auto print:border-0 print:shadow-none">
        <div className="flex items-start justify-between mb-6">
          <div>
            <p className="font-black text-xl">PAXO</p>
            <p className="text-xs uppercase tracking-widest text-stone-400">Transaction Receipt</p>
          </div>
          <div className="text-right text-sm text-stone-500">
            <p>Booking ref: {b.booking_ref || "—"}</p>
            <p>Generated {fmtDateTime(new Date().toISOString())}</p>
          </div>
        </div>

        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">Booking</h3>
          <Row label="Venue" value={b.venues?.name} />
          <Row label="Package" value={b.venue_packages?.name} />
          <Row label="Event date" value={fmtDate(b.event_date)} />
          <Row label="Customer" value={b.contact_name} />
          <Row label="Customer mobile" value={b.contact_mobile} />
          <Row label="Customer email" value={b.contact_email} />
          {b.venue_packages?.price_per_head != null && (
            <Row
              label="Price per head"
              value={
                b.venue_packages.discount_percent > 0
                  ? `${inr(b.venue_packages.price_per_head)} − ${b.venue_packages.discount_percent}% offer`
                  : inr(b.venue_packages.price_per_head)
              }
            />
          )}
          <Row label="Guests" value={b.headcount} />
          <Row label="DJ" value={b.venue_packages?.includes_dj ? "Included" : "Not included"} />
          {b.venue_packages?.dj_notes && <Row label="DJ notes" value={b.venue_packages.dj_notes} />}
          <Row label="Total booking amount" value={inr(b.total_amount)} />
          {(b.booking_addon_requests || []).some((a) => a.status === "confirmed") && (
            <Row
              label="Add-ons (confirmed)"
              value={b.booking_addon_requests
                .filter((a) => a.status === "confirmed")
                .map((a) => `${a.addon_name} (${inr(a.price)})`)
                .join(", ")}
            />
          )}
        </div>

        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">1. Payment received — Customer → PAXO</h3>
          <Row label="Amount received" value={inr(p.amount)} />
          <Row label="Payment type" value={p.payment_type} />
          <Row label="Deposit tier" value={b.deposit_tier} />
          <Row label="Received on" value={fmtDateTime(p.paid_at)} />
          <Row label="Payment reference" value={p.razorpay_payment_id} />
        </div>

        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">2. Platform fee retained by PAXO</h3>
          <Row label="Platform fee" value={inr(p.platform_fee_amount)} />
        </div>

        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">3. Payout — PAXO → Partner</h3>
          <Row label="Payable to partner" value={inr(p.partner_payout_amount)} />
          <Row
            label="Settlement status"
            value={p.settlement_status === "settled" ? `Settled on ${fmtDate(p.settled_at)}` : "Pending"}
          />
        </div>

        <div className="mb-2">
          <h3 className="font-medium text-sm mb-2">Payout account on file</h3>
          {bankLoading ? (
            <p className="text-sm text-stone-400">Loading…</p>
          ) : bank ? (
            <>
              <Row label="Account holder" value={bank.account_holder_name} />
              <Row label="Account number" value={bank.account_number} />
              <Row label="IFSC" value={bank.ifsc_code} />
              <Row label="Bank" value={[bank.bank_name, bank.branch_name].filter(Boolean).join(", ") || null} />
              {bank.upi_id && <Row label="UPI" value={bank.upi_id} />}
            </>
          ) : (
            <p className="text-sm text-amber-700">No bank details on file for this partner yet.</p>
          )}
        </div>

        <p className="text-xs text-stone-400 mt-6 pt-4 border-t border-stone-100">
          Internal PAXO record of this transaction's flow of funds. Not a GST tax invoice.
        </p>
      </div>
    </div>
  );
}

const SETTLEMENT_TABS = [
  ["pending", "Pending"],
  ["settled", "Settled"],
  ["all", "All"],
];

// Records that a manual bank transfer to a partner has happened. The DB trigger
// on `payments` silently reverts any field other than settlement_status /
// settled_at, so a tampered PATCH can't alter a real financial record here.
function Settlements({ session }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("pending");
  const [confirming, setConfirming] = useState(null); // payment row awaiting confirmation
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [viewingReceipt, setViewingReceipt] = useState(null); // payment row awaiting the receipt view

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await sb(
        "/rest/v1/payments?status=eq.paid&select=id,razorpay_payment_id,amount,platform_fee_amount," +
          "partner_payout_amount,paid_at,settlement_status,settled_at,payment_type," +
          "bookings(id,booking_ref,event_date,total_amount,deposit_tier,headcount,contact_name,contact_mobile," +
          "contact_email,venues(id,name),venue_packages(name,price_per_head,discount_percent,includes_dj,dj_notes)," +
          "booking_addon_requests(addon_name,status,price))" +
          "&order=paid_at.desc.nullslast",
        { token: session.token }
      );
      setRows(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  async function markSettled(p) {
    setBusyId(p.id);
    setError("");
    try {
      const [updated] = await sb(`/rest/v1/payments?id=eq.${p.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: { settlement_status: "settled", settled_at: nowIso() },
      });
      setRows((rs) => rs.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
      setConfirming(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  const visible = rows.filter((r) => tab === "all" || r.settlement_status === tab);
  const counts = rows.reduce((a, r) => {
    a[r.settlement_status] = (a[r.settlement_status] || 0) + 1;
    return a;
  }, {});
  const pendingPayout = rows
    .filter((r) => r.settlement_status === "pending")
    .reduce((s, r) => s + Number(r.partner_payout_amount || 0), 0);

  if (viewingReceipt) {
    return (
      <TransactionReceipt session={session} payment={viewingReceipt} onBack={() => setViewingReceipt(null)} />
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Settlements</h1>
      <p className="text-sm text-slate-500 mb-4">
        Paid customer payments and the payout owed to each partner.{" "}
        {inr(pendingPayout)} pending across {counts.pending || 0} payment
        {(counts.pending || 0) === 1 ? "" : "s"}.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        {SETTLEMENT_TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-sm px-3 py-1.5 rounded-full border ${
              tab === key ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"
            }`}
          >
            {label}
            {key !== "all" && counts[key] ? ` (${counts[key]})` : ""}
          </button>
        ))}
      </div>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-slate-400 text-sm">No payments in this view.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Venue</th>
                <th className="text-left px-4 py-2">Event date</th>
                <th className="text-right px-4 py-2">Amount paid</th>
                <th className="text-right px-4 py-2">Platform fee</th>
                <th className="text-right px-4 py-2">Partner payout</th>
                <th className="text-left px-4 py-2">Paid on</th>
                <th className="text-left px-4 py-2">Settlement</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{p.bookings?.venues?.name || "—"}</span>
                    <span className="block text-xs text-slate-400 capitalize">{p.payment_type}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{fmtDate(p.bookings?.event_date)}</td>
                  <td className="px-4 py-2.5 text-right">{inr(p.amount)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">{inr(p.platform_fee_amount)}</td>
                  <td className="px-4 py-2.5 text-right font-medium">{inr(p.partner_payout_amount)}</td>
                  <td className="px-4 py-2.5 text-slate-600">{fmtDate(p.paid_at)}</td>
                  <td className="px-4 py-2.5">
                    {p.settlement_status === "settled" ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                        Settled · {fmtDate(p.settled_at)}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setViewingReceipt(p)}
                        className="text-xs border border-slate-300 text-slate-600 rounded px-3 py-1.5"
                      >
                        Receipt
                      </button>
                      {p.settlement_status === "pending" && (
                        <button
                          onClick={() => setConfirming(p)}
                          disabled={busyId === p.id}
                          className="text-xs bg-slate-900 text-white rounded px-3 py-1.5 disabled:opacity-50"
                        >
                          Mark as Settled
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            className="bg-white rounded-lg max-w-sm w-full p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-medium mb-1">Mark this settlement complete?</p>
            <p className="text-sm text-slate-600 mb-4">
              Confirm you've transferred {inr(confirming.partner_payout_amount)} to{" "}
              {confirming.bookings?.venues?.name || "this partner"}. This only records that the bank
              transfer has actually happened — it doesn't move any money.
            </p>
            {error && <p className="text-rose-600 text-sm mb-2">{error}</p>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirming(null)}
                className="text-sm text-slate-500 px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={() => markSettled(confirming)}
                disabled={busyId === confirming.id}
                className="text-sm bg-emerald-600 text-white rounded px-3 py-1.5 disabled:opacity-50"
              >
                {busyId === confirming.id ? "Saving…" : "Yes, mark as settled"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Booking status badge palette — same Tailwind classes the partner Requests
// screen uses (App.jsx `statusColor`), copied here to avoid importing from the
// partner app module.
const BOOKING_STATUS_CLS = {
  pending: "bg-amber-100 text-amber-800",
  accepted: "bg-blue-100 text-blue-800",
  rejected: "bg-rose-100 text-rose-800",
  confirmed: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
  unconfirmed: "bg-stone-200 text-stone-800",
  no_show: "bg-rose-100 text-rose-800",
};
const BOOKING_STATUS_ORDER = [
  "pending",
  "accepted",
  "rejected",
  "confirmed",
  "unconfirmed",
  "no_show",
  "cancelled",
  "completed",
];

function BookingStatusPill({ status }) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full capitalize ${
        BOOKING_STATUS_CLS[status] || "bg-slate-100 text-slate-700"
      }`}
    >
      {String(status || "").replace(/_/g, " ")}
    </span>
  );
}

const REQUEST_TABS = [
  ["all", "All"],
  ["pending", "Pending"],
  ["accepted", "Accepted"],
  ["confirmed", "Confirmed"],
  ["unconfirmed", "Unconfirmed"],
  ["completed", "Completed"],
  ["rejected", "Rejected"],
  ["no_show", "No-show"],
  ["cancelled", "Cancelled"],
];

// Full lifecycle view of a single booking request — who requested it, who it
// went to, whether/when they responded, and everything that happened after,
// so support staff can answer "what's going on with this booking" without
// having to ask the partner.
function RequestDetail({ booking: b, onBack }) {
  const Row = ({ label, value }) => (
    <div className="grid grid-cols-3 gap-2 py-1.5 border-b border-stone-100 text-sm">
      <span className="text-stone-500">{label}</span>
      <span className="col-span-2 break-words">{value ?? "—"}</span>
    </div>
  );

  return (
    <div>
      <button onClick={onBack} className="text-sm text-stone-500 mb-4">← Back to requests</button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-semibold">{b.venues?.name || "—"}</h2>
          <p className="text-stone-500 text-sm">
            {b.venue_packages?.name || "—"} · {fmtDate(b.event_date)}
          </p>
        </div>
        <BookingStatusPill status={b.status} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Customer</h3>
        <Row label="Name" value={b.contact_name} />
        <Row label="Mobile" value={b.contact_mobile} />
        <Row label="Email" value={b.contact_email} />
        <Row label="Headcount" value={b.headcount} />
        <Row label="Occasion" value={b.occasion_other} />
        <Row label="Special request" value={b.special_request} />
      </div>

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Timeline</h3>
        <Row label="Requested" value={fmtDateTime(b.requested_at)} />
        <Row label="Response deadline" value={fmtDateTime(b.response_deadline)} />
        <Row label="Responded" value={fmtDateTime(b.responded_at)} />
        <Row label="Last-minute booking" value={b.is_last_minute ? "Yes" : "No"} />
        <Row label="Menu finalized" value={fmtDateTime(b.menu_finalized_at)} />
        <Row label="Check-in OTP generated" value={fmtDateTime(b.checkin_otp_generated_at)} />
        <Row label="Event started (checked in)" value={fmtDateTime(b.event_started_at)} />
        <Row label="Cancelled" value={fmtDateTime(b.cancelled_at)} />
      </div>

      {b.status === "rejected" && b.rejection_reason && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-medium text-rose-800 mb-1">Rejection reason</p>
          <p className="whitespace-pre-wrap">{b.rejection_reason}</p>
        </div>
      )}

      {b.status === "cancelled" && b.cancellation_reason && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-medium text-rose-800 mb-1">Cancellation reason</p>
          <p className="whitespace-pre-wrap">{b.cancellation_reason}</p>
        </div>
      )}

      {b.partner_disclosure_note && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4 text-sm">
          <p className="font-medium text-amber-800 mb-1">
            Partner disclosure{b.disclosure_response ? ` · ${b.disclosure_response}` : ""}
          </p>
          <p className="whitespace-pre-wrap">{b.partner_disclosure_note}</p>
        </div>
      )}

      {(b.booking_addon_requests || []).length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
          <h3 className="font-medium text-sm mb-2">Add-ons requested</h3>
          {b.booking_addon_requests.map((a) => (
            <Row
              key={a.id}
              label={a.addon_name}
              value={
                a.status === "confirmed"
                  ? `Confirmed — ${inr(a.price)}`
                  : a.status === "declined"
                  ? "Declined"
                  : "Requested — pending review"
              }
            />
          ))}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Payment</h3>
        <Row label="Total amount" value={inr(b.total_amount)} />
        <Row label="Deposit tier" value={b.deposit_tier} />
        <Row label="Deposit amount" value={inr(b.deposit_amount)} />
        <Row label="Booking ref" value={b.booking_ref} />
      </div>
    </div>
  );
}

// Per-venue live-status control (Active / On Hold / Deactivated) plus booking
// activity and per-package hold — the admin's single place to see what's
// happening with an approved partner and step in when something's wrong.
function PartnersAdmin({ session }) {
  const [venues, setVenues] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [v, b] = await Promise.all([
        sb(
          "/rest/v1/venues?status=eq.approved&select=*,partner_users(full_name,phone)&order=name.asc",
          { token: session.token }
        ),
        sb("/rest/v1/bookings?select=id,venue_id,status", { token: session.token }),
      ]);
      setVenues(v);
      setBookings(b);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const bookingStatsFor = (venueId) =>
    bookings
      .filter((b) => b.venue_id === venueId)
      .reduce((acc, b) => {
        acc[b.status] = (acc[b.status] || 0) + 1;
        return acc;
      }, {});

  const counts = venues.reduce(
    (acc, v) => {
      acc[v.venue_state || "active"] = (acc[v.venue_state || "active"] || 0) + 1;
      return acc;
    },
    { active: 0, on_hold: 0, deactivated: 0 }
  );

  const q = search.trim().toLowerCase();
  const list = venues.filter((v) => {
    if (!q) return true;
    return [v.name, v.city, v.owner_name].filter(Boolean).some((f) => String(f).toLowerCase().includes(q));
  });

  const selected = venues.find((v) => v.id === selectedId) || null;

  if (selected) {
    return (
      <PartnerVenueDetail
        session={session}
        venue={selected}
        bookingStats={bookingStatsFor(selected.id)}
        onBack={() => setSelectedId(null)}
        onUpdated={(row) => setVenues((vs) => vs.map((v) => (v.id === row.id ? { ...v, ...row } : v)))}
      />
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Partner dashboard</h1>
      <p className="text-sm text-slate-500 mb-4">
        Live status control and booking activity for approved venues.
      </p>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      <div className="grid grid-cols-3 gap-3 mb-4 max-w-lg">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Live</p>
          <p className="text-xl font-semibold mt-1 text-emerald-700">{counts.active}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">On Hold</p>
          <p className="text-xl font-semibold mt-1 text-amber-700">{counts.on_hold}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Deactivated</p>
          <p className="text-xl font-semibold mt-1 text-rose-700">{counts.deactivated}</p>
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by venue, city, or owner…"
        className="border border-slate-300 rounded px-3 py-1.5 text-sm w-full sm:w-80 mb-3"
      />

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-slate-400 text-sm">No approved venues yet.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Venue</th>
                <th className="text-left px-4 py-2 hidden sm:table-cell">City</th>
                <th className="text-left px-4 py-2">Live status</th>
                <th className="text-left px-4 py-2 hidden md:table-cell">Bookings</th>
              </tr>
            </thead>
            <tbody>
              {list.map((v) => {
                const s = bookingStatsFor(v.id);
                const total = Object.values(s).reduce((a, n) => a + n, 0);
                return (
                  <tr
                    key={v.id}
                    className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setSelectedId(v.id)}
                  >
                    <td className="px-4 py-2.5 font-medium">{v.name}</td>
                    <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">{v.city}</td>
                    <td className="px-4 py-2.5">
                      <VenueStatePill state={v.venue_state || "active"} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 hidden md:table-cell">
                      {total} total
                      {total > 0 &&
                        ` (${s.accepted || 0} accepted, ${s.rejected || 0} rejected, ${s.cancelled || 0} cancelled, ${s.pending || 0} pending)`}
                    </td>
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

function PartnerVenueDetail({ session, venue, bookingStats, onBack, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(null); // 'hold' | 'deactivate' | null

  const [packages, setPackages] = useState([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packageError, setPackageError] = useState("");
  const [holdingPackageId, setHoldingPackageId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPackagesLoading(true);
    sb(`/rest/v1/venue_packages?venue_id=eq.${venue.id}&select=*&order=price_per_head.asc`, {
      token: session.token,
    })
      .then((rows) => !cancelled && setPackages(rows))
      .catch((e) => !cancelled && setPackageError(e.message))
      .finally(() => !cancelled && setPackagesLoading(false));
    return () => {
      cancelled = true;
    };
  }, [venue.id, session.token]);

  async function setVenueState(state, reason) {
    setBusy(true);
    setError("");
    try {
      const [row] = await sb(`/rest/v1/venues?id=eq.${venue.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: {
          venue_state: state,
          state_reason: state === "active" ? null : reason || null,
          state_changed_at: nowIso(),
          state_changed_by: session.userId,
        },
      });
      logStatusChange(venue, `venue_state:${state}`, reason);
      setShowForm(null);
      onUpdated(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function setPackageHold(pkg, hold, reason) {
    setPackageError("");
    try {
      const [row] = await sb(`/rest/v1/venue_packages?id=eq.${pkg.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: {
          admin_hold: hold,
          admin_hold_reason: hold ? reason || null : null,
          admin_hold_at: hold ? nowIso() : null,
          admin_hold_by: hold ? session.userId : null,
        },
      });
      setHoldingPackageId(null);
      setPackages((rows) => rows.map((r) => (r.id === row.id ? row : r)));
    } catch (e) {
      setPackageError(e.message);
    }
  }

  const bookingTotal = Object.values(bookingStats).reduce((a, n) => a + n, 0);

  return (
    <div>
      <button onClick={onBack} className="text-sm text-slate-500 mb-4">← Back to partner dashboard</button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-semibold">{venue.name}</h2>
          <p className="text-slate-500 text-sm">{venue.venue_type} · {venue.city}</p>
        </div>
        <VenueStatePill state={venue.venue_state || "active"} />
      </div>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Live status control</h3>
        {venue.venue_state && venue.venue_state !== "active" && (
          <p className="text-sm text-slate-600 mb-3">
            Current reason: <span className="font-medium">{venue.state_reason || "—"}</span>
          </p>
        )}
        {showForm === "hold" ? (
          <StateReasonForm
            title="Put this venue on hold — hidden from customers, partner keeps full access"
            reasons={HOLD_REASONS}
            confirmLabel="Confirm hold"
            tone="amber"
            busy={busy}
            onConfirm={(text) => setVenueState("on_hold", text)}
            onCancel={() => setShowForm(null)}
          />
        ) : showForm === "deactivate" ? (
          <StateReasonForm
            title="Deactivate this venue — hidden from customers, partner sees the reason"
            reasons={DEACTIVATION_REASONS}
            confirmLabel="Confirm deactivation"
            tone="rose"
            busy={busy}
            onConfirm={(text) => setVenueState("deactivated", text)}
            onCancel={() => setShowForm(null)}
          />
        ) : (
          <div className="flex gap-2 flex-wrap">
            {venue.venue_state && venue.venue_state !== "active" && (
              <button
                disabled={busy}
                onClick={() => setVenueState("active", null)}
                className="bg-emerald-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Reactivate — make live"}
              </button>
            )}
            {venue.venue_state !== "on_hold" && (
              <button
                disabled={busy}
                onClick={() => setShowForm("hold")}
                className="bg-amber-100 text-amber-800 text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                Put on hold
              </button>
            )}
            {venue.venue_state !== "deactivated" && (
              <button
                disabled={busy}
                onClick={() => setShowForm("deactivate")}
                className="bg-rose-100 text-rose-800 text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                Deactivate
              </button>
            )}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Bookings ({bookingTotal} total)</h3>
        {bookingTotal === 0 ? (
          <p className="text-slate-400 text-sm">No bookings yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {BOOKING_STATUS_ORDER.filter((s) => bookingStats[s]).map((s) => (
              <div
                key={s}
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2"
              >
                <BookingStatusPill status={s} />
                <span className="text-sm font-semibold">{bookingStats[s]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="font-medium text-sm mb-2">Packages</h3>
        {packageError && <p className="text-rose-600 text-sm mb-2">{packageError}</p>}
        {packagesLoading ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : packages.length === 0 ? (
          <p className="text-slate-400 text-sm">No packages yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {packages.map((p) => (
              <div key={p.id} className="border border-slate-200 rounded-lg p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{p.name}</p>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          p.is_published ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                        }`}
                      >
                        {p.is_published ? "Published" : "Draft"}
                      </span>
                      {p.admin_hold && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">
                          On hold
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500">{inr(p.price_per_head)} / head</p>
                    {p.admin_hold && (
                      <p className="text-xs text-rose-600 mt-1">Reason: {p.admin_hold_reason || "—"}</p>
                    )}
                  </div>
                  {holdingPackageId !== p.id && (
                    <button
                      onClick={() => (p.admin_hold ? setPackageHold(p, false, null) : setHoldingPackageId(p.id))}
                      className={`text-xs font-medium shrink-0 ${p.admin_hold ? "text-emerald-700" : "text-rose-600"}`}
                    >
                      {p.admin_hold ? "Release hold" : "Put on hold"}
                    </button>
                  )}
                </div>
                {holdingPackageId === p.id && (
                  <StateReasonForm
                    title={`Hold "${p.name}" — hidden from customers only`}
                    reasons={HOLD_REASONS}
                    confirmLabel="Confirm hold"
                    tone="amber"
                    busy={false}
                    onConfirm={(text) => setPackageHold(p, true, text)}
                    onCancel={() => setHoldingPackageId(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Registered-customer roster: how many signed up, their booking activity, and
// admin control to block new booking requests from a specific account (abuse,
// no-shows, fraud) without touching their existing bookings.
function CustomersAdmin({ session }) {
  const [profiles, setProfiles] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, b] = await Promise.all([
        sb(
          "/rest/v1/profiles?select=id,full_name,phone,email,no_show_count,rating_avg,created_at,account_state,state_reason&order=created_at.desc",
          { token: session.token }
        ),
        sb("/rest/v1/bookings?select=id,customer_id,status", { token: session.token }),
      ]);
      setProfiles(p);
      setBookings(b);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const bookingStatsFor = (customerId) =>
    bookings
      .filter((b) => b.customer_id === customerId)
      .reduce((acc, b) => {
        acc[b.status] = (acc[b.status] || 0) + 1;
        return acc;
      }, {});

  const counts = profiles.reduce(
    (acc, p) => {
      acc[p.account_state || "active"] = (acc[p.account_state || "active"] || 0) + 1;
      return acc;
    },
    { active: 0, on_hold: 0, deactivated: 0 }
  );

  const q = search.trim().toLowerCase();
  const list = profiles.filter((p) => {
    if (!q) return true;
    return [p.full_name, p.phone, p.email].filter(Boolean).some((f) => String(f).toLowerCase().includes(q));
  });

  const selected = profiles.find((p) => p.id === selectedId) || null;

  if (selected) {
    return (
      <CustomerDetail
        session={session}
        customer={selected}
        bookingStats={bookingStatsFor(selected.id)}
        onBack={() => setSelectedId(null)}
        onUpdated={(row) => setProfiles((ps) => ps.map((p) => (p.id === row.id ? { ...p, ...row } : p)))}
      />
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Customers</h1>
      <p className="text-sm text-slate-500 mb-4">
        {profiles.length} registered customer{profiles.length === 1 ? "" : "s"}.
      </p>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      <div className="grid grid-cols-3 gap-3 mb-4 max-w-lg">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Active</p>
          <p className="text-xl font-semibold mt-1 text-emerald-700">{counts.active}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">On Hold</p>
          <p className="text-xl font-semibold mt-1 text-amber-700">{counts.on_hold}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Deactivated</p>
          <p className="text-xl font-semibold mt-1 text-rose-700">{counts.deactivated}</p>
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name, phone, or email…"
        className="border border-slate-300 rounded px-3 py-1.5 text-sm w-full sm:w-80 mb-3"
      />

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-slate-400 text-sm">No customers yet.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Customer</th>
                <th className="text-left px-4 py-2 hidden sm:table-cell">Phone / Email</th>
                <th className="text-left px-4 py-2">Account</th>
                <th className="text-left px-4 py-2 hidden md:table-cell">Bookings</th>
                <th className="text-left px-4 py-2 hidden md:table-cell">Joined</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const s = bookingStatsFor(p.id);
                const total = Object.values(s).reduce((a, n) => a + n, 0);
                return (
                  <tr
                    key={p.id}
                    className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setSelectedId(p.id)}
                  >
                    <td className="px-4 py-2.5 font-medium">{p.full_name || "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600 hidden sm:table-cell">
                      {[p.phone, p.email].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <VenueStatePill state={p.account_state || "active"} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 hidden md:table-cell">
                      {total} total
                      {total > 0 &&
                        ` (${s.accepted || 0} accepted, ${s.rejected || 0} rejected, ${s.cancelled || 0} cancelled, ${s.pending || 0} pending)`}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 hidden md:table-cell">{fmtDate(p.created_at)}</td>
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

function CustomerDetail({ session, customer, bookingStats, onBack, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(null); // 'hold' | 'deactivate' | null

  const [requests, setRequests] = useState([]);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [requestsError, setRequestsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRequestsLoading(true);
    sb(
      `/rest/v1/bookings?customer_id=eq.${customer.id}&select=id,event_date,status,total_amount,created_at,venues(name)&order=created_at.desc`,
      { token: session.token }
    )
      .then((rows) => !cancelled && setRequests(rows))
      .catch((e) => !cancelled && setRequestsError(e.message))
      .finally(() => !cancelled && setRequestsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [customer.id, session.token]);

  async function setAccountState(state, reason) {
    setBusy(true);
    setError("");
    try {
      const [row] = await sb(`/rest/v1/profiles?id=eq.${customer.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=representation",
        body: {
          account_state: state,
          state_reason: state === "active" ? null : reason || null,
          state_changed_at: nowIso(),
          state_changed_by: session.userId,
        },
      });
      setShowForm(null);
      onUpdated(row);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const bookingTotal = Object.values(bookingStats).reduce((a, n) => a + n, 0);

  return (
    <div>
      <button onClick={onBack} className="text-sm text-slate-500 mb-4">← Back to customers</button>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-2xl font-semibold">{customer.full_name || "Unnamed customer"}</h2>
          <p className="text-slate-500 text-sm">
            {[customer.phone, customer.email].filter(Boolean).join(" · ") || "—"} · Joined{" "}
            {fmtDate(customer.created_at)}
          </p>
        </div>
        <VenueStatePill state={customer.account_state || "active"} />
      </div>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Account control</h3>
        {customer.account_state && customer.account_state !== "active" && (
          <p className="text-sm text-slate-600 mb-3">
            Current reason: <span className="font-medium">{customer.state_reason || "—"}</span>
          </p>
        )}
        {showForm === "hold" ? (
          <StateReasonForm
            title="Put this account on hold — blocks new booking requests only"
            reasons={CUSTOMER_STATE_REASONS}
            confirmLabel="Confirm hold"
            tone="amber"
            busy={busy}
            onConfirm={(text) => setAccountState("on_hold", text)}
            onCancel={() => setShowForm(null)}
          />
        ) : showForm === "deactivate" ? (
          <StateReasonForm
            title="Deactivate this account — blocks new booking requests only"
            reasons={CUSTOMER_STATE_REASONS}
            confirmLabel="Confirm deactivation"
            tone="rose"
            busy={busy}
            onConfirm={(text) => setAccountState("deactivated", text)}
            onCancel={() => setShowForm(null)}
          />
        ) : (
          <div className="flex gap-2 flex-wrap">
            {customer.account_state && customer.account_state !== "active" && (
              <button
                disabled={busy}
                onClick={() => setAccountState("active", null)}
                className="bg-emerald-600 text-white text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Reactivate"}
              </button>
            )}
            {customer.account_state !== "on_hold" && (
              <button
                disabled={busy}
                onClick={() => setShowForm("hold")}
                className="bg-amber-100 text-amber-800 text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                Put on hold
              </button>
            )}
            {customer.account_state !== "deactivated" && (
              <button
                disabled={busy}
                onClick={() => setShowForm("deactivate")}
                className="bg-rose-100 text-rose-800 text-sm font-medium rounded px-4 py-2 disabled:opacity-50"
              >
                Deactivate
              </button>
            )}
          </div>
        )}
        <p className="text-xs text-slate-400 mt-3">
          Either state only blocks new booking requests — the customer can still log in, browse, and
          manage bookings they already have.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
        <h3 className="font-medium text-sm mb-2">Bookings ({bookingTotal} total)</h3>
        {bookingTotal === 0 ? (
          <p className="text-slate-400 text-sm">No bookings yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {BOOKING_STATUS_ORDER.filter((s) => bookingStats[s]).map((s) => (
              <div
                key={s}
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2"
              >
                <BookingStatusPill status={s} />
                <span className="text-sm font-semibold">{bookingStats[s]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="font-medium text-sm mb-2">Request details</h3>
        {requestsError && <p className="text-rose-600 text-sm mb-2">{requestsError}</p>}
        {requestsLoading ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : requests.length === 0 ? (
          <p className="text-slate-400 text-sm">No booking requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-3 py-2">Venue</th>
                  <th className="text-left px-3 py-2">Event date</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Amount</th>
                  <th className="text-left px-3 py-2">Requested</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{r.venues?.name || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{fmtDate(r.event_date)}</td>
                    <td className="px-3 py-2">
                      <BookingStatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-right">{inr(r.total_amount)}</td>
                    <td className="px-3 py-2 text-slate-600">{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Admin-owned master catalog of add-on types (Mic, Photographer, ...) that
// partners pick from. Partner-side custom-item requests are frozen for MVP —
// this catalog is the only source of add-ons a partner can offer.
function AddonsAdmin({ session }) {
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [showCatalogForm, setShowCatalogForm] = useState(false);
  const [catalogForm, setCatalogForm] = useState(null);
  const [editingCatalogId, setEditingCatalogId] = useState(null);
  const [catalogSaving, setCatalogSaving] = useState(false);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const data = await sb("/rest/v1/addon_catalog?select=*&order=name.asc", { token: session.token });
      setCatalog(data);
    } catch (e) {
      setCatalogError(e.message);
    } finally {
      setCatalogLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  function openNewCatalogForm() {
    setCatalogForm({ name: "", description: "", is_active: true });
    setEditingCatalogId(null);
    setCatalogError("");
    setShowCatalogForm(true);
  }
  function openEditCatalogForm(entry) {
    setCatalogForm({
      name: entry.name || "",
      description: entry.description || "",
      is_active: entry.is_active ?? true,
    });
    setEditingCatalogId(entry.id);
    setCatalogError("");
    setShowCatalogForm(true);
  }
  function closeCatalogForm() {
    setShowCatalogForm(false);
    setCatalogError("");
  }

  async function saveCatalogEntry(e) {
    e.preventDefault();
    setCatalogError("");
    if (!catalogForm.name.trim()) {
      setCatalogError("Enter a name.");
      return;
    }
    setCatalogSaving(true);
    try {
      const body = {
        name: catalogForm.name.trim(),
        description: catalogForm.description.trim() || null,
        is_active: !!catalogForm.is_active,
      };
      if (editingCatalogId) {
        await sb(`/rest/v1/addon_catalog?id=eq.${editingCatalogId}`, {
          method: "PATCH",
          token: session.token,
          prefer: "return=minimal",
          body,
        });
      } else {
        await sb("/rest/v1/addon_catalog", {
          method: "POST",
          token: session.token,
          prefer: "return=minimal",
          body,
        });
      }
      setShowCatalogForm(false);
      await loadCatalog();
    } catch (err) {
      setCatalogError(err.message);
    } finally {
      setCatalogSaving(false);
    }
  }

  async function toggleCatalogActive(entry) {
    setCatalogError("");
    try {
      await sb(`/rest/v1/addon_catalog?id=eq.${entry.id}`, {
        method: "PATCH",
        token: session.token,
        prefer: "return=minimal",
        body: { is_active: !entry.is_active },
      });
      await loadCatalog();
    } catch (e) {
      setCatalogError(e.message);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Add-Ons</h1>
      <p className="text-sm text-slate-500 mb-6">
        The master catalog partners pick which of these to offer at their venue.
      </p>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-medium">Master catalog</h2>
          {!showCatalogForm && (
            <button
              type="button"
              onClick={openNewCatalogForm}
              className="bg-slate-900 text-white text-xs font-medium px-3 py-1.5 rounded"
            >
              + Add item
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          What partners can pick from. Deactivating hides it from the picker without removing it from
          venues that already added it.
        </p>

        {catalogError && !showCatalogForm && <p className="text-rose-600 text-xs mb-2">{catalogError}</p>}

        {showCatalogForm && catalogForm && (
          <form
            onSubmit={saveCatalogEntry}
            className="border border-slate-200 rounded-lg p-4 flex flex-col gap-3 mb-4"
          >
            <h3 className="font-medium text-sm">{editingCatalogId ? "Edit item" : "New item"}</h3>
            <div>
              <label className="text-xs font-medium block mb-1">Name</label>
              <input
                type="text"
                required
                className="border border-slate-300 rounded px-3 py-2 text-sm w-full"
                value={catalogForm.name}
                onChange={(e) => setCatalogForm({ ...catalogForm, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1">Description</label>
              <textarea
                rows={2}
                className="border border-slate-300 rounded px-3 py-2 text-sm w-full"
                value={catalogForm.description}
                onChange={(e) => setCatalogForm({ ...catalogForm, description: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={catalogForm.is_active}
                onChange={(e) => setCatalogForm({ ...catalogForm, is_active: e.target.checked })}
              />
              Active (visible to partners)
            </label>
            {catalogError && <p className="text-rose-600 text-sm">{catalogError}</p>}
            <div className="flex gap-3">
              <button
                disabled={catalogSaving}
                className="bg-slate-900 text-white text-sm font-medium px-4 py-2 rounded disabled:opacity-50"
              >
                {catalogSaving ? "Saving…" : editingCatalogId ? "Save changes" : "Add"}
              </button>
              <button type="button" className="text-sm text-slate-500" onClick={closeCatalogForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {catalogLoading ? (
          <p className="text-slate-400 text-sm">Loading…</p>
        ) : (
          <div className="flex flex-col gap-2">
            {catalog.map((c) => (
              <div
                key={c.id}
                className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-100 last:border-b-0 text-sm"
              >
                <div>
                  <span className="font-medium">{c.name}</span>
                  <span
                    className={`ml-2 text-[11px] font-medium px-2 py-0.5 rounded-full ${
                      c.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {c.is_active ? "Active" : "Inactive"}
                  </span>
                  {c.description && <p className="text-slate-500 text-xs mt-0.5">{c.description}</p>}
                </div>
                <div className="flex gap-3 shrink-0">
                  <button type="button" className="text-xs text-slate-600" onClick={() => openEditCatalogForm(c)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`text-xs ${c.is_active ? "text-rose-600" : "text-emerald-600 font-medium"}`}
                    onClick={() => toggleCatalogActive(c)}
                  >
                    {c.is_active ? "Deactivate" : "Activate"}
                  </button>
                </div>
              </div>
            ))}
            {catalog.length === 0 && <p className="text-slate-400 text-sm">No catalog items yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// Every booking request end-to-end — read-only, no PATCH here — so an analyst
// can see who requested what from whom and what happened next, without
// touching booking state. bookings_select_for_admin already grants this.
function Requests({ session }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await sb(
        "/rest/v1/bookings?select=id,booking_ref,event_date,headcount,status,requested_at,responded_at," +
          "response_deadline,is_last_minute,total_amount,deposit_tier,deposit_amount,contact_name,contact_mobile," +
          "contact_email,rejection_reason,cancellation_reason,cancelled_at,menu_finalized_at," +
          "checkin_otp_generated_at,event_started_at,partner_disclosure_note,disclosure_response,occasion_other," +
          "special_request,venues(name),venue_packages(name)," +
          "booking_addon_requests(id,addon_name,addon_description,status,price,partner_notes)" +
          "&order=requested_at.desc",
        { token: session.token }
      );
      setRows(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = rows.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1;
    return a;
  }, {});
  const visible = rows.filter((r) => tab === "all" || r.status === tab);
  const selected = rows.find((r) => r.id === selectedId) || null;

  if (selected) {
    return <RequestDetail booking={selected} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Requests</h1>
      <p className="text-sm text-slate-500 mb-4">
        Every booking request between customers and partners — {rows.length} total.
      </p>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      <div className="flex flex-wrap gap-2 mb-4">
        {REQUEST_TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`text-sm px-3 py-1.5 rounded-full border ${
              tab === key ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"
            }`}
          >
            {label}
            {key !== "all" && counts[key] ? ` (${counts[key]})` : ""}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-slate-400 text-sm">No requests in this view.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Customer</th>
                <th className="text-left px-4 py-2">Venue</th>
                <th className="text-left px-4 py-2 hidden md:table-cell">Package</th>
                <th className="text-left px-4 py-2">Event date</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2 hidden lg:table-cell">Requested</th>
                <th className="text-left px-4 py-2 hidden lg:table-cell">Responded</th>
                <th className="text-right px-4 py-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setSelectedId(b.id)}
                  className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{b.contact_name || "—"}</span>
                    <span className="block text-xs text-slate-400">{b.contact_mobile || ""}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{b.venues?.name || "—"}</td>
                  <td className="px-4 py-2.5 hidden md:table-cell text-slate-600">
                    {b.venue_packages?.name || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{fmtDate(b.event_date)}</td>
                  <td className="px-4 py-2.5">
                    <BookingStatusPill status={b.status} />
                  </td>
                  <td className="px-4 py-2.5 hidden lg:table-cell text-slate-600">
                    {fmtDateTime(b.requested_at)}
                  </td>
                  <td className="px-4 py-2.5 hidden lg:table-cell text-slate-600">
                    {fmtDateTime(b.responded_at)}
                  </td>
                  <td className="px-4 py-2.5 text-right">{inr(b.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Read-only platform overview. Every figure is pulled live with the admin token,
// same as Onboarding/Settlements — no aggregation is pushed to the DB, sums are
// done client-side over the raw rows (matching the Settlements approach).
function Dashboard({ session, venues, onGoToOnboarding }) {
  const [bookings, setBookings] = useState([]);
  const [payments, setPayments] = useState([]);
  const [customerCount, setCustomerCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [bk, pm, prof] = await Promise.all([
        sb(
          "/rest/v1/bookings?select=id,total_amount,status,event_date,contact_name,created_at,venues(name)&order=created_at.desc",
          { token: session.token }
        ),
        sb(
          "/rest/v1/payments?status=eq.paid&select=amount,platform_fee_amount,partner_payout_amount,settlement_status",
          { token: session.token }
        ),
        sb("/rest/v1/profiles?select=id", { token: session.token }),
      ]);
      setBookings(bk);
      setPayments(pm);
      setCustomerCount(prof.length);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  const sum = (arr, pick) => arr.reduce((s, x) => s + Number(pick(x) || 0), 0);
  const gmv = sum(
    bookings.filter((b) => !["cancelled", "rejected"].includes(b.status)),
    (b) => b.total_amount
  );
  const platformRevenue = sum(payments, (p) => p.platform_fee_amount);
  const depositsCollected = sum(payments, (p) => p.amount);
  const pendingPayouts = sum(
    payments.filter((p) => p.settlement_status === "pending"),
    (p) => p.partner_payout_amount
  );

  const bookingCounts = bookings.reduce((a, b) => {
    a[b.status] = (a[b.status] || 0) + 1;
    return a;
  }, {});
  const venueCounts = (venues || []).reduce((a, v) => {
    a[v.status] = (a[v.status] || 0) + 1;
    return a;
  }, {});
  const pendingReview = (venueCounts.submitted || 0) + (venueCounts.under_review || 0);
  const recent = bookings.slice(0, 10);

  const kpis = [
    ["GMV", gmv],
    ["Platform Revenue", platformRevenue],
    ["Deposits Collected", depositsCollected],
    ["Pending Payouts", pendingPayouts],
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
      <p className="text-sm text-slate-500 mb-4">Live platform overview.</p>

      {error && <p className="text-rose-600 text-sm mb-3">{error}</p>}

      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {kpis.map(([label, val]) => (
              <div key={label} className="bg-white border border-slate-200 rounded-lg p-4">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-xl font-semibold mt-1">{inr(val)}</p>
              </div>
            ))}
          </div>

          <div>
            <h2 className="text-sm font-medium text-slate-700 mb-2">Bookings by status</h2>
            {BOOKING_STATUS_ORDER.some((s) => bookingCounts[s]) ? (
              <div className="flex flex-wrap gap-2">
                {BOOKING_STATUS_ORDER.filter((s) => bookingCounts[s]).map((s) => (
                  <div
                    key={s}
                    className="bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2"
                  >
                    <BookingStatusPill status={s} />
                    <span className="text-sm font-semibold">{bookingCounts[s]}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-sm">No bookings yet.</p>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">Partners</p>
              <p className="text-xl font-semibold mt-1">
                {(venues || []).length}{" "}
                <span className="text-sm font-normal text-slate-400">venues</span>
              </p>
              <div className="mt-3 flex flex-col gap-1 text-sm">
                {["submitted", "under_review", "approved", "rejected"].map((s) => (
                  <div key={s} className="flex justify-between">
                    <span className="text-slate-500">{VENUE_STATUS_LABELS[s]}</span>
                    <span className="font-medium">{venueCounts[s] || 0}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={onGoToOnboarding}
                className="mt-3 text-sm text-teal-700 underline hover:text-teal-900"
              >
                {pendingReview} pending review →
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">Customers</p>
              <p className="text-xl font-semibold mt-1">{customerCount ?? "—"}</p>
              <p className="text-sm text-slate-400 mt-1">Registered customer profiles</p>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-medium text-slate-700 mb-2">Recent bookings</h2>
            {recent.length === 0 ? (
              <p className="text-slate-400 text-sm">No bookings yet.</p>
            ) : (
              <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="text-left px-4 py-2">Venue</th>
                      <th className="text-left px-4 py-2">Customer</th>
                      <th className="text-left px-4 py-2">Event date</th>
                      <th className="text-left px-4 py-2">Status</th>
                      <th className="text-right px-4 py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((b) => (
                      <tr key={b.id} className="border-t border-slate-100">
                        <td className="px-4 py-2.5 font-medium">{b.venues?.name || "—"}</td>
                        <td className="px-4 py-2.5 text-slate-600">{b.contact_name || "—"}</td>
                        <td className="px-4 py-2.5 text-slate-600">{fmtDate(b.event_date)}</td>
                        <td className="px-4 py-2.5">
                          <BookingStatusPill status={b.status} />
                        </td>
                        <td className="px-4 py-2.5 text-right">{inr(b.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminApp() {
  const [session, setSession] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [checking, setChecking] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [section, setSection] = useState("dashboard"); // 'dashboard' | 'onboarding' | 'partners' | 'customers' | 'requests' | 'addons' | 'settlements'
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("submitted");
  const [selectedId, setSelectedId] = useState(null);
  const [venueSearch, setVenueSearch] = useState("");

  const loadVenues = useCallback(async (token) => {
    setLoading(true);
    try {
      // updated_at is trigger-maintained on every venue update, so rejected
      // venues that a partner edits/resubmits float back to the top.
      const rows = await sb(
        "/rest/v1/venues?select=*,partner_users(full_name,phone)&order=updated_at.desc.nullslast,created_at.desc",
        { token }
      );
      setVenues(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session && admin) loadVenues(session.token);
  }, [session, admin, loadVenues]);

  async function handleLogin(e) {
    e.preventDefault();
    setAuthError("");
    setChecking(true);
    try {
      const s = await signIn(email, password);
      const row = await fetchAdminRow(s.token, s.userId);
      if (!row) {
        setAuthError("Not authorized as admin.");
        setSession(null);
        setAdmin(null);
        return;
      }
      setSession(s);
      setAdmin(row);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setChecking(false);
    }
  }

  function logout() {
    setSession(null);
    setAdmin(null);
    setSelectedId(null);
    setEmail("");
    setPassword("");
  }

  if (!session || !admin) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center px-6">
        <div className="w-full max-w-sm bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
          <div className="flex items-baseline gap-2 mb-6">
            <span className="font-black text-xl text-slate-900">PAXO</span>
            <span className="text-xs uppercase tracking-widest text-slate-500">Admin</span>
          </div>
          <h1 className="text-lg font-semibold mb-1">Admin sign in</h1>
          <p className="text-sm text-slate-500 mb-4">Restricted to PAXO review staff.</p>
          <form onSubmit={handleLogin} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder="Email"
              className="border border-slate-300 rounded px-3 py-2 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              type="password"
              required
              placeholder="Password"
              className="border border-slate-300 rounded px-3 py-2 text-sm"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {authError && <p className="text-rose-600 text-sm">{authError}</p>}
            <button
              disabled={checking}
              className="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {checking ? "Checking…" : "Sign in"}
            </button>
          </form>
          <a href="/" className="block text-center text-xs text-slate-400 mt-4 hover:text-slate-600">
            ← Back to partner app
          </a>
        </div>
      </div>
    );
  }

  const counts = venues.reduce((acc, v) => {
    acc[v.status] = (acc[v.status] || 0) + 1;
    return acc;
  }, {});
  const searchQuery = venueSearch.trim().toLowerCase();
  const list = venues.filter((v) => {
    if (tab !== "all" && v.status !== tab) return false;
    if (!searchQuery) return true;
    return [v.name, v.city, v.area, v.owner_name, v.venue_type, v.contact_person_name, v.contact_phone]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(searchQuery));
  });
  const selected = venues.find((v) => v.id === selectedId) || null;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-slate-900 text-white print:hidden">
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-black text-lg">PAXO</span>
            <span className="text-xs uppercase tracking-widest text-slate-400">Admin</span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-300 hidden sm:inline">{admin.full_name || session.email}</span>
            <button onClick={logout} className="text-slate-300 hover:text-white">Log out</button>
          </div>
        </div>
      </header>

      <nav className="bg-white border-b border-slate-200 print:hidden">
        <div className="max-w-5xl mx-auto px-5 flex gap-1">
          {[
            ["dashboard", "Dashboard"],
            ["onboarding", "Onboarding"],
            ["partners", "Partners"],
            ["customers", "Customers"],
            ["requests", "Requests"],
            ["addons", "Add-Ons"],
            ["settlements", "Settlements"],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => {
                setSection(key);
                setSelectedId(null);
              }}
              className={`text-sm px-3 py-3 border-b-2 -mb-px ${
                section === key
                  ? "border-slate-900 text-slate-900 font-medium"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-5 py-6">
        {section === "dashboard" ? (
          <Dashboard
            session={session}
            venues={venues}
            onGoToOnboarding={() => {
              setSection("onboarding");
              setTab("submitted");
              setSelectedId(null);
            }}
          />
        ) : section === "partners" ? (
          <PartnersAdmin session={session} />
        ) : section === "customers" ? (
          <CustomersAdmin session={session} />
        ) : section === "requests" ? (
          <Requests session={session} />
        ) : section === "addons" ? (
          <AddonsAdmin session={session} />
        ) : section === "settlements" ? (
          <Settlements session={session} />
        ) : selected ? (
          <VenueDetail
            session={session}
            venue={selected}
            onBack={() => setSelectedId(null)}
            onUpdated={(row) => {
              setVenues((vs) => vs.map((v) => (v.id === row.id ? { ...v, ...row } : v)));
            }}
          />
        ) : (
          <>
            <h1 className="text-2xl font-semibold mb-1">Venue review queue</h1>
            <p className="text-sm text-slate-500 mb-4">
              {venues.length} venue{venues.length === 1 ? "" : "s"} total
            </p>
            <input
              type="text"
              value={venueSearch}
              onChange={(e) => setVenueSearch(e.target.value)}
              placeholder="Search by venue, city, area, owner, or contact…"
              className="border border-slate-300 rounded px-3 py-1.5 text-sm w-full sm:w-80 mb-3"
            />
            <div className="flex flex-wrap gap-2 mb-4">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`text-sm px-3 py-1.5 rounded-full border ${
                    tab === key ? "bg-slate-900 text-white border-slate-900" : "border-slate-300 text-slate-600"
                  }`}
                >
                  {label}
                  {key !== "all" && counts[key] ? ` (${counts[key]})` : ""}
                </button>
              ))}
            </div>

            {loading ? (
              <p className="text-slate-400 text-sm">Loading…</p>
            ) : list.length === 0 ? (
              <p className="text-slate-400 text-sm">No venues in this view.</p>
            ) : (
              <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="text-left px-4 py-2">Venue</th>
                      <th className="text-left px-4 py-2 hidden sm:table-cell">Owner</th>
                      <th className="text-left px-4 py-2 hidden md:table-cell">City</th>
                      <th className="text-left px-4 py-2 hidden md:table-cell">Submitted</th>
                      <th className="text-left px-4 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((v) => (
                      <tr
                        key={v.id}
                        onClick={() => setSelectedId(v.id)}
                        className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      >
                        <td className="px-4 py-2.5 font-medium">{v.name}</td>
                        <td className="px-4 py-2.5 hidden sm:table-cell text-slate-600">{v.owner_name || "—"}</td>
                        <td className="px-4 py-2.5 hidden md:table-cell text-slate-600">{v.city}</td>
                        <td className="px-4 py-2.5 hidden md:table-cell text-slate-600">{fmtDate(v.submitted_at)}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={v.status} verified={v.is_verified} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="max-w-5xl mx-auto px-5 pb-8 pt-2 flex items-center gap-3 print:hidden">
        <span className="text-xs text-slate-400">Paxo</span>
        <SocialLinks linkClass="text-slate-400 hover:text-slate-600" />
      </footer>
    </div>
  );
}

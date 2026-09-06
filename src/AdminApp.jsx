import { useState, useEffect, useCallback } from "react";
import { sb, signIn, fetchAdminRow, signedDocumentUrl } from "./supabase";
import { REJECTION_REASONS, VENUE_STATUS_LABELS } from "./onboarding";

const TABS = [
  ["submitted", "Submitted"],
  ["under_review", "Under Review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

const nowIso = () => new Date().toISOString();
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

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

function DocLink({ session, path, label }) {
  const [state, setState] = useState("idle"); // idle | loading | error
  const [err, setErr] = useState("");
  if (!path) return <span className="text-stone-400">{label}: not provided</span>;
  async function open() {
    setState("loading");
    setErr("");
    try {
      const url = await signedDocumentUrl(session.token, path);
      window.open(url, "_blank", "noopener");
      setState("idle");
    } catch (e) {
      setState("error");
      setErr(e.message || "Couldn't open document");
    }
  }
  return (
    <span className="flex flex-col">
      <button onClick={open} className="text-teal-700 underline text-left w-fit">
        {label}: {state === "loading" ? "opening…" : "view document"}
      </button>
      {state === "error" && <span className="text-xs text-rose-600">{err}</span>}
    </span>
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

function VenueDetail({ session, venue, onBack, onUpdated }) {
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  const approveStage1 = () => patch({ status: "under_review", reviewed_at: nowIso() }, "approve_stage1");
  const reject = (text) =>
    patch({ status: "rejected", rejection_note: text, reviewed_at: nowIso() }, "reject", text);
  const approveVerified = () =>
    patch({ status: "approved", is_verified: true, approved_at: nowIso(), reviewed_at: nowIso() }, "approve_verified");
  const approvePlain = () =>
    patch({ status: "approved", is_verified: false, approved_at: nowIso(), reviewed_at: nowIso() }, "approve_unverified");

  const hasGst = !!venue.gst_no;
  const canVerify = hasGst && !!venue.liquor_license_url && !!venue.fssai_license_url;
  const partner = venue.partner_users?.[0];

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
            <DocLink session={session} path={venue.gst_document_url} label="GST document" />
            <DocLink session={session} path={venue.liquor_license_url} label="Liquor license" />
            <DocLink session={session} path={venue.fssai_license_url} label="FSSAI license" />
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

  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("submitted");
  const [selectedId, setSelectedId] = useState(null);

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
  const list = venues.filter((v) => tab === "all" || v.status === tab);
  const selected = venues.find((v) => v.id === selectedId) || null;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="bg-slate-900 text-white">
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

      <main className="max-w-5xl mx-auto px-5 py-6">
        {selected ? (
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
    </div>
  );
}

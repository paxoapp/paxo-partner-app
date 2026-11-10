import { useState, useEffect, useCallback } from "react";
import { sb, SUPABASE_URL, ANON_KEY } from "./supabase";

// Admin side of the "accept the Partner Agreement by email link" flow: a status badge, the Send / Resend box, and the
// signed-PDF download. Everything that creates a link, sends an email or hands out a PDF goes through the admin-only
// edge function admin-agreement-invite; this file never sees a token.

async function callFn(token, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-agreement-invite`, {
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
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// Same rule as the server (the server decides; this only saves a round trip).
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
export const isEmail = (v) => v.length <= 200 && !v.includes("..") && EMAIL_RE.test(v);
export const isPlaceholderEmail = (v) => /^paxoapp\.in/i.test(v.split("@")[0] || "") || /@mypaxo\.in$/i.test(v);

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "");

export const acceptanceText = (row) =>
  `Agreement accepted on ${fmtDate(row.accepted_at)} by ${row.accepted_by_name || (row.accepted_via === "email_link" ? "the venue" : "the venue (in the app)")}`;

// All venues' final agreements, for list badges. Admin-only by row-level security.
export function useAgreementMap(token, reloadKey) {
  const [map, setMap] = useState({});
  useEffect(() => {
    let off = false;
    sb("/rest/v1/agreement_acceptances?checkpoint=eq.final_agreement&select=venue_id,accepted_at,accepted_by_name,accepted_via&order=accepted_at.desc&limit=5000", { token })
      .then((rows) => {
        if (off) return;
        const m = {};
        for (const r of rows || []) if (!m[r.venue_id]) m[r.venue_id] = r;
        setMap(m);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [token, reloadKey]);
  return map;
}

export function AgreementBadge({ row }) {
  return row ? (
    <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium" data-testid="agreement-badge-accepted" title={acceptanceText(row)}>
      Agreement accepted · {fmtDate(row.accepted_at)}
    </span>
  ) : (
    <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium" data-testid="agreement-badge-missing">
      Not accepted
    </span>
  );
}

function SendBox({ session, venue, resend, onClose, onSent }) {
  const [name, setName] = useState(venue.owner_name || "");
  const [email, setEmail] = useState(venue.owner_contact_email || "");
  const [step, setStep] = useState("edit"); // 'edit' | 'confirm'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  function next() {
    if (cleanName.length < 2) return setError("Enter the owner's name.");
    if (!isEmail(cleanEmail)) return setError('Enter a valid email: letters, digits and . _ + - only, no spaces, no "mailto:".');
    if (isPlaceholderEmail(cleanEmail)) return setError("That is a PAXO placeholder address. Enter the owner's own email.");
    setError("");
    setStep("confirm");
  }
  async function send() {
    setBusy(true);
    setError("");
    try {
      const r = await callFn(session.token, { action: "send", venue_id: venue.id, name: cleanName, email: cleanEmail, origin: window.location.origin });
      onSent(r);
    } catch (e) {
      setError(e.message);
      setStep("edit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-amber-300 bg-amber-50 rounded-lg p-4 mt-3 text-left" data-testid="agreement-send-box">
      <p className="font-semibold text-sm">{resend ? "Resend" : "Send"} agreement link — {venue.name}</p>
      {step === "edit" ? (
        <>
          <p className="text-xs text-slate-600 mt-1">
            The owner gets an email with a personal link (valid 14 days, works once). No login is needed. {resend ? "Sending again cancels the earlier link." : ""}
          </p>
          <label className="block text-sm mt-3">
            <span className="block mb-1">Owner's name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 bg-white" data-testid="agreement-name" />
          </label>
          <label className="block text-sm mt-3">
            <span className="block mb-1">Owner's email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 bg-white" data-testid="agreement-email" />
          </label>
          {error && <p className="text-sm text-red-600 mt-2" data-testid="agreement-error">{error}</p>}
          <div className="flex gap-3 mt-3">
            <button onClick={next} disabled={!cleanName || !cleanEmail} className="bg-slate-900 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50" data-testid="agreement-continue">
              Continue
            </button>
            <button onClick={onClose} className="text-sm text-slate-500">Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm mt-2">
            Email the Partner Agreement link for <strong>{venue.name}</strong> to <strong>{cleanName}</strong> at <strong>{cleanEmail}</strong>?
          </p>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex gap-3 mt-3">
            <button disabled={busy} onClick={send} className="bg-amber-600 text-white rounded px-3 py-1.5 text-sm disabled:opacity-50" data-testid="agreement-send">
              {busy ? "Sending…" : "Yes, send the link"}
            </button>
            <button disabled={busy} onClick={() => setStep("edit")} className="text-sm text-slate-500">Back</button>
          </div>
        </>
      )}
    </div>
  );
}

// compact = the Managed venues card; otherwise the venue detail page.
export function AgreementPanel({ session, venue, compact }) {
  const [row, setRow] = useState(undefined); // undefined = loading, null = none
  const [last, setLast] = useState(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await sb(`/rest/v1/agreement_acceptances?venue_id=eq.${venue.id}&checkpoint=eq.final_agreement&select=id,accepted_at,accepted_by_name,accepted_by_designation,accepted_via&order=accepted_at.desc&limit=1`, { token: session.token });
      const r = rows?.[0] || null;
      setRow(r);
      if (!r) {
        const info = await callFn(session.token, { action: "info", venue_id: venue.id }).catch(() => ({}));
        setLast(info.last_invite || null);
      }
    } catch (e) {
      setRow(null);
      setError(e.message);
    }
  }, [venue.id, session.token]);
  useEffect(() => {
    load();
  }, [load]);

  async function downloadPdf() {
    setPdfBusy(true);
    setError("");
    try {
      const r = await callFn(session.token, { action: "pdf", venue_id: venue.id });
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setError(e.message);
    } finally {
      setPdfBusy(false);
    }
  }

  if (row === undefined) return <p className="text-xs text-slate-400 mt-2">Checking agreement…</p>;
  const wrapCls = compact ? "mt-3 border-t border-slate-100 pt-3" : "bg-white border border-stone-200 rounded-lg p-4 mb-4";
  const linkUsable = last && !last.used_at && new Date(last.expires_at) > new Date();

  return (
    <div className={wrapCls} data-testid="agreement-panel">
      {!compact && <h3 className="font-medium text-sm mb-2">Partner Agreement</h3>}
      {notice && <p className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-3 py-2 mb-2" data-testid="agreement-notice">{notice}</p>}
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {row ? (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-1.5" data-testid="agreement-accepted-text">
            {acceptanceText(row)}
            {row.accepted_by_designation ? ` (${row.accepted_by_designation})` : ""}
          </p>
          {row.accepted_via === "email_link" && (
            <button disabled={pdfBusy} onClick={downloadPdf} className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50" data-testid="agreement-pdf">
              {pdfBusy ? "Preparing…" : "Download agreement PDF"}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <AgreementBadge row={null} />
              {last && (
                <p className="text-xs text-slate-500 mt-1" data-testid="agreement-last">
                  Link sent {fmtDateTime(last.created_at)} to {last.sent_to_email} · {linkUsable ? `valid until ${fmtDate(last.expires_at)}` : last.used_at ? "used" : "expired"}
                </p>
              )}
            </div>
            <button onClick={() => setOpen(!open)} className="text-xs bg-slate-900 text-white rounded px-3 py-1.5" data-testid="agreement-open">
              {last ? "Resend link" : "Send agreement link"}
            </button>
          </div>
          {open && (
            <SendBox
              session={session}
              venue={venue}
              resend={!!last}
              onClose={() => setOpen(false)}
              onSent={(r) => {
                setOpen(false);
                setNotice(`Agreement link sent to ${r.sent_to}.`);
                load();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

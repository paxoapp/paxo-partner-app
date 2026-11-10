import { useState, useEffect } from "react";
import { SUPABASE_URL, ANON_KEY } from "./supabase";
import { PartnerAgreementBody, AGREEMENT_COUNTERPARTY, AGREEMENT_VERSION } from "./agreementText";

// Public page: partner.mypaxo.in/agreement/<token>. No login. The owner reads the agreement (the same text as the
// login-gate screen), types their name and designation, ticks the box and accepts. The token is checked and spent
// by the agreement-public edge function; this page only ever holds the token in memory.

async function call(body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/agreement-public`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
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
    const err = new Error(data.error || "Something went wrong. Please try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}

const inputCls = "bg-stone-900 border border-white/10 rounded-2xl px-4 py-3 text-sm placeholder-stone-500 text-white focus:outline-none focus:border-accent w-full";

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white px-6 py-10">
      <div className="max-w-md mx-auto w-full">
        <div className="flex items-baseline gap-2 mb-8">
          <span className="font-black text-2xl">Paxo</span>
          <span className="text-xs text-accent font-medium">Partner</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const PROBLEM = {
  invalid: ["This link is not valid", "Please check the link in your email, or ask PAXO to send a new one."],
  expired: ["This link has expired", "Links work for 14 days. Please ask PAXO to send you a new one at support@mypaxo.in."],
  used: ["This agreement has already been accepted", "There is nothing more to do. If you did not accept it, please write to support@mypaxo.in."],
};

export default function AgreementPage({ token }) {
  const [state, setState] = useState({ status: "loading" });
  const [name, setName] = useState("");
  const [designation, setDesignation] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.title = "PAXO Partner Agreement";
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    const ref = document.createElement("meta");
    ref.name = "referrer";
    ref.content = "no-referrer";
    document.head.append(meta, ref);
    return () => {
      meta.remove();
      ref.remove();
    };
  }, []);

  useEffect(() => {
    let off = false;
    call({ action: "check", token })
      .then((d) => !off && setState(d))
      .catch((e) => !off && setState({ status: "error", message: e.message }));
    return () => {
      off = true;
    };
  }, [token]);

  async function accept() {
    setError("");
    setSaving(true);
    try {
      const r = await call({ action: "accept", token, name: name.trim(), designation: designation.trim(), confirm: true });
      setState({ status: "done", ...r });
    } catch (e) {
      if (e.status === 404 || e.status === 410) {
        setState({ status: e.status === 404 ? "invalid" : /expired/.test(e.message) ? "expired" : "used" });
      } else {
        setError(e.message);
      }
    } finally {
      setSaving(false);
    }
  }

  if (state.status === "loading") {
    return (
      <Shell>
        <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin" /></div>
      </Shell>
    );
  }
  if (state.status === "error") {
    return (
      <Shell>
        <h1 className="text-2xl font-bold mb-2" data-testid="agreement-problem">Something went wrong</h1>
        <p className="text-sm text-stone-300">{state.message}</p>
      </Shell>
    );
  }
  if (PROBLEM[state.status]) {
    const [title, text] = PROBLEM[state.status];
    return (
      <Shell>
        <h1 className="text-2xl font-bold mb-2" data-testid="agreement-problem">{title}</h1>
        <p className="text-sm text-stone-300">{text}</p>
      </Shell>
    );
  }
  if (state.status === "done") {
    return (
      <Shell>
        <p className="text-xs font-medium text-emerald-400 mb-1">Done</p>
        <h1 className="text-2xl font-bold mb-3" data-testid="agreement-done">Thank you — agreement accepted</h1>
        <p className="text-sm text-stone-300">
          The PAXO Partner Agreement for <strong>{state.venue_name}</strong> has been accepted.
          {state.emailed
            ? <> A confirmation with a copy of the agreement has been emailed to <strong>{state.email}</strong>.</>
            : <> We could not send the confirmation email just now; PAXO has your acceptance on record and will send you a copy.</>}
        </p>
        <p className="text-sm text-stone-400 mt-4">You can close this page.</p>
      </Shell>
    );
  }

  const venue = state.venue_name;
  const canSubmit = name.trim().length >= 2 && designation.trim().length >= 2 && agreed && !saving;
  return (
    <Shell>
      <div className="mb-5">
        <p className="text-xs font-medium text-stone-500 mb-1">Version {AGREEMENT_VERSION}</p>
        <h1 className="text-2xl font-bold">PAXO Partner Agreement</h1>
        <p className="text-sm text-stone-300 mt-2" data-testid="agreement-parties">
          Between <strong>{AGREEMENT_COUNTERPARTY}</strong> and <strong data-testid="agreement-venue">{venue}</strong>.
        </p>
      </div>

      <div className="border border-stone-800 bg-stone-900/60 rounded-2xl p-5 mb-5 text-sm text-stone-300 space-y-3 max-h-96 overflow-y-auto" data-testid="agreement-text">
        <PartnerAgreementBody />
      </div>

      <div className="space-y-3 mb-4">
        <label className="block">
          <span className="text-xs font-medium text-stone-300 mb-1 block">Your full name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" className={inputCls} data-testid="agreement-input-name" />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-stone-300 mb-1 block">Your designation</span>
          <input value={designation} onChange={(e) => setDesignation(e.target.value)} maxLength={120} placeholder="e.g. Owner, Director, Manager" className={inputCls} data-testid="agreement-input-designation" />
        </label>
      </div>

      <label className="flex items-start gap-2 text-xs text-stone-300 mb-4">
        <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="agreement-checkbox" />
        <span>I am authorised to accept this agreement on behalf of <strong>{venue}</strong> and I accept it.</span>
      </label>

      {error && <p className="text-rose-400 text-sm mb-3" data-testid="agreement-page-error">{error}</p>}

      <button onClick={accept} disabled={!canSubmit} className="w-full bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50" data-testid="agreement-accept">
        {saving ? "Saving…" : "Accept agreement"}
      </button>
      <p className="text-xs text-stone-500 mt-3">Your name, designation, email, the time, and your device and network address are recorded with your acceptance.</p>
    </Shell>
  );
}

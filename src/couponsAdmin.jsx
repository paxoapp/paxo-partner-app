import { useState, useEffect, useCallback } from "react";
import { sb, rpc } from "./supabase";

// Admin "Coupons" tab: the on/off switches, the budget cap, and every coupon, redemption and referral.
// Everything is read through admin-only database access and changed only through admin_set_coupon_settings.

const rs = (n) => `Rs ${Number(n || 0).toLocaleString("en-IN")}`;
const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }) : "—";

const STATUS_TONE = {
  active: "bg-emerald-100 text-emerald-800",
  reserved: "bg-sky-100 text-sky-800",
  used: "bg-stone-200 text-stone-700",
  expired: "bg-stone-100 text-stone-500",
  void: "bg-stone-100 text-stone-500",
  paid: "bg-sky-100 text-sky-800",
  completed: "bg-emerald-100 text-emerald-800",
  returned: "bg-amber-100 text-amber-800",
  forfeited: "bg-red-100 text-red-800",
  pending: "bg-sky-100 text-sky-800",
  capped: "bg-amber-100 text-amber-800",
};
const Pill = ({ s }) => <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_TONE[s] || "bg-stone-100 text-stone-600"}`}>{s}</span>;

function Switch({ label, help, on, busy, onToggle, testid }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-slate-100 last:border-0">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-slate-500 mt-0.5">{help}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        onClick={onToggle}
        data-testid={testid}
        className={`shrink-0 text-sm font-medium rounded-full px-4 py-1.5 min-w-[64px] disabled:opacity-50 ${
          on ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"
        }`}
      >
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );
}

export default function CouponsAdmin({ session }) {
  const [summary, setSummary] = useState(null);
  const [coupons, setCoupons] = useState([]);
  const [redemptions, setRedemptions] = useState([]);
  const [referrals, setReferrals] = useState([]);
  const [names, setNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [capInput, setCapInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const sum = await rpc(session.token, "admin_coupon_summary", {});
      setSummary(sum);
      setCapInput(sum.settings.budget_cap == null ? "" : String(sum.settings.budget_cap));
      const [c, r, f] = await Promise.all([
        sb("/rest/v1/coupons?select=*&order=created_at.desc&limit=300", { token: session.token }),
        sb("/rest/v1/coupon_redemptions?select=*&order=created_at.desc&limit=300", { token: session.token }),
        sb("/rest/v1/referrals?select=*&order=claimed_at.desc&limit=300", { token: session.token }),
      ]);
      setCoupons(c);
      setRedemptions(r);
      setReferrals(f);
      const ids = [...new Set([...c.map((x) => x.owner_id), ...f.flatMap((x) => [x.sharer_id, x.friend_id])])];
      if (ids.length) {
        const profs = await sb(`/rest/v1/profiles?select=id,email,full_name&id=in.(${ids.join(",")})`, { token: session.token });
        setNames(Object.fromEntries(profs.map((p) => [p.id, p.full_name ? `${p.full_name} (${p.email})` : p.email])));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [session.token]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(args) {
    setBusy(true);
    setError("");
    try {
      const next = await rpc(session.token, "admin_set_coupon_settings", {
        p_offers_enabled: null,
        p_redemptions_enabled: null,
        p_budget_cap: null,
        p_clear_cap: false,
        ...args,
      });
      setSummary(next);
      setCapInput(next.settings.budget_cap == null ? "" : String(next.settings.budget_cap));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function saveCap() {
    const n = Number(capInput);
    if (!Number.isFinite(n) || n < 0) return setError("Enter the budget cap in rupees, for example 50000.");
    save({ p_budget_cap: n });
  }

  if (loading && !summary) return <p className="text-slate-400 text-sm">Loading…</p>;
  const s = summary?.settings;
  const who = (id) => names[id] || (id ? id.slice(0, 8) : "—");
  const Th = ({ children }) => <th className="text-left px-3 py-2 font-medium">{children}</th>;

  return (
    <div data-testid="coupons-admin">
      <h1 className="text-2xl font-semibold mb-1">Coupons</h1>
      <p className="text-sm text-slate-500 mb-4">
        Welcome coupons and referral credits. PAXO pays for them: the venue always receives its full amount, and only the customer's
        deposit and PAXO's platform fee change.
      </p>

      {error && <p className="text-rose-600 text-sm mb-3" role="alert">{error}</p>}

      {s && !s.offers_enabled && (
        <div className="border border-rose-300 bg-rose-50 rounded-lg p-4 mb-4" data-testid="offers-off-banner">
          <p className="text-sm font-semibold text-rose-800">New coupons and referral credits are switched off</p>
          <p className="text-sm text-rose-800 mt-1">
            {s.capped_off_note || "They were switched off by an admin."}
            {s.capped_off_at ? ` (${fmtDate(s.capped_off_at)})` : ""}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            Coupons that were already issued keep working until they expire. To start issuing again, raise or remove the budget cap and switch
            the first option on.
          </p>
          <p className="text-xs text-slate-600 mt-1">
            Once the cap has switched the offers off, they stay off until an admin turns them on again, even if returned coupons later lower
            the committed total. A coupon that a customer forfeits by cancelling after paying is gone for good, so it no longer counts toward the cap.
          </p>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
          {[
            ["Committed so far", rs(summary.committed)],
            ["Budget cap", s.budget_cap == null ? "No cap set" : rs(s.budget_cap)],
            ["Welcome coupons issued", summary.issued_welcome],
            ["Referral credits issued", summary.issued_referral],
            ["Coupons active now", summary.active_coupons],
            ["Coupons used", summary.used_coupons],
          ].map(([k, v]) => (
            <div key={k} className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">{k}</p>
              <p className="text-xl font-semibold mt-1">{v}</p>
            </div>
          ))}
        </div>
      )}

      {s && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
          <h3 className="font-medium text-sm mb-1">Settings</h3>
          <Switch
            label="Issue new coupons and referral credits"
            help="Off: no new welcome coupons and no new referral credits. Coupons already issued keep working."
            on={s.offers_enabled}
            busy={busy}
            testid="switch-offers"
            onToggle={() => save({ p_offers_enabled: !s.offers_enabled })}
          />
          <Switch
            label="Allow issued coupons to be used"
            help="Emergency stop. Off: no coupon is applied at payment until you switch it back on."
            on={s.redemptions_enabled}
            busy={busy}
            testid="switch-redemptions"
            onToggle={() => save({ p_redemptions_enabled: !s.redemptions_enabled })}
          />
          <div className="pt-3">
            <label className="text-sm font-medium block mb-1">Budget cap (rupees)</label>
            <div className="flex flex-wrap gap-2 items-center">
              <input
                type="number"
                min="0"
                step="1"
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                placeholder="No cap"
                className="border border-slate-300 rounded px-3 py-2 text-sm w-40"
                data-testid="cap-input"
              />
              <button type="button" disabled={busy || capInput === ""} onClick={saveCap} className="bg-slate-900 text-white text-sm rounded px-4 py-2 disabled:opacity-50">
                Save cap
              </button>
              {s.budget_cap != null && (
                <button type="button" disabled={busy} onClick={() => save({ p_clear_cap: true })} className="text-sm underline text-slate-600">
                  Remove cap
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-1.5">
              When the total of all coupon discounts reaches the cap, new coupons and referral credits switch off automatically. They stay off until an admin turns them on again, even if returned coupons lower the committed total. A coupon that a customer forfeits by cancelling after paying is gone for good, so it no longer counts toward the cap.
              {s.budget_cap == null ? " No cap is set yet, so nothing switches off by itself." : ""}
            </p>
          </div>
        </div>
      )}

      <h3 className="font-medium text-sm mb-2">Coupons</h3>
      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto mb-5">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase"><tr><Th>Customer</Th><Th>Type</Th><Th>Status</Th><Th>Issued</Th><Th>Expires</Th></tr></thead>
          <tbody>
            {coupons.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-400">No coupons yet.</td></tr>}
            {coupons.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{who(c.owner_id)}</td>
                <td className="px-3 py-2">{c.type === "welcome" ? "Welcome" : `Referral ${rs(c.amount)}`}</td>
                <td className="px-3 py-2"><Pill s={c.status === "active" && new Date(c.expires_at) < new Date() ? "expired" : c.status} /></td>
                <td className="px-3 py-2">{fmtDate(c.issued_at)}</td>
                <td className="px-3 py-2">{fmtDate(c.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-medium text-sm mb-2">Where coupons were used</h3>
      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto mb-5">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase"><tr><Th>Booking</Th><Th>Discount</Th><Th>Status</Th><Th>Date</Th></tr></thead>
          <tbody>
            {redemptions.length === 0 && <tr><td colSpan={4} className="px-3 py-3 text-slate-400">None yet.</td></tr>}
            {redemptions.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-mono text-xs">{r.booking_id.slice(0, 8)}</td>
                <td className="px-3 py-2">{rs(r.discount)}</td>
                <td className="px-3 py-2"><Pill s={r.status} /></td>
                <td className="px-3 py-2">{fmtDate(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-medium text-sm mb-2">Referrals</h3>
      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase"><tr><Th>Shared by</Th><Th>Friend</Th><Th>Status</Th><Th>Reason</Th><Th>Joined</Th></tr></thead>
          <tbody>
            {referrals.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-400">No referrals yet.</td></tr>}
            {referrals.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{who(r.sharer_id)}</td>
                <td className="px-3 py-2">{who(r.friend_id)}</td>
                <td className="px-3 py-2"><Pill s={r.status} /></td>
                <td className="px-3 py-2 text-slate-500">{r.reason ? r.reason.replace(/_/g, " ") : "—"}</td>
                <td className="px-3 py-2">{fmtDate(r.claimed_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
import { rpc } from "./supabase";

// Admin "Menu voting" panel for one party: setup (categories, options, winners), live results, tie decisions, "Lock menu"
// and the final menu as plain text to copy to the venue. Everything goes through admin-only database functions that check
// admin_users themselves; guests only ever see aggregate bars and their own vote on the customer app.

export const MENU_CATEGORIES = [
  ["starter_veg", "Starters (Veg)"],
  ["starter_non_veg", "Starters (Non-veg)"],
  ["main_veg", "Main course (Veg)"],
  ["main_non_veg", "Main course (Non-veg)"],
  ["dessert", "Dessert"],
  ["drinks", "Drinks"],
];
export const CATEGORY_LABEL = Object.fromEntries(MENU_CATEGORIES);
const DRINK_EXCLUDED = ["starter_veg", "starter_non_veg", "main_veg", "main_non_veg", "dessert", "side"];
const kindOk = (cat, kind) => (cat === "drinks" ? !DRINK_EXCLUDED.includes(kind) : kind === cat);
const inputCls = "w-full border border-slate-300 rounded px-3 py-2 text-sm bg-white";

const toIstLocal = (iso) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600e3).toISOString().slice(0, 16) : "");
const fromIstLocal = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);
const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "");

// The final menu as clean text, ready to paste into WhatsApp or an email to the venue.
export function finalMenuText(party, venueName, final) {
  const lines = [`Party menu: ${party.title}`];
  if (venueName) lines.push(venueName);
  if (party.party_date) lines.push(fmtDay(party.party_date));
  for (const c of final || []) {
    lines.push("", CATEGORY_LABEL[c.category] || c.category);
    if (!c.items.length) lines.push("- No preference (venue's choice)");
    for (const it of c.items) lines.push(`- ${it}`);
  }
  return lines.join("\n");
}

function SetupCategory({ cat, label, state, items, disabled, onChange }) {
  const on = !!state;
  const [custom, setCustom] = useState("");
  const [pick, setPick] = useState("");
  const venueItems = items.filter((i) => kindOk(cat, i.category_kind));
  const used = new Set((state?.options || []).map((o) => o.label.toLowerCase()));
  const add = (opt) => {
    if (!opt.label.trim() || used.has(opt.label.trim().toLowerCase())) return;
    onChange({ ...state, options: [...state.options, { ...opt, label: opt.label.trim() }] });
  };
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-white" data-testid={`menu-setup-${cat}`}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={on} disabled={disabled} data-testid={`menu-enable-${cat}`} onChange={(e) => onChange(e.target.checked ? { category: cat, winners: 1, options: [] } : null)} />
        {label}
      </label>
      {on && (
        <div className="mt-3 flex flex-col gap-3">
          <label className="text-xs text-slate-600 flex items-center gap-2">
            How many winners are served
            <input type="number" min="1" max="10" className="border border-slate-300 rounded px-2 py-1 w-16 text-sm" value={state.winners} disabled={disabled}
              data-testid={`menu-winners-${cat}`} onChange={(e) => onChange({ ...state, winners: e.target.value })} />
          </label>
          <ul className="flex flex-wrap gap-2">
            {state.options.map((o, i) => (
              <li key={o.label} className="text-xs bg-slate-100 rounded-full pl-3 pr-1 py-1 flex items-center gap-1" data-testid={`menu-option-${cat}`}>
                {o.label}
                {!o.menu_item_id && <span className="text-slate-400">(custom)</span>}
                {!disabled && (
                  <button type="button" className="px-1.5 text-slate-500 hover:text-rose-600" aria-label={`Remove ${o.label}`}
                    onClick={() => onChange({ ...state, options: state.options.filter((_, j) => j !== i) })}>×</button>
                )}
              </li>
            ))}
            {state.options.length === 0 && <li className="text-xs text-slate-400">Add at least one option.</li>}
          </ul>
          {!disabled && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="flex gap-2">
                <select className={inputCls} value={pick} onChange={(e) => setPick(e.target.value)} data-testid={`menu-pick-${cat}`}>
                  <option value="">Add from the venue's menu…</option>
                  {venueItems.map((i) => (
                    <option key={i.item_id} value={i.item_id}>{i.name}{cat === "drinks" ? ` (${i.category_name})` : ""}</option>
                  ))}
                </select>
                <button type="button" className="px-3 rounded bg-slate-900 text-white text-sm" data-testid={`menu-pick-add-${cat}`}
                  onClick={() => {
                    const it = venueItems.find((i) => i.item_id === pick);
                    if (it) add({ menu_item_id: it.item_id, label: it.name });
                    setPick("");
                  }}>Add</button>
              </div>
              <div className="flex gap-2">
                <input className={inputCls} placeholder="Or type a custom option" value={custom} maxLength={120} onChange={(e) => setCustom(e.target.value)} data-testid={`menu-custom-${cat}`} />
                <button type="button" className="px-3 rounded bg-slate-900 text-white text-sm" data-testid={`menu-custom-add-${cat}`}
                  onClick={() => { add({ label: custom }); setCustom(""); }}>Add</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultCategory({ c, voting, locked, onPick, busy }) {
  const tied = c.options.filter((o) => o.in_tie);
  const [sel, setSel] = useState(() => c.options.filter((o) => o.picked).map((o) => o.id));
  const need = c.tie_slots;
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-white" data-testid={`menu-result-${c.category}`}>
      <p className="text-sm font-medium">{CATEGORY_LABEL[c.category]} <span className="text-xs text-slate-500 font-normal">· {c.winners} served · "Anything is fine": {c.anything_seats} seats</span></p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {c.options.map((o) => (
          <li key={o.id} className="text-xs">
            <div className="flex justify-between"><span className={o.winner ? "font-semibold text-emerald-700" : ""}>{o.label}{o.winner ? " ✓" : ""}{o.in_tie ? " (tied)" : ""}</span><span>{o.weight} seats · {o.pct}%</span></div>
            <div className="h-2 bg-slate-100 rounded"><div className={`h-2 rounded ${o.winner ? "bg-emerald-500" : "bg-slate-400"}`} style={{ width: `${Math.min(100, o.pct)}%` }} /></div>
          </li>
        ))}
      </ul>
      {need > 0 && voting.voting_closed && !locked && (
        <div className="mt-3 rounded bg-amber-50 border border-amber-200 p-3 text-sm" data-testid={`menu-tie-${c.category}`}>
          <p className="font-medium text-amber-900">Tie: choose {need} of {tied.length}</p>
          <div className="flex flex-col gap-1 mt-2">
            {tied.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={sel.includes(o.id)} onChange={() => toggle(o.id)} data-testid={`menu-tie-pick-${o.label}`} />
                {o.label} ({o.weight} seats)
              </label>
            ))}
          </div>
          <button type="button" disabled={busy || sel.length !== need} onClick={() => onPick(c.category, sel)} className="mt-2 bg-slate-900 text-white rounded px-3 py-1.5 text-xs disabled:opacity-50" data-testid={`menu-tie-save-${c.category}`}>Save decision</button>
        </div>
      )}
    </div>
  );
}

export default function PartyMenu({ session, party }) {
  const [items, setItems] = useState([]);
  const [setup, setSetup] = useState({}); // category -> { category, winners, options: [{menu_item_id?, label}] }
  const [closes, setCloses] = useState("");
  const [meta, setMeta] = useState(null); // effective_closes_at, locked_at
  const [results, setResults] = useState(null);
  const [final, setFinal] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, it] = await Promise.all([
        rpc(session.token, "party_admin_get_menu", { p_party_id: party.id }),
        rpc(session.token, "party_admin_menu_items", { p_party_id: party.id }),
      ]);
      setItems(it || []);
      setMeta(m);
      setCloses(toIstLocal(m.voting_closes_at));
      setSetup(Object.fromEntries((m.categories || []).map((c) => [c.category, { category: c.category, winners: c.winners, options: c.options.map((o) => ({ menu_item_id: o.menu_item_id, label: o.label })) }])));
      if ((m.categories || []).length) {
        setResults(await rpc(session.token, "party_admin_menu_results", { p_party_id: party.id }));
        setFinal(m.locked_at ? await rpc(session.token, "party_menu_final", { p_party_id: party.id }) : null);
      } else {
        setResults(null);
        setFinal(null);
      }
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [session.token, party.id]);
  useEffect(() => {
    load();
  }, [load]);

  const locked = !!meta?.locked_at;
  const dead = party.status === "cancelled" || party.status === "completed";

  async function run(fn, okMsg) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      const config = MENU_CATEGORIES.filter(([k]) => setup[k]).map(([k]) => ({
        category: k, winners: Number(setup[k].winners), options: setup[k].options.map((o) => ({ menu_item_id: o.menu_item_id || null, label: o.label })),
      }));
      await rpc(session.token, "party_admin_set_menu", { p_party_id: party.id, p_voting_closes_at: fromIstLocal(closes), p_config: config });
    }, "Menu vote saved.");
  const lock = () => {
    if (!window.confirm("Lock the menu? Voting and setup will be frozen and guests will see the final menu.")) return;
    run(() => rpc(session.token, "party_admin_lock_menu", { p_party_id: party.id }), "Menu locked.");
  };
  const text = locked && final ? finalMenuText(party, party.venue_name, final) : "";

  return (
    <div className="mb-6" data-testid="party-menu">
      <h3 className="text-lg font-semibold mb-1">Menu voting</h3>
      <p className="text-xs text-slate-500 mb-3">
        Guests with a paid seat vote once per category; a vote counts as many seats as the booking has paid. Voting closes{" "}
        <b>{fmtAt(meta?.effective_closes_at)}</b> (India time){meta?.voting_closes_at ? "" : ", 24 hours after joining closes"}.
      </p>
      {error && <p className="text-sm text-rose-700 mb-2" data-testid="menu-error">{error}</p>}
      {notice && <p className="text-sm text-emerald-700 mb-2" data-testid="menu-notice">{notice}</p>}

      <div className="flex flex-col gap-3">
        {MENU_CATEGORIES.map(([k, label]) => (
          <SetupCategory key={k} cat={k} label={label} state={setup[k]} items={items} disabled={locked || dead}
            onChange={(v) => setSetup((s) => { const n = { ...s }; if (v) n[k] = v; else delete n[k]; return n; })} />
        ))}
      </div>

      {!locked && !dead && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
          <label className="text-xs text-slate-600">Voting closes at (India time). Leave empty for the default.
            <input type="datetime-local" className={`${inputCls} mt-1`} value={closes} onChange={(e) => setCloses(e.target.value)} data-testid="menu-closes" />
          </label>
          <button type="button" onClick={save} disabled={busy} className="bg-slate-900 text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="menu-save">{busy ? "Saving…" : "Save menu vote"}</button>
        </div>
      )}

      {results && (
        <div className="mt-5" data-testid="menu-results">
          <h4 className="font-medium text-sm mb-1">Results so far</h4>
          <p className="text-xs text-slate-500 mb-2">{results.eligible_seats} paid seats can vote. {results.voting_closed ? "Voting is closed." : "Voting is open."}</p>
          <div className="flex flex-col gap-3">
            {results.categories.map((c) => (
              <ResultCategory key={`${c.category}-${c.options.map((o) => o.picked).join("")}`} c={c} voting={results} locked={locked} busy={busy}
                onPick={(cat, ids) => run(() => rpc(session.token, "party_admin_pick_tie", { p_party_id: party.id, p_category: cat, p_option_ids: ids }), "Tie decided.")} />
            ))}
          </div>
          {!locked && !dead && (
            <div className="mt-3">
              <button type="button" onClick={lock} disabled={busy || !results.voting_closed} className="bg-emerald-600 text-white rounded px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="menu-lock">Lock menu</button>
              {!results.voting_closed && <span className="text-xs text-slate-500 ml-3">Available once voting has closed.</span>}
            </div>
          )}
        </div>
      )}

      {locked && (
        <div className="mt-5 bg-emerald-50 border border-emerald-200 rounded-lg p-4" data-testid="menu-final">
          <p className="text-sm font-medium text-emerald-900">Final menu (locked {fmtAt(meta.locked_at)})</p>
          <textarea readOnly rows={Math.min(24, text.split("\n").length + 1)} className="w-full mt-2 border border-emerald-300 rounded p-2 text-sm font-mono bg-white" value={text} data-testid="menu-final-text" />
          <button type="button" className="mt-2 bg-slate-900 text-white rounded px-3 py-1.5 text-sm"
            onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError("Could not copy. Select the text and copy it."); } }}
            data-testid="menu-copy">{copied ? "Copied" : "Copy menu"}</button>
        </div>
      )}
    </div>
  );
}

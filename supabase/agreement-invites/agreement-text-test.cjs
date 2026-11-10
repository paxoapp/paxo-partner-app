// Run from paxo-partner-app:  node supabase/agreement-invites/agreement-text-test.cjs
// Fails if the agreement text in src/agreementText.jsx and the edge-function copy (agreement.ts) ever differ, or if a
// point that was meant to stay unchanged since v1 (git main) changes.
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const root = path.resolve(__dirname, "../..");
const esbuild = require(path.join(root, "node_modules/esbuild"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agr-"));
esbuild.buildSync({ entryPoints: [path.join(root, "src/agreementText.jsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(tmp, "t.cjs"), jsx: "automatic", logLevel: "error" });
const mod = require(path.join(tmp, "t.cjs"));
const NL = String.fromCharCode(10), CR = String.fromCharCode(13);
const norm = (s) => s.split(CR + NL).join(NL);
const ts = norm(fs.readFileSync(path.join(root, "supabase/agreement-invites/functions/agreement.ts"), "utf8"));
const block = ts.slice(ts.indexOf("export const ITEMS"), ts.indexOf("export const corsHeaders"));
const tsItems = eval("(" + block.replace("export const ITEMS: [string, string][] =", "").trim().replace(/;$/, "") + ")");
const tsIntro = /export const INTRO = "(.*)";/.exec(ts)[1];
const tsCounter = /export const COUNTERPARTY = "(.*)";/.exec(ts)[1];
// v1 baseline: the agreement text on main (version v1)
const base = process.env.V1_REF || "main";
const orig = norm(cp.execSync("git show " + base + ":src/agreementText.jsx", { cwd: root, encoding: "utf8", maxBuffer: 1e7 }));
const origItems = [...orig.matchAll(/^  \["([^"]+)", "(.*)"\],$/gm)].map((m) => [m[1], m[2]]);
const origIntro = /AGREEMENT_INTRO = "(.*)";/.exec(orig)[1];
let fails = 0;
const T = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); if (!ok) fails++; };
const find = (t) => mod.AGREEMENT_ITEMS.find((x) => x[0] === t);
const changed = new Set(["Platform fee.", "Billing.", "Settlement & payout."]);
T("v1 baseline has 10 points, v2 has 11 in both copies", origItems.length === 10 && mod.AGREEMENT_ITEMS.length === 11 && tsItems.length === 11);
T("version is v2 in app and edge copy", mod.AGREEMENT_VERSION === "v2" && /export const VERSION = "v2"/.test(ts));
T("unchanged points (1,2,3,5,7,9,10) identical to v1", origItems.every(([t, b]) => changed.has(t) || JSON.stringify(find(t)) === JSON.stringify([t, b])));
T("Billing and Settlement still begin with the v1 text", ["Billing.", "Settlement & payout."].every((t) => find(t)[1].startsWith(origItems.find((o) => o[0] === t)[1])));
T("point 11 is last and is Changes and ending", mod.AGREEMENT_ITEMS[10][0] === "Changes and ending.");
T("edge-function copy == app text (items)", JSON.stringify(mod.AGREEMENT_ITEMS) === JSON.stringify(tsItems));
T("intro identical in v1, app and edge copy", mod.AGREEMENT_INTRO === origIntro && tsIntro === origIntro);
T("counterparty identical and exact", mod.AGREEMENT_COUNTERPARTY === tsCounter && tsCounter === "M/S PAXO, a proprietorship of Sushil Kumar");
const all = fs.readdirSync(path.join(root, "src")).filter((f) => /^(agreement|onboarding)/.test(f)).map((f) => fs.readFileSync(path.join(root, "src", f), "utf8")).join(NL) + ts + fs.readFileSync(path.join(root, "supabase/agreement-invites/functions/send-transactional-email.ts"), "utf8");
T("OPC is not mentioned in agreement files", !/\bOPC\b|one person company/i.test(all));
T("email template says v2", /Partner Agreement \(v2\)/.test(fs.readFileSync(path.join(root, "supabase/agreement-invites/functions/send-transactional-email.ts"), "utf8")));
console.log(fails ? "FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);

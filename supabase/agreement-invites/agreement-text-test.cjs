// Run from paxo-partner-app:  node supabase/agreement-invites/agreement-text-test.cjs
// Fails if the agreement text in src/agreementText.jsx, the edge-function copy, or the text the login gate showed
// before this change (git main) ever differ.
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const root = path.resolve(__dirname, "../..");
const esbuild = require(path.join(root, "node_modules/esbuild"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agr-"));
esbuild.buildSync({ entryPoints: [path.join(root, "src/agreementText.jsx")], bundle: true, format: "cjs", platform: "node", outfile: path.join(tmp, "t.cjs"), jsx: "automatic", logLevel: "error" });
const mod = require(path.join(tmp, "t.cjs"));
const ts = fs.readFileSync(path.join(root, "supabase/agreement-invites/functions/agreement.ts"), "utf8").replace(/\r\n/g, "\n");
const block = ts.slice(ts.indexOf("export const ITEMS"), ts.indexOf("export const corsHeaders"));
const tsItems = eval("(" + block.replace("export const ITEMS: [string, string][] =", "").trim().replace(/;$/, "") + ")");
const tsIntro = /export const INTRO = "(.*)";/.exec(ts)[1];
const tsCounter = /export const COUNTERPARTY = "(.*)";/.exec(ts)[1];
const orig = cp.execSync("git show main:src/onboarding.jsx", { cwd: root, encoding: "utf8", maxBuffer: 1e7 }).replace(/\r\n/g, "\n");
const origItems = [...orig.matchAll(/<li><strong>(.*?)<\/strong> (.*?)<\/li>/g)].map((m) => [m[1], m[2]]);
const origIntro = /<p>(By continuing, you agree[^<]*)<\/p>/.exec(orig)[1];
let fails = 0;
const T = (n, ok) => { console.log((ok ? "PASS " : "FAIL ") + n); if (!ok) fails++; };
T("10 items", mod.AGREEMENT_ITEMS.length === 10 && tsItems.length === 10 && origItems.length === 10);
T("app text == original login-gate text (items)", JSON.stringify(mod.AGREEMENT_ITEMS) === JSON.stringify(origItems));
T("edge-function copy == app text (items)", JSON.stringify(mod.AGREEMENT_ITEMS) === JSON.stringify(tsItems));
T("intro identical in all three", mod.AGREEMENT_INTRO === origIntro && tsIntro === origIntro);
T("counterparty identical and exact", mod.AGREEMENT_COUNTERPARTY === tsCounter && tsCounter === "M/S PAXO, a proprietorship of Sushil Kumar");
const all = fs.readdirSync(path.join(root, "src")).filter((f) => /^(agreement|onboarding)/.test(f)).map((f) => fs.readFileSync(path.join(root, "src", f), "utf8")).join("\n") + ts + fs.readFileSync(path.join(root, "supabase/agreement-invites/functions/send-transactional-email.ts"), "utf8");
T("OPC is not mentioned in agreement files", !/\bOPC\b|one person company/i.test(all));
console.log(fails ? "FAILED" : "ALL PASS"); process.exit(fails ? 1 : 0);

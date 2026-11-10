import { createClient } from "jsr:@supabase/supabase-js@2";
import { ITEMS, TOKEN_RE, buildPdf, corsHeaders, istText, json, sendMail, sha256Hex, toBase64 } from "./agreement.ts";

// Public (no login). The owner opens partner.mypaxo.in/agreement/<token>.
//   action "check"  -> is this link usable? (returns the venue name only for a usable link)
//   action "accept" -> records the acceptance (one database transaction), then makes the PDF, stores it in the private
//                      bucket and emails the owner (support@mypaxo.in in copy). The acceptance is already final by then:
//                      if the PDF or the email fails, the acceptance stays and the admin can fetch the PDF later.
// Only the SHA-256 hash of the token is ever looked up or stored. Rate limited per IP.
const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  const ip = (xf ? xf.split(",")[0] : req.headers.get("cf-connecting-ip") || "").trim();
  return ip.slice(0, 64) || "unknown";
}
async function allowed(key: string, limit: number, seconds: number): Promise<boolean> {
  const { data, error } = await svc.rpc("agreement_rate_hit", { p_key: key, p_limit: limit, p_window_seconds: seconds });
  return error ? false : data === true; // if the limiter itself fails, refuse (safe side)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const ip = clientIp(req);
    const b = await req.json().catch(() => ({}));
    const action = b.action;
    if (action !== "check" && action !== "accept") return json({ error: "Bad request" }, 400);
    if (!(await allowed(`agr-${action}:${ip}`, action === "check" ? 60 : 10, action === "check" ? 600 : 3600))) {
      return json({ error: "Too many attempts. Please wait a while and try again." }, 429);
    }
    const token = typeof b.token === "string" ? b.token : "";
    if (!TOKEN_RE.test(token)) {
      await allowed(`agr-bad:${ip}`, 15, 3600);
      return json({ status: "invalid" });
    }
    const hash = await sha256Hex(token);

    if (action === "check") {
      const { data, error } = await svc.rpc("agreement_invite_check", { p_token_hash: hash });
      if (error || !data) return json({ error: "Something went wrong. Please try again." }, 500);
      if (data.status === "invalid" && !(await allowed(`agr-bad:${ip}`, 15, 3600))) {
        return json({ error: "Too many attempts. Please wait a while and try again." }, 429);
      }
      return json(data);
    }

    // accept
    if (b.confirm !== true) return json({ error: "Please tick the box to accept." }, 400);
    const { data: acc, error } = await svc.rpc("agreement_invite_accept", {
      p_token_hash: hash,
      p_name: typeof b.name === "string" ? b.name : "",
      p_designation: typeof b.designation === "string" ? b.designation : "",
      p_ip: ip,
      p_device: (req.headers.get("user-agent") || "").slice(0, 500),
    });
    if (error || !acc) {
      const m = error?.message || "";
      const known = ["Please enter your full name", "Please enter your designation", "This link is not valid", "This link has already been used", "This link has expired"];
      const hit = known.find((k) => m.includes(k));
      if (!hit) return json({ error: "Something went wrong. Please try again." }, 500);
      const status = hit.startsWith("Please") ? 400 : hit.includes("not valid") ? 404 : 410;
      return json({ error: hit }, status);
    }

    // The acceptance is saved. Now the PDF and the emails; failures here never undo it.
    let pdfOk = false, mailOk = false;
    let pdf: Uint8Array | null = null;
    try {
      pdf = await buildPdf({
        acceptance_id: acc.acceptance_id, venue_name: acc.venue_name, name: acc.name, designation: acc.designation,
        email: acc.email, accepted_at: acc.accepted_at, ip_address: ip, device_info: req.headers.get("user-agent"),
      });
      const up = await svc.storage.from("venue-agreements").upload(`${acc.venue_id}/${acc.acceptance_id}.pdf`, pdf, { contentType: "application/pdf", upsert: true });
      pdfOk = !up.error;
    } catch (e) {
      console.error("agreement pdf failed", String(e));
    }
    mailOk = await sendMail({
      type: "partner_agreement_accepted",
      to: acc.email,
      cc: ["support@mypaxo.in"],
      idempotency_key: `agreement-accepted-${acc.acceptance_id}`,
      data: {
        venue_name: acc.venue_name, name: acc.name, designation: acc.designation, accepted_at: istText(acc.accepted_at),
        reference: acc.acceptance_id, items: ITEMS,
      },
      attachments: pdf ? [{ filename: `PAXO-Partner-Agreement-${String(acc.venue_name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}.pdf`, content: toBase64(pdf) }] : [],
    });
    if (!mailOk) console.error("agreement confirmation email failed", acc.acceptance_id);
    return json({ ok: true, venue_name: acc.venue_name, email: acc.email, emailed: mailOk, pdf_saved: pdfOk });
  } catch (e) {
    console.error("agreement-public", String(e));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

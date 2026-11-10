import { createClient } from "jsr:@supabase/supabase-js@2";
import { TOKEN_RE, buildPdf, corsHeaders, isUuid, json, sendMail, sha256Hex } from "./agreement.ts";

// Admin only. Actions:
//   send -> checks the owner's email is real, makes a 32-byte random token, stores only its hash (cancelling older unused
//           links for the venue), emails the link. Nothing is stored for a link that could not be emailed.
//   pdf  -> a short-lived download link for the stored acceptance PDF (rebuilt first if it is missing).
//   info -> when a link was last sent to the venue and whether it was opened/used.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });

const PROD_ORIGIN = "https://partner.mypaxo.in";
// Links may point at the production partner site or at this project's own Vercel previews (for testing); nothing else.
const PREVIEW_RE = /^https:\/\/paxo-partner-app-git-[a-z0-9-]+-paxo-app\.vercel\.app$/;
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const FAKE_DOMAINS = new Set(["mypaxo.in", "example.com", "example.org", "example.net", "test.com", "test.in", "domain.com", "email.com", "mailinator.com", "yopmail.com", "guerrillamail.com", "tempmail.com", "10minutemail.com"]);

// Returns an error message, or null when the address looks real. Our own placeholder logins (paxoapp.in+name@gmail.com)
// are refused; so are made-up domains and domains that cannot receive mail.
async function emailProblem(email: string): Promise<string | null> {
  if (email.length > 200 || email.includes("..") || !EMAIL_RE.test(email)) return "That is not a valid email address.";
  const [local, domain] = email.split("@");
  const lower = domain.toLowerCase();
  if (local.toLowerCase().startsWith("paxoapp.in")) return "That is a PAXO placeholder address. Enter the owner's own email.";
  if (FAKE_DOMAINS.has(lower) || lower.endsWith(".test") || lower.endsWith(".invalid") || lower.endsWith(".example") || lower.endsWith(".local") || lower.endsWith(".localhost")) {
    return "That email address does not look real. Enter the owner's own email.";
  }
  try {
    let found = false;
    try { found = ((await Deno.resolveDns(lower, "MX")) as unknown[]).length > 0; } catch (e) { if ((e as Error).name !== "NotFound") throw e; }
    if (!found) { try { found = ((await Deno.resolveDns(lower, "A")) as unknown[]).length > 0; } catch (e) { if ((e as Error).name !== "NotFound") throw e; } }
    if (!found) return `${lower} cannot receive email. Check the spelling.`;
  } catch (_e) {
    /* the DNS lookup itself is unavailable: format and placeholder checks above still applied */
  }
  return null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: who } = await caller.auth.getUser();
    const adminId = who?.user?.id;
    if (!adminId) return json({ error: "Unauthorized" }, 401);
    const { data: adminRow } = await svc.from("admin_users").select("id").eq("id", adminId).maybeSingle();
    if (!adminRow) return json({ error: "Admin access required" }, 403);

    const b = await req.json().catch(() => ({}));
    if (!isUuid(b.venue_id)) return json({ error: "Missing venue" }, 400);
    const { data: venue } = await svc.from("venues").select("id, name").eq("id", b.venue_id).maybeSingle();
    if (!venue) return json({ error: "Venue not found" }, 404);

    if (b.action === "info") {
      const { data } = await svc.from("venue_agreement_invites").select("sent_to_email, sent_to_name, created_at, expires_at, used_at").eq("venue_id", venue.id).order("created_at", { ascending: false }).limit(1);
      return json({ last_invite: data?.[0] ?? null });
    }

    if (b.action === "pdf") {
      const { data: acc } = await svc.from("agreement_acceptances")
        .select("id, accepted_at, ip_address, device_info, accepted_by_name, accepted_by_designation, accepted_email, accepted_via")
        .eq("venue_id", venue.id).eq("checkpoint", "final_agreement").order("accepted_at", { ascending: false }).limit(1).maybeSingle();
      if (!acc) return json({ error: "This venue has not accepted the agreement yet." }, 404);
      if (acc.accepted_via !== "email_link" || !acc.accepted_by_name) return json({ error: "This venue accepted inside the PAXO app, so there is no signed PDF copy." }, 404);
      const path = `${venue.id}/${acc.id}.pdf`;
      const signed = async () => await svc.storage.from("venue-agreements").createSignedUrl(path, 120, { download: `PAXO-Partner-Agreement-${venue.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}.pdf` });
      let s = await signed();
      if (s.error || !s.data?.signedUrl) {
        const pdf = await buildPdf({
          acceptance_id: acc.id, venue_name: venue.name, name: acc.accepted_by_name, designation: acc.accepted_by_designation ?? "",
          email: acc.accepted_email ?? "", accepted_at: acc.accepted_at, ip_address: acc.ip_address, device_info: acc.device_info,
        });
        const up = await svc.storage.from("venue-agreements").upload(path, pdf, { contentType: "application/pdf", upsert: true });
        if (up.error) return json({ error: "Could not make the PDF." }, 500);
        s = await signed();
      }
      if (!s.data?.signedUrl) return json({ error: "Could not make the download link." }, 500);
      return json({ url: s.data.signedUrl });
    }

    if (b.action === "send") {
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const name = typeof b.name === "string" ? b.name.trim().replace(/[\r\n\t]+/g, " ").slice(0, 120) : "";
      if (name.length < 2) return json({ error: "Enter the owner's name." }, 400);
      const problem = await emailProblem(email);
      if (problem) return json({ error: problem }, 400);
      const origin = typeof b.origin === "string" && (b.origin === PROD_ORIGIN || PREVIEW_RE.test(b.origin)) ? b.origin : PROD_ORIGIN;

      const { data: ok } = await svc.rpc("agreement_rate_hit", { p_key: `agr-send:${adminId}`, p_limit: 30, p_window_seconds: 3600 });
      if (ok !== true) return json({ error: "Too many links sent in the last hour. Please wait." }, 429);

      const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
      if (!TOKEN_RE.test(token)) return json({ error: "Could not make a link. Try again." }, 500);
      const hash = await sha256Hex(token);
      const { data: expiresAt, error: cErr } = await svc.rpc("agreement_invite_create", { p_venue_id: venue.id, p_token_hash: hash, p_email: email, p_name: name, p_admin: adminId });
      if (cErr) return json({ error: cErr.message.includes("already accepted") ? "This venue has already accepted the agreement." : "Could not create the link." }, cErr.message.includes("already accepted") ? 409 : 500);

      const sent = await sendMail({
        type: "partner_agreement_invite",
        to: email,
        idempotency_key: `agreement-invite-${hash.slice(0, 40)}`,
        data: { venue_name: venue.name, owner_name: name, link: `${origin}/agreement/${token}`, expires_on: new Date(expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) },
      });
      if (!sent) {
        await svc.from("venue_agreement_invites").update({ expires_at: new Date().toISOString() }).eq("token_hash", hash);
        return json({ error: "The email could not be sent, so the link was cancelled. Please try again." }, 502);
      }
      return json({ ok: true, sent_to: email, expires_at: expiresAt });
    }
    return json({ error: "Bad request" }, 400);
  } catch (e) {
    console.error("admin-agreement-invite", String(e));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

import { createClient } from "jsr:@supabase/supabase-js@2";

// Admin-only. Hands a PAXO-managed venue over to its real owner:
//   login email -> owner's email (same user, same venue link, same history), a new random password nobody sees,
//   every old session ended, venues.business_email -> owner, managed_by_paxo -> false,
//   one branded "dashboard ready" email with a set-your-password link (generated here, NOT sent by Supabase).
// Safe to retry: progress is kept in managed_venue_audit (started -> email_changed -> db_done -> completed), a retry
// continues from the last finished step, and the email carries an idempotency key, so it can never be sent twice.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET"); // the same secret send-transactional-email already checks
const PARTNER_URL = "https://partner.mypaxo.in";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function randomPassword(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: who } = await callerClient.auth.getUser();
    const adminId = who?.user?.id;
    if (!adminId) return json({ error: "Unauthorized" }, 401);
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: adminRow } = await svc.from("admin_users").select("id").eq("id", adminId).maybeSingle();
    if (!adminRow) return json({ error: "Admin access required" }, 403);

    const b = await req.json().catch(() => ({}));
    if (!isUuid(b.venue_id)) return json({ error: "Missing venue" }, 400);
    if (b.confirm !== true) return json({ error: "Please confirm the handover." }, 400);
    const bodyEmail = typeof b.owner_email === "string" ? b.owner_email.trim().toLowerCase() : "";

    const { data: venue } = await svc.from("venues").select("id, name, managed_by_paxo, business_email").eq("id", b.venue_id).maybeSingle();
    if (!venue) return json({ error: "Venue not found" }, 404);
    const { data: pu } = await svc.from("partner_users").select("id").eq("venue_id", venue.id).maybeSingle();
    if (!pu) return json({ error: "This venue has no login." }, 409);

    let { data: audit } = await svc.from("managed_venue_audit").select("*")
      .eq("venue_id", venue.id).eq("action", "handover").neq("status", "failed").maybeSingle();
    if (audit?.status === "completed") return json({ ok: true, already_handed_over: true });

    if (!audit) {
      // a brand-new handover: every refusal happens here, before anything is changed
      if (!venue.managed_by_paxo) return json({ error: "This venue is not managed by PAXO." }, 409);
      if (!bodyEmail || bodyEmail.length > 200 || !EMAIL_RE.test(bodyEmail)) return json({ error: "Enter a valid owner email." }, 400);
      if (bodyEmail.startsWith("paxoapp.in+")) return json({ error: "That is a PAXO address. Enter the owner's own email." }, 400);
      const { data: used } = await svc.rpc("managed_email_in_use", { p_email: bodyEmail, p_except: pu.id });
      if (used) return json({ error: "That email already belongs to another account." }, 409);
      const { data: cur } = await svc.auth.admin.getUserById(pu.id);
      const { data: started, error: sErr } = await svc.from("managed_venue_audit").insert({
        venue_id: venue.id, action: "handover", status: "started", admin_id: adminId, login_user_id: pu.id,
        previous_login_email: cur?.user?.email ?? venue.business_email, new_email: bodyEmail,
      }).select("*").single();
      if (sErr || !started) {
        // two clicks at once: the other one owns the handover, continue from its row
        const { data: other } = await svc.from("managed_venue_audit").select("*").eq("venue_id", venue.id).eq("action", "handover").neq("status", "failed").maybeSingle();
        if (!other) return json({ error: "Could not start the handover. Please try again." }, 500);
        audit = other;
      } else {
        audit = started;
      }
    } else if (bodyEmail && bodyEmail !== audit.new_email) {
      return json({ error: `A handover to ${audit.new_email} is already in progress. Retry with that address.` }, 409);
    }
    const newEmail: string = audit!.new_email;

    // step A: the login's email + an unknown random password, in ONE auth call (no email is sent by Supabase)
    if (audit!.status === "started") {
      const { data: cur } = await svc.auth.admin.getUserById(pu.id);
      if (!cur?.user) return json({ error: "The login could not be found." }, 500);
      if ((cur.user.email ?? "").toLowerCase() !== newEmail) {
        const { data: used } = await svc.rpc("managed_email_in_use", { p_email: newEmail, p_except: pu.id });
        if (used) return json({ error: "That email already belongs to another account." }, 409);
        const { error: uErr } = await svc.auth.admin.updateUserById(pu.id, { email: newEmail, email_confirm: true, password: randomPassword() });
        if (uErr) return json({ error: "Could not change the login email. Nothing else was changed; you can retry." }, 500);
      }
      await svc.from("managed_venue_audit").update({ status: "email_changed", updated_at: new Date().toISOString() }).eq("id", audit!.id);
      audit = { ...audit!, status: "email_changed" };
    }

    // step B: the database half (business_email, flag off, sessions ended)
    if (audit!.status === "email_changed") {
      const { error: dbErr } = await svc.rpc("managed_complete_handover", { p_audit: audit!.id, p_venue: venue.id, p_new_email: newEmail });
      if (dbErr) return json({ error: "The login email was changed but the venue update failed. Press the button again to finish." }, 500);
      audit = { ...audit!, status: "db_done" };
    }

    // step C: the set-password link (made here, not mailed by Supabase) and the one welcome email
    if (audit!.status === "db_done") {
      if (!EMAIL_WEBHOOK_SECRET) return json({ error: "Handed over, but the email could not be sent (not configured). Press the button again once it is." }, 502);
      const { data: link, error: lErr } = await svc.auth.admin.generateLink({ type: "recovery", email: newEmail, options: { redirectTo: PARTNER_URL } });
      const actionLink = link?.properties?.action_link;
      if (lErr || !actionLink) return json({ error: "Handed over, but the set-password link could not be made. Press the button again." }, 502);
      // Supabase silently swaps in its default page when the redirect address is not on the Auth allow list. Never mail
      // the owner a link that would not open the partner app: stop here (retry-safe) and say what to fix.
      let redirectOk = false;
      try { redirectOk = new URL(actionLink).searchParams.get("redirect_to")?.replace(/\/+$/, "") === PARTNER_URL; } catch (_e) { redirectOk = false; }
      if (!redirectOk) return json({ error: "Handed over, but the set-password link does not open partner.mypaxo.in. Add https://partner.mypaxo.in to Supabase Auth > URL Configuration > Redirect URLs, then press the button again. No email was sent." }, 502);
      const mail = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-secret": EMAIL_WEBHOOK_SECRET },
        body: JSON.stringify({
          type: "partner_dashboard_ready",
          to: newEmail,
          idempotency_key: `handover-${audit!.id}`,
          data: { venue_name: venue.name, action_link: actionLink },
        }),
      });
      if (!mail.ok) {
        await svc.from("managed_venue_audit").update({ error: "welcome email not sent", updated_at: new Date().toISOString() }).eq("id", audit!.id);
        return json({ error: "Handed over, but the welcome email could not be sent. Press the button again to send it." }, 502);
      }
      await svc.from("managed_venue_audit").update({
        status: "completed", emailed_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString(),
      }).eq("id", audit!.id);
    }
    return json({ ok: true, handed_over: true, owner_email: newEmail });
  } catch (_e) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

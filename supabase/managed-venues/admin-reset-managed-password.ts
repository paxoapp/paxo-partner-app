import { createClient } from "jsr:@supabase/supabase-js@2";

// Admin-only. New random password for a venue's PAXO-managed login. Shown once; never logged or stored.
// Every existing session of that login is ended. Refuses a venue that is not (or no longer) managed.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

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

    const { venue_id } = await req.json().catch(() => ({}));
    if (!isUuid(venue_id)) return json({ error: "Missing venue" }, 400);
    const { data: venue } = await svc.from("venues").select("id, managed_by_paxo").eq("id", venue_id).maybeSingle();
    if (!venue) return json({ error: "Venue not found" }, 404);
    if (!venue.managed_by_paxo) return json({ error: "This venue is not managed by PAXO." }, 409);
    const { data: pu } = await svc.from("partner_users").select("id").eq("venue_id", venue_id).maybeSingle();
    if (!pu) return json({ error: "This venue has no login." }, 409);

    const password = randomPassword();
    const { data: updated, error: uErr } = await svc.auth.admin.updateUserById(pu.id, { password });
    if (uErr || !updated?.user) return json({ error: "Could not reset the password. Please try again." }, 500);
    await svc.rpc("managed_end_sessions", { p_uid: pu.id });
    await svc.from("managed_venue_audit").insert({
      venue_id, action: "reset_password", status: "completed", admin_id: adminId, login_user_id: pu.id, new_email: updated.user.email ?? null,
    });
    return json({ ok: true, login_email: updated.user.email, password });
  } catch (_e) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

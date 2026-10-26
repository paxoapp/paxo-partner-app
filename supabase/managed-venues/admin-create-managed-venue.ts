import { createClient } from "jsr:@supabase/supabase-js@2";

// Admin-only. Creates a PAXO-managed venue and its ONE partner login in one go.
//  * the caller must be signed in AND be in admin_users (checked here with the service role, never trusted from the browser)
//  * the login is paxoapp.in+<slug>@gmail.com with a random password made here; the password is returned ONCE and is never
//    logged, stored in a table, or put in an error message. Supabase keeps only its hash.
//  * the account is created already confirmed, so Supabase sends no email.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOGIN_PREFIX = "paxoapp.in+";
const LOGIN_DOMAIN = "@gmail.com";

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
const clean = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
// Strict on purpose: letters, digits and . _ % + - only before the @, a real domain after it. No spaces, no ":" (so
// "mailto:x@y.com" is refused), no "<", no ",". Callers trim and lower-case first.
const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const isEmail = (v: string) => v.length <= 200 && !v.includes("..") && EMAIL_RE.test(v);
const slugOf = (name: string) => {
  const s = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  return s || "venue" + Math.random().toString(36).slice(2, 6);
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    // 1. who is calling? must be a signed-in PAXO admin
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: who } = await callerClient.auth.getUser();
    const adminId = who?.user?.id;
    if (!adminId) return json({ error: "Unauthorized" }, 401);
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: adminRow } = await svc.from("admin_users").select("id").eq("id", adminId).maybeSingle();
    if (!adminRow) return json({ error: "Admin access required" }, 403);

    // 2. input
    const b = await req.json().catch(() => ({}));
    const requestId = b.request_id;
    if (!isUuid(requestId)) return json({ error: "Missing request id" }, 400);
    const name = clean(b.name, 120);
    const city = clean(b.city, 80);
    const contactPhone = clean(b.contact_phone, 20);
    const ownerEmail = clean(b.owner_contact_email, 200).toLowerCase();
    const capacity = b.guest_capacity === "" || b.guest_capacity == null ? null : Number(b.guest_capacity);
    if (name.length < 2) return json({ error: "Enter the venue name." }, 400);
    if (!city) return json({ error: "Enter the city." }, 400);
    if (!clean(b.contact_person_name, 120)) return json({ error: "Enter the contact person." }, 400);
    if (contactPhone.replace(/\D/g, "").length < 10) return json({ error: "Enter a valid contact phone number." }, 400);
    if (ownerEmail && !isEmail(ownerEmail)) return json({ error: "Enter a valid email (letters, digits and . _ + - only, no spaces and no \"mailto:\")." }, 400);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000)) return json({ error: "Guest capacity must be a whole number." }, 400);
    const maps = clean(b.google_maps_url, 500);
    if (maps && !/^https?:\/\//i.test(maps)) return json({ error: "The Google Maps link must start with http:// or https://" }, 400);

    // same request again (double click, retry after a timeout): same venue, and the password cannot be shown a second time
    const { data: again } = await svc.from("managed_venue_audit").select("venue_id, new_email").eq("request_id", requestId).eq("action", "create").maybeSingle();
    if (again) return json({ ok: true, already_created: true, venue_id: again.venue_id, login_email: again.new_email });

    // same venue twice
    const { data: dup } = await svc.rpc("managed_venue_duplicate", { p_name: name, p_city: city });
    if (dup && !b.allow_duplicate) return json({ error: "A venue with this name already exists in this city.", duplicate: true }, 409);

    // 3. the login: unique plus-address, random password, already confirmed (no email is sent)
    const base = slugOf(name);
    const password = randomPassword();
    let loginEmail = "";
    let userId = "";
    for (let n = 1; n <= 8 && !userId; n++) {
      const candidate = `${LOGIN_PREFIX}${n === 1 ? base : base + n}${LOGIN_DOMAIN}`;
      const { data: taken } = await svc.rpc("managed_login_email_taken", { p_email: candidate });
      if (taken) continue;
      const { data: created, error: cErr } = await svc.auth.admin.createUser({
        email: candidate,
        password,
        email_confirm: true,
        user_metadata: { full_name: clean(b.contact_person_name, 120), managed_venue: true },
      });
      if (!cErr && created?.user) {
        userId = created.user.id;
        loginEmail = candidate;
      }
    }
    if (!userId) return json({ error: "Could not create the login. Please try again." }, 500);

    // 4. the venue + partner link + audit row, in one database transaction
    const { data: venueId, error: vErr } = await svc.rpc("managed_create_venue", {
      p_admin: adminId,
      p_request: requestId,
      p_user: userId,
      p_login_email: loginEmail,
      p_name: name,
      p_venue_type: clean(b.venue_type, 80),
      p_city: city,
      p_area: clean(b.area, 120),
      p_address: clean(b.address, 400),
      p_maps: maps,
      p_capacity: capacity,
      p_contact_person: clean(b.contact_person_name, 120),
      p_contact_phone: contactPhone,
      p_owner_email: ownerEmail,
      p_gst_no: clean(b.gst_no, 20),
      p_allow_duplicate: !!b.allow_duplicate,
    });
    if (vErr || !venueId) {
      await svc.auth.admin.deleteUser(userId); // nothing is left half-made
      const msg = vErr?.message && /already exists in this city|required/i.test(vErr.message) ? vErr.message : "Could not add the venue. Please try again.";
      return json({ error: msg }, vErr?.message && /already exists/i.test(vErr.message) ? 409 : 500);
    }
    return json({ ok: true, venue_id: venueId, login_email: loginEmail, password });
  } catch (_e) {
    return json({ error: "Something went wrong. Please try again." }, 500); // never echo the request or any secret
  }
});

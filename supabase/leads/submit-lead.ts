import { createClient } from "jsr:@supabase/supabase-js@2";

// PUBLIC (no sign-in needed: the customer app calls it for signed-out visitors too).
// Saves a "Find my venue" enquiry as a lead and emails the founder. Validates everything again here (the browser is not
// trusted), ignores bots (hidden honeypot field), limits repeats, and never returns anything but ok / a plain message.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET"); // the secret send-transactional-email already checks
const NOTIFY_TO = Deno.env.get("LEAD_NOTIFY_EMAIL") || "paxoapp.in@gmail.com"; // the founder's inbox; set LEAD_NOTIFY_EMAIL to change

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
function cleanPhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    if (clean(b.company, 50)) return json({ ok: true }); // honeypot filled: a bot. Pretend it worked, store nothing.

    const name = clean(b.name, 120);
    const location = clean(b.location, 200);
    const phone = cleanPhone(b.phone);
    const partyDate = typeof b.party_date === "string" ? b.party_date : "";
    const guests = Number(b.guests);
    if (name.length < 2) return json({ error: "Please enter your name." }, 400);
    if (!phone) return json({ error: "Please enter a valid 10-digit mobile number." }, 400);
    if (location.length < 2) return json({ error: "Please tell us the area or city you are looking at." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(partyDate) || Number.isNaN(Date.parse(partyDate))) return json({ error: "Please choose your party date." }, 400);
    const today = todayIST();
    const maxDate = new Date(Date.now() + 5.5 * 3600 * 1000 + 800 * 86400 * 1000).toISOString().slice(0, 10);
    if (partyDate < today) return json({ error: "The party date cannot be in the past." }, 400);
    if (partyDate > maxDate) return json({ error: "Please choose a nearer party date." }, 400);
    if (!Number.isInteger(guests) || guests < 1 || guests > 5000) return json({ error: "Please enter the number of guests (MG) as a whole number." }, 400);

    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

    // signed in? then the lead remembers which customer account it came from (anonymous visitors simply have none)
    let customerId: string | null = null;
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token && token !== SUPABASE_ANON_KEY) {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data: who } = await callerClient.auth.getUser();
      customerId = who?.user?.id ?? null;
    }

    // limits: the same number can send 3 a day, and the whole form 60 an hour (a flood is a bot, not customers)
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count: samePhone } = await svc.from("venue_leads").select("id", { count: "exact", head: true }).eq("phone", phone).gte("created_at", dayAgo);
    if ((samePhone ?? 0) >= 3) return json({ ok: true, already: true }); // we already have their requests; nothing more to store
    const { count: lastHour } = await svc.from("venue_leads").select("id", { count: "exact", head: true }).gte("created_at", hourAgo);
    if ((lastHour ?? 0) >= 60) return json({ error: "We are getting a lot of requests right now. Please try again in a little while." }, 429);
    // the exact same enquiry twice in a day (double tap, resend) is stored once
    const { data: dup } = await svc.from("venue_leads").select("id").eq("phone", phone).eq("party_date", partyDate).eq("guests", guests).gte("created_at", dayAgo).limit(1);
    if (dup && dup.length) return json({ ok: true, already: true });

    const { data: lead, error: iErr } = await svc.from("venue_leads")
      .insert({ name, phone, location, party_date: partyDate, guests, customer_id: customerId })
      .select("id, created_at").single();
    if (iErr || !lead) return json({ error: "Something went wrong. Please try again." }, 500);

    // tell the founder. A failed email never fails the customer's request: the lead is saved and shows in the admin Leads tab.
    if (EMAIL_WEBHOOK_SECRET) {
      try {
        const mail = await fetch(`${SUPABASE_URL}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-secret": EMAIL_WEBHOOK_SECRET },
          body: JSON.stringify({
            type: "lead_new",
            to: NOTIFY_TO,
            idempotency_key: `lead-${lead.id}`,
            data: { name, phone, location, party_date: partyDate, guests, signed_in: !!customerId, created_at: lead.created_at },
          }),
        });
        if (mail.ok) await svc.from("venue_leads").update({ notified_at: new Date().toISOString() }).eq("id", lead.id);
      } catch (_e) { /* saved anyway */ }
    }
    return json({ ok: true });
  } catch (_e) {
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});

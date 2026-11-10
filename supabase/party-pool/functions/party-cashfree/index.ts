// party-cashfree  (verify_jwt = true)  — deployed as index.ts together with cashfree.ts. NOT DEPLOYED until the founder says so.
// The Cashfree twin of party-payment (Razorpay). Same split of work: ALL money rules live in the database function
// party_start_payment (seats, ages, 5-seat cap, tax, 30% / 100%, hold); this file only asks Cashfree for an order for the row the
// database created, and verifies afterwards by asking Cashfree itself (never the browser).
//   { action: "create", party_id, kind: "join" | "balance", guests?: [{name, age, gender}], accept_terms?: bool,
//     terms_version?: int, contact_mobile?: string }
//   { action: "verify", order_id }
// Party orders are named "PY" + 32 hex so the one Cashfree webhook can tell them from booking orders ("PX...").
import { createClient } from "jsr:@supabase/supabase-js@2";
import { envFor, envsPreferring, confirmOrderAnyEnv, cfFetch, corsHeaders, jsonRes, PARTY_ORDER_ID_RE, type Mode } from "./cashfree.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Where Cashfree sends the customer back to after a redirect-style payment (UPI apps, 3-D Secure). Only our own sites.
const ALLOWED_ORIGIN = /^https:\/\/(www\.)?mypaxo\.in$|^http:\/\/localhost:\d+$/;
function returnOrigin(req: Request): string {
  const o = req.headers.get("origin") ?? "";
  return ALLOWED_ORIGIN.test(o) ? o : "https://www.mypaxo.in";
}
function tenDigits(raw: unknown): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  const n = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(n) ? n : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonRes({ error: "method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const body = await req.json();
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: u } = await caller.auth.getUser();
    const uid = u?.user?.id;
    if (!uid) return jsonRes({ error: "Please sign in to continue." }, 401);

    // ---------------------------------------------------------------- create
    if (body.action === "create") {
      // keys first (so a deploy can be checked while the switch is still Razorpay), then the switch itself
      const { data: prov } = await service.rpc("get_payment_provider");
      const mode: Mode = prov?.mode === "production" ? "production" : "sandbox";
      const env = envFor(mode, (n) => Deno.env.get(n));
      if (!env) return jsonRes({ error: `Cashfree ${mode} keys are not set up yet.` }, 503);
      if (prov?.provider !== "cashfree") return jsonRes({ error: "Cashfree is not switched on." }, 409);

      // Cashfree needs a mobile number. Check it BEFORE the database holds any seats.
      const { data: profile } = await service.from("profiles").select("full_name, email, phone").eq("id", uid).maybeSingle();
      const phone = tenDigits(body.contact_mobile) ?? tenDigits(profile?.phone);
      if (!phone) {
        return jsonRes({ error: body.contact_mobile ? "Please enter a valid 10-digit mobile number to continue." : "Please add a 10-digit mobile number to your profile, then try again." }, 400);
      }

      // the database checks every rule as the signed-in customer and holds the seats
      const { data: pay, error } = await caller.rpc("party_start_payment", {
        p_party_id: body.party_id,
        p_kind: body.kind,
        p_guests: Array.isArray(body.guests) ? body.guests : null,
        p_accept: body.accept_terms === true,
        p_terms_version: Number.isInteger(body.terms_version) ? body.terms_version : null,
      });
      if (error || !pay) return jsonRes({ error: error?.message ?? "Could not start the payment." }, 400);
      if (pay.provider !== "cashfree") {
        // the switch moved between the check above and the database call: give the seats back, nothing was charged
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "The payment method just changed. Please try again." }, 409);
      }

      // Cashfree wants an order open for at least ~15 minutes: follow the seat hold (16 minutes for Cashfree) but never less than 16.
      const now = Date.now();
      const expiry = new Date(Math.min(Math.max(new Date(pay.held_until ?? now).getTime(), now + 16 * 60000), now + 60 * 60000));
      const orderId = "PY" + crypto.randomUUID().replaceAll("-", "");
      const cf = await cfFetch(env, "/orders", {
        method: "POST",
        body: {
          order_id: orderId,
          order_amount: Number(Number(pay.amount).toFixed(2)),
          order_currency: "INR",
          customer_details: {
            customer_id: String(uid).replaceAll("-", "").slice(0, 40),
            customer_phone: phone,
            ...(profile?.email ? { customer_email: String(profile.email) } : {}),
            ...(profile?.full_name ? { customer_name: String(profile.full_name).slice(0, 100) } : {}),
          },
          order_meta: { return_url: `${returnOrigin(req)}/?cf_party_order={order_id}` },
          order_expiry_time: expiry.toISOString(),
          order_note: "PAXO party seats",
        },
      });
      if (!cf.ok || cf.data?.order_id !== orderId || !cf.data?.payment_session_id) {
        console.error("party-cashfree create order failed", cf.status, JSON.stringify(cf.data)?.slice(0, 300));
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "Cashfree order creation failed" }, 502);
      }
      const { error: attErr } = await service.rpc("party_attach_cashfree_order", { p_payment_id: pay.payment_id, p_order_id: orderId });
      if (attErr) {
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "Failed to record the payment" }, 500);
      }
      return jsonRes({
        provider: "cashfree", mode: env.mode, order_id: orderId, payment_session_id: cf.data.payment_session_id,
        amount: Math.round(Number(pay.amount) * 100), currency: "INR",
        payment_id: pay.payment_id, kind: pay.kind, seats: pay.seats, held_until: pay.held_until,
      });
    }

    // ---------------------------------------------------------------- verify
    if (body.action === "verify") {
      const orderId = String(body.order_id ?? "");
      if (!PARTY_ORDER_ID_RE.test(orderId)) return jsonRes({ error: "order_id is required" }, 400);
      const { data: rows } = await service.rpc("party_payment_by_cashfree_order", { p_order_id: orderId });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return jsonRes({ error: "No matching payment record" }, 404);
      if (row.customer_id !== uid) return jsonRes({ error: "Not your payment" }, 403);

      const { data: s } = await service.from("platform_settings").select("cashfree_mode").limit(1).maybeSingle();
      const preferred: Mode = s?.cashfree_mode === "production" ? "production" : "sandbox";
      const envs = envsPreferring(preferred, (n) => Deno.env.get(n));
      if (envs.length === 0) return jsonRes({ error: "Cashfree keys are not set up yet." }, 503);

      const r = await confirmOrderAnyEnv(envs, orderId, (fn, args) => service.rpc(fn, args) as any);
      if (r.status === "paid") return jsonRes({ verified: true, result: "paid" });
      if (r.status === "pending") return jsonRes({ verified: false, pending: true, message: "Your payment is still being confirmed. This page will update shortly." });
      if (r.status === "error") {
        console.error("party-cashfree verify", r.message);
        return jsonRes({ verified: false, pending: true, message: "We couldn't reach the payment provider just now. If money was taken, your seats will confirm automatically." });
      }
      if (r.order_status.startsWith("late payment")) {
        return jsonRes({ verified: true, result: "late", message: "Your payment arrived after the seats could no longer be kept. A full refund is being arranged." });
      }
      if (r.order_status === "amount mismatch" || r.order_status === "duplicate payment id") {
        return jsonRes({ verified: false, error: "We couldn't match this payment to your booking. If money was taken, PAXO will check it and refund you." });
      }
      return jsonRes({ verified: false, error: "The payment was not completed. You have not been charged for these seats." });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("party-cashfree", String(err));
    return jsonRes({ error: "Something went wrong with the payment." }, 500);
  }
});

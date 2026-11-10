import { createClient } from "jsr:@supabase/supabase-js@2";

// party-payment (verify_jwt = true): the ONE place a party payment is created and verified.
// All rules (seats, genders, 30% / 100%, 10-minute hold, balance) live in the database function party_start_payment;
// this file only asks Razorpay for an order for the row the database created, and verifies the payment afterwards.
// Same Razorpay keys and the same signature check as the booking flow. Normal bookings never come through here.
//   { action: "create", party_id, kind: "join" | "balance", guests?: [{name, age, gender}], accept_terms?: bool, terms_version?: int }
//   { action: "verify", razorpay_order_id, razorpay_payment_id, razorpay_signature }

const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
if (!RAZORPAY_KEY_ID) throw new Error("RAZORPAY_KEY_ID secret is not set");
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rzpAuth = () => "Basic " + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);

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

    if (body.action === "create") {
      // the database checks every rule as the signed-in customer and holds the seats
      const { data: pay, error } = await caller.rpc("party_start_payment", {
        p_party_id: body.party_id,
        p_kind: body.kind,
        p_guests: Array.isArray(body.guests) ? body.guests : null,
        p_accept: body.accept_terms === true,
        p_terms_version: Number.isInteger(body.terms_version) ? body.terms_version : null,
      });
      if (error || !pay) return jsonRes({ error: error?.message ?? "Could not start the payment." }, 400);
      if (pay.provider !== "razorpay") {
        // the switch now says Cashfree: this function must not create a Razorpay order for a Cashfree payment row
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "The payment method just changed. Please try again." }, 409);
      }

      const amountPaise = Math.round(Number(pay.amount) * 100);
      const rzp = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { Authorization: rzpAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: `party_${Date.now()}_${String(pay.payment_id).slice(0, 8)}` }),
      });
      const order = await rzp.json();
      if (!rzp.ok) {
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "Razorpay order creation failed" }, 502);
      }
      const { error: attErr } = await service.rpc("party_attach_order", { p_payment_id: pay.payment_id, p_order_id: order.id });
      if (attErr) {
        await service.rpc("party_release_payment", { p_payment_id: pay.payment_id });
        return jsonRes({ error: "Failed to record the payment" }, 500);
      }
      return jsonRes({
        order_id: order.id, amount: amountPaise, currency: "INR", key_id: RAZORPAY_KEY_ID,
        payment_id: pay.payment_id, kind: pay.kind, seats: pay.seats, held_until: pay.held_until,
      });
    }

    if (body.action === "verify") {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return jsonRes({ error: "Missing required fields" }, 400);
      const { data: rows } = await service.rpc("party_payment_by_order", { p_order_id: razorpay_order_id });
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return jsonRes({ error: "No matching payment record" }, 404);
      if (row.customer_id !== uid) return jsonRes({ error: "Not your payment" }, 403);
      const expected = await hmacSha256Hex(RAZORPAY_KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`);
      if (expected !== razorpay_signature) return jsonRes({ verified: false, error: "Signature mismatch" }, 400);

      // ask Razorpay for the real amount and fee; the database compares the amount with what it asked for
      const pr = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, { headers: { Authorization: rzpAuth() } });
      if (!pr.ok) return jsonRes({ verified: true, pending: true });   // the webhook will finish it
      const p = await pr.json();
      if (p.order_id !== razorpay_order_id) return jsonRes({ error: "Payment does not belong to this order" }, 400);
      if (p.status !== "captured") return jsonRes({ verified: true, pending: true });
      const hasFee = typeof p.fee === "number" && p.fee > 0;
      const { data: res, error } = await service.rpc("party_confirm_payment", {
        p_order_id: razorpay_order_id,
        p_razorpay_payment_id: razorpay_payment_id,
        p_amount_paise: p.amount,
        p_fee: hasFee ? p.fee / 100 : null,
        p_tax: hasFee ? (typeof p.tax === "number" ? p.tax : 0) / 100 : null,
      });
      if (error) return jsonRes({ error: "Could not record the payment" }, 500);
      return jsonRes({ verified: true, result: res?.result, party_confirmed: !!res?.party_confirmed });
    }

    return jsonRes({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonRes({ error: String(err) }, 500);
  }
});

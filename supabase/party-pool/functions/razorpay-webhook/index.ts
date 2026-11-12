// razorpay-webhook (verify_jwt = false). Razorpay calls this directly; the ONLY protection is the Razorpay signature.
//
// Order of work: (1) check the signature of the RAW body (HMAC SHA-256, constant-time compare) before anything else,
// (2) store the event once (razorpay_events, unique event id), (3) apply it in the database (razorpay_apply_event),
// (4) only when a late or duplicate payment must be refunded, call Razorpay's refund API and record the outcome.
// All money / booking rules live in the SQL functions; this file never writes a table itself.
// 200 only once the event is stored and handled. Any failure inside returns 500 so Razorpay retries (about 24 hours).
// The webhook secret is read from the RAZORPAY_WEBHOOK_SECRET secret and is never logged or returned.

type RpcResult = { data: any; error: { message: string } | null };
export interface Deps {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  fetch: typeof fetch;
  webhookSecret: string | undefined;
  keyId: string | undefined;
  keySecret: string | undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// crypto.subtle.verify compares the HMAC in constant time.
async function signatureOk(secret: string, raw: Uint8Array, header: string | null): Promise<boolean> {
  const sig = (header ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, hexToBytes(sig), raw);
}

// Full refund of a late / duplicate payment. Low Razorpay balance leaves it pending for payments-maintenance to retry.
async function startRefund(deps: Deps, refund: { payment_id: string; razorpay_payment_id: string; amount_paise: number }) {
  let ok = false, refundId: string | null = null, error: string | null = null, low = false;
  try {
    const auth = btoa(`${deps.keyId}:${deps.keySecret}`);
    const res = await deps.fetch(`https://api.razorpay.com/v1/payments/${refund.razorpay_payment_id}/refund`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: refund.amount_paise }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      ok = true;
      refundId = body.id ?? null;
    } else {
      error = String(body?.error?.description ?? "Refund failed");
      low = /balance/i.test(error);
    }
  } catch (e) {
    error = "Could not reach Razorpay: " + String(e);
  }
  const { error: dbErr } = await deps.rpc("razorpay_finish_refund", {
    p_payment_id: refund.payment_id,
    p_ok: ok,
    p_refund_id: refundId,
    p_error: error,
    p_low_balance: low,
  });
  if (dbErr) throw new Error("razorpay_finish_refund failed: " + dbErr.message);
  return ok ? "refund processed" : low ? "refund pending (low balance)" : "refund pending (will retry)";
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (!deps.webhookSecret) return json({ ok: false, error: "webhook not configured" }, 500);

  // 1. signature of the raw body, before anything is parsed or stored
  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await signatureOk(deps.webhookSecret, raw, req.headers.get("x-razorpay-signature")))) {
    return json({ ok: false, error: "invalid signature" }, 401);
  }
  // A missing key id must fail loudly (Razorpay will retry once it is set).
  if (!deps.keyId || !deps.keySecret) return json({ ok: false, error: "Razorpay keys not configured" }, 500);

  try {
    let event: any;
    try {
      event = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ ok: false, error: "invalid body" }, 400);
    }
    const eventId = req.headers.get("x-razorpay-event-id");
    const type = typeof event?.event === "string" ? event.event : null;
    if (!eventId || !type) return json({ ok: false, error: "missing event id or type" }, 400);

    // 2. store once
    const rec = await deps.rpc("razorpay_record_event", { p_event_id: eventId, p_type: type, p_payload: event });
    if (rec.error) throw new Error("record failed: " + rec.error.message);
    if (rec.data === "done") return json({ ok: true, duplicate: true });

    // 2b. Party Pool payments: the database decides whether this event belongs to a party order. If it does, it is
    // applied there and the booking logic below is skipped. For any other event it returns handled=false and changes
    // nothing, so normal bookings run exactly as before.
    const party = await deps.rpc("party_apply_event", { p_event_id: eventId });
    if (party.error) throw new Error("party apply failed: " + party.error.message);
    if (party.data?.handled) {
      console.log(JSON.stringify({ event_id: eventId, type, result: party.data.result }));
      return json({ ok: true, result: party.data.result });
    }

    // 3. apply in the database
    const applied = await deps.rpc("razorpay_apply_event", { p_event_id: eventId });
    if (applied.error) throw new Error("apply failed: " + applied.error.message);
    let result: string = applied.data?.result ?? "applied";

    // 4. refund a late / duplicate payment (the row is already 'pending', so payments-maintenance covers a crash here)
    if (applied.data?.refund) result += "; " + (await startRefund(deps, applied.data.refund));

    console.log(JSON.stringify({ event_id: eventId, type, result }));
    return json({ ok: true, result });
  } catch (e) {
    console.error("razorpay-webhook error:", String(e));
    return json({ ok: false, error: "processing failed" }, 500);
  }
}

if (typeof (globalThis as any).Deno !== "undefined" && (globalThis as any).Deno.serve) {
  (globalThis as any).Deno.serve(async (req: Request) => {
    // secrets are read on every request, so a secret set after deployment is picked up without a redeploy
    const { createClient } = await import("jsr:@supabase/supabase-js@2");
    const env = (globalThis as any).Deno.env;
    const db = createClient(env.get("SUPABASE_URL")!, env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    return handle(req, {
      rpc: (fn, args) => db.rpc(fn, args) as unknown as Promise<RpcResult>,
      fetch: (...a) => fetch(...a),
      webhookSecret: env.get("RAZORPAY_WEBHOOK_SECRET"),
      keyId: env.get("RAZORPAY_KEY_ID"),
      keySecret: env.get("RAZORPAY_KEY_SECRET"),
    });
  });
}

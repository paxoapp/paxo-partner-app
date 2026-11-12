import { createClient } from "jsr:@supabase/supabase-js@2";
import { envsPreferring, processWebhook, type Mode } from "./cashfree.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const raw = await req.text();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: s } = await supabase.from("platform_settings").select("cashfree_mode").limit(1).maybeSingle();
  const preferred: Mode = s?.cashfree_mode === "production" ? "production" : "sandbox";
  const r = await processWebhook({
    raw,
    ts: req.headers.get("x-webhook-timestamp"),
    sig: req.headers.get("x-webhook-signature"),
    envs: envsPreferring(preferred, (n) => Deno.env.get(n)),
    rpc: (fn, args) => supabase.rpc(fn, args) as any,
  });
  if (r.status >= 500) console.error("cashfree-webhook", r.status, r.text);
  return new Response(r.text, { status: r.status });
});

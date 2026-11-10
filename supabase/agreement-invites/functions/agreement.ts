// Shared by the two agreement edge functions (agreement-public, admin-agreement-invite). Each function is deployed
// with its own copy of this file. The agreement text below must match src/agreementText.jsx word for word
// (agreement-text-test.cjs checks that).
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export const VERSION = "v2";
export const COUNTERPARTY = "M/S PAXO, a proprietorship of Sushil Kumar";
export const INTRO = "By continuing, you agree to the following terms as a PAXO venue partner:";
export const ITEMS: [string, string][] = [
  ["What PAXO is.", "PAXO is a booking platform connecting customers to venues. PAXO facilitates bookings, collects deposits, and processes settlements — your venue remains the actual service provider for every booking."],
  ["Your packages.", "You are responsible for honoring the food & beverage packages exactly as you've configured them, including all listed quotas and categories, for every confirmed booking."],
  ["Extra guests.", "If the number of guests attending exceeds the confirmed headcount, you may charge the customer additional amounts based on the increased guest count, as per your own venue policy — this is collected by you directly and is not calculated or collected by PAXO."],
  ["Platform fee.", "PAXO charges you a platform fee on each booking. It is calculated on the package value of the booking before taxes, by the total booking value: 5% below ₹1 lakh, 7% from ₹1 lakh up to below ₹2 lakh, and 10% at ₹2 lakh and above. The percentage applies to the whole booking value. The fee amount is fixed when the customer pays the deposit. It is a separate charge between PAXO and you, and customers never see it. PAXO collects it from you after the event, by the method PAXO tells you in advance, for example auto-debit from your bank account or a payment link, and gives you a receipt."],
  ["Deposits & refunds.", "A booking made more than 72 hours before the event takes a 20% deposit, which the customer can get back by the cancellation schedule (100% more than 72 hours before the event, 50% from 72 down to 48 hours, nothing after). A booking made within 72 hours takes a 50% deposit that is not refundable. If you decline, do not respond, cancel, or do not honour a booking, the customer gets back everything they paid. The remaining balance is paid directly to you by the customer at the venue."],
  ["Billing.", "You are responsible for issuing a proper bill/invoice to the customer for every booking, including GST, VAT, and any other applicable taxes or service charges. The remaining balance is collected by you from the customer at the venue, in the way you choose, such as UPI, cash or card. You alone are responsible for tax and legal compliance on everything you collect, and PAXO takes no responsibility for it."],
  ["Cancellations.", "You cannot cancel a confirmed booking yourself. If you need to cancel, contact PAXO Support — cancellations initiated this way refund the customer in full and no payout is made to you for that booking."],
  ["Settlement & payout.", "PAXO holds each deposit and shows its status on the booking. A deposit becomes ready to be released to you 48 hours before the event (Standard booking) or after the event (Late booking), and never before the payment has settled with the payment gateway. PAXO then pays it to your bank account. The customer's check-in code at the event marks the booking as attended. From that point, serving the customer and collecting the balance are your responsibility."],
  ["Responding to requests.", "You must accept or decline booking requests within the response window shown for each request. Repeated non-response (not decline — decline is always fine) will place your venue on hold until PAXO reactivates it."],
  ["Conduct & liability.", "PAXO is not responsible for any misconduct, misbehavior, disputes, or illegal activity occurring at your venue or during any event, by any party. You are solely responsible for the safety, legality, and conduct of your venue and event operations."],
  ["Changes and ending.", "Either side can end this agreement by writing to the other, email is fine, with 30 days' notice. Bookings already confirmed will still be honoured. PAXO may update this agreement by giving you notice, and the updated version applies to bookings made after that notice."],
];

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function istText(iso: string | Date): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }) + " IST";
}

// --- the PDF -------------------------------------------------------------------------------------------------
// The built-in PDF fonts cannot draw the rupee sign, so it is written "Rs." in the PDF. Anything else the font
// cannot draw is replaced with "?" (nothing in the agreement text needs that).
const WIN_EXTRA = new Set("—–‘’“”•…€™".split(""));
function pdfSafe(s: string): string {
  return s.replace(/₹/g, "Rs. ").split("").map((c) => (c.charCodeAt(0) <= 255 || WIN_EXTRA.has(c) ? c : "?")).join("").replace(/[\r\n\t]+/g, " ");
}

export type Acceptance = {
  acceptance_id: string; venue_name: string; name: string; designation: string; email: string; accepted_at: string;
  ip_address?: string | null; device_info?: string | null;
};

export async function buildPdf(a: Acceptance): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 54, maxW = W - 2 * M;
  const ink = rgb(0.09, 0.05, 0.04), grey = rgb(0.4, 0.36, 0.34);
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const need = (h: number) => { if (y - h < M + 20) { page = pdf.addPage([W, H]); y = H - M; } };

  // words with their font, wrapped to maxW (indent for list text)
  const flow = (parts: { t: string; f: typeof reg }[], size: number, indent = 0, color = ink, lead = size * 1.45) => {
    const words: { w: string; f: typeof reg }[] = [];
    for (const p of parts) for (const w of pdfSafe(p.t).split(" ").filter(Boolean)) words.push({ w, f: p.f });
    let line: { w: string; f: typeof reg }[] = [];
    const widthOf = (ws: typeof line) => ws.reduce((n, x, i) => n + x.f.widthOfTextAtSize(x.w, size) + (i ? reg.widthOfTextAtSize(" ", size) : 0), 0);
    const flush = () => {
      if (!line.length) return;
      need(lead);
      let x = M + indent;
      line.forEach((wd, i) => {
        if (i) x += reg.widthOfTextAtSize(" ", size);
        page.drawText(wd.w, { x, y: y - size, size, font: wd.f, color });
        x += wd.f.widthOfTextAtSize(wd.w, size);
      });
      y -= lead;
      line = [];
    };
    for (const wd of words) {
      if (line.length && widthOf([...line, wd]) > maxW - indent) flush();
      line.push(wd);
    }
    flush();
  };
  const gap = (h: number) => { y -= h; };

  page.drawText("PAXO", { x: M, y: y - 20, size: 20, font: bold, color: rgb(0.96, 0.65, 0.14) });
  y -= 34;
  flow([{ t: "PAXO Partner Agreement", f: bold }], 18);
  gap(2);
  flow([{ t: `Version ${VERSION}`, f: reg }], 9, 0, grey);
  gap(8);
  flow([{ t: "Between: ", f: bold }, { t: `${COUNTERPARTY} ("PAXO")`, f: reg }], 10.5);
  flow([{ t: "And the venue: ", f: bold }, { t: a.venue_name, f: reg }], 10.5);
  gap(12);
  flow([{ t: INTRO, f: reg }], 10.5);
  gap(6);
  ITEMS.forEach(([title, body], i) => {
    need(40);
    flow([{ t: `${i + 1}. ${title}`, f: bold }, { t: body, f: reg }], 10, 0);
    gap(5);
  });

  gap(10);
  need(170);
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: rgb(0.8, 0.77, 0.75) });
  gap(10);
  flow([{ t: "Acceptance record", f: bold }], 12);
  gap(4);
  const rec: [string, string][] = [
    ["Accepted on behalf of", a.venue_name],
    ["Name", a.name],
    ["Designation", a.designation],
    ["Email", a.email],
    ["Date and time", istText(a.accepted_at)],
    ["Method", "Email link (no login)"],
    ["IP address", a.ip_address || "not recorded"],
    ["Device", (a.device_info || "not recorded").slice(0, 160)],
    ["Reference", a.acceptance_id],
  ];
  for (const [k, v] of rec) flow([{ t: `${k}: `, f: bold }, { t: v, f: reg }], 9.5);
  gap(6);
  flow([{ t: `${a.name} confirmed that they are authorised to accept this agreement on behalf of ${a.venue_name} and accepted it.`, f: reg }], 9.5, 0, grey);

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const t = `PAXO Partner Agreement ${VERSION} — ${pdfSafe(a.venue_name).slice(0, 60)} — page ${i + 1} of ${pages.length}`;
    p.drawText(pdfSafe(t), { x: M, y: 28, size: 8, font: reg, color: grey });
  });
  return await pdf.save();
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// --- sending through send-transactional-email ----------------------------------------------------------------
export async function sendMail(payload: Record<string, unknown>): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (!secret) return false;
  try {
    const r = await fetch(`${url}/functions/v1/send-transactional-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

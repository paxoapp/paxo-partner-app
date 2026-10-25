import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// CHANGES vs the deployed version 10 (everything else is unchanged):
//   1. new template type "partner_dashboard_ready" (handover welcome email)
//   2. optional "idempotency_key" in the request, passed to Resend as the Idempotency-Key header, so a retried handover
//      can never produce a second email.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET");
const FROM = "PAXO <hello@mypaxo.in>";
const REPLY_TO = "support@mypaxo.in";
const APP_URL = "https://mypaxo.in";
const PARTNER_URL = "https://partner.mypaxo.in";

// Every value that comes from the database or a user (venue name, customer name, reason, dates, numbers)
// goes through esc() before it is placed in the HTML, so a name like <b>x</b> shows as plain text.
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// Subjects are plain text, not HTML: no escaping, but no line breaks either.
function oneLine(v: unknown): string {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim();
}

function wrap(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f5f1ee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1ee;padding:32px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#170D0B;padding:24px 32px;">
          <span style="color:#F5A623;font-size:22px;font-weight:800;letter-spacing:0.5px;">PAXO</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:20px;color:#170D0B;">${title}</h1>
          <div style="font-size:14px;line-height:1.6;color:#3a2e2a;">${bodyHtml}</div>
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f5f1ee;">
          <p style="margin:0;font-size:12px;color:#9a8a84;">PAXO — book venues without the wait.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

function btn(href: string, label: string) {
  return `<p style="margin:24px 0 0;"><a href="${href}" style="background:#F5A623;color:#170D0B;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:999px;display:inline-block;font-size:14px;">${label}</a></p>`;
}

type EmailTemplate = { subject: string; html: string };

function buildTemplate(type: string, data: Record<string, unknown>): EmailTemplate | null {
  switch (type) {
    case "customer_welcome": {
      const name = (data.name as string) || "there";
      return {
        subject: "Welcome to Paxo 🎉",
        html: wrap(
          `Welcome, ${esc(name)}!`,
          `<p>Your Paxo account is ready. Browse restaurants, bars, clubs and lounges near you and book your next party without the back-and-forth.</p>` +
            btn(APP_URL, "Browse venues")
        ),
      };
    }
    case "partner_venue_submitted": {
      const venueName = (data.venue_name as string) || "your venue";
      return {
        subject: `We've received "${oneLine(venueName)}" for review`,
        html: wrap(
          "Venue submitted for review",
          `<p>Thanks for submitting <strong>${esc(venueName)}</strong> to Paxo. Our team will review the details and get back to you shortly.</p>` +
            btn(PARTNER_URL, "View submission status")
        ),
      };
    }
    case "partner_venue_decision": {
      const venueName = (data.venue_name as string) || "your venue";
      const approved = data.status === "approved";
      const reason = (data.reason as string) || "";
      return {
        subject: approved ? `"${oneLine(venueName)}" is now live on Paxo 🎉` : `Update on "${oneLine(venueName)}"`,
        html: wrap(
          approved ? "Your venue is approved!" : "Your venue needs a small update",
          approved
            ? `<p><strong>${esc(venueName)}</strong> has been approved and is now visible to customers on Paxo.</p>` +
                btn(PARTNER_URL, "Manage your venue")
            : `<p><strong>${esc(venueName)}</strong> wasn't approved as submitted.</p>` +
                (reason ? `<p style="background:#f5f1ee;border-radius:8px;padding:12px 16px;"><strong>Reason:</strong> ${esc(reason)}</p>` : "") +
                `<p>You can update the details and resubmit any time.</p>` +
                btn(PARTNER_URL, "Update your venue")
        ),
      };
    }
    case "partner_dashboard_ready": {
      // Handover of a PAXO-managed venue. The link is the owner's one-time "set your password" link (made by the
      // handover function). Only a link on this project's own Supabase auth address is accepted.
      const venueName = (data.venue_name as string) || "your venue";
      const link = String(data.action_link ?? "");
      const okLink = /^https:\/\/[a-z0-9]+\.supabase\.co\/auth\/v1\/verify\?/i.test(link);
      if (!okLink) return null;
      return {
        subject: `Welcome to PAXO — your dashboard for ${oneLine(venueName)} is ready`,
        html: wrap(
          "Welcome to PAXO!",
          `<p><strong>${esc(venueName)}</strong> is now listed on PAXO and your onboarding is complete.</p>` +
            `<p>Your dashboard is ready. You can manage booking requests, your menu and your packages there. Set your password to get in.</p>` +
            btn(esc(link), "Set my password") +
            `<p style="margin:24px 0 0;font-size:13px;color:#6b5b55;">This link works for a limited time. If it has expired, open <a href="${PARTNER_URL}" style="color:#170D0B;">partner.mypaxo.in</a> and choose “Forgot password”.</p>` +
            `<p style="font-size:13px;color:#6b5b55;">The first time you log in you will be asked to read and accept the PAXO Partner Agreement.</p>` +
            `<p style="font-size:13px;color:#6b5b55;">Questions? Write to <a href="mailto:support@mypaxo.in" style="color:#170D0B;">support@mypaxo.in</a>.</p>`
        ),
      };
    }
    case "booking_requested": {
      const venueName = (data.venue_name as string) || "your venue";
      const customerName = (data.customer_name as string) || "A customer";
      const date = (data.event_date as string) || "";
      const headcount = (data.headcount as number) || 0;
      return {
        subject: `New booking request — ${oneLine(venueName)}`,
        html: wrap(
          "New booking request",
          `<p><strong>${esc(customerName)}</strong> has requested to book <strong>${esc(venueName)}</strong>` +
            (date ? ` on <strong>${esc(date)}</strong>` : "") +
            (headcount ? ` for <strong>${esc(headcount)} guests</strong>` : "") +
            `.</p><p>Please respond within the response window shown in your dashboard.</p>` +
            btn(PARTNER_URL, "Respond to request")
        ),
      };
    }
    case "booking_decision": {
      const venueName = (data.venue_name as string) || "the venue";
      const accepted = data.status === "confirmed" || data.status === "accepted";
      return {
        subject: accepted ? `Booking confirmed — ${oneLine(venueName)} 🎉` : `Update on your booking request — ${oneLine(venueName)}`,
        html: wrap(
          accepted ? "Your booking is confirmed!" : "Booking request declined",
          accepted
            ? `<p>Your booking at <strong>${esc(venueName)}</strong> is confirmed. Check the app for full details and payment.</p>` +
                btn(APP_URL, "View booking")
            : `<p>Unfortunately <strong>${esc(venueName)}</strong> couldn't accept your request this time. Try another venue — there are plenty of great options on Paxo.</p>` +
                btn(APP_URL, "Browse other venues")
        ),
      };
    }
    case "booking_refund_processed": {
      const venueName = (data.venue_name as string) || "the venue";
      const eventDate = (data.event_date as string) || "";
      const refundAmount = (data.refund_amount as number) ?? 0;
      const refundPercent = (data.refund_percent as number) ?? 0;
      const isFullRefund = refundPercent >= 100;
      const isNoRefund = refundAmount <= 0;
      return {
        subject: isNoRefund
          ? `Booking cancelled — ${oneLine(venueName)}`
          : `Refund processed — ₹${oneLine(refundAmount)} for ${oneLine(venueName)}`,
        html: wrap(
          isNoRefund ? "Your booking has been cancelled" : "Your refund has been processed",
          `<p>Your booking at <strong>${esc(venueName)}</strong>` +
            (eventDate ? ` on <strong>${esc(eventDate)}</strong>` : "") +
            ` has been cancelled.</p>` +
            (isNoRefund
              ? `<p>Based on the cancellation timing, this booking wasn't eligible for a refund.</p>`
              : `<p>A refund of <strong>₹${esc(refundAmount)}</strong>` +
                  (isFullRefund ? "" : ` (${esc(refundPercent)}% of your deposit)`) +
                  ` has been initiated to your original payment method. It typically takes 5–7 business days to reflect.</p>`) +
            btn(APP_URL, "View booking")
        ),
      };
    }
    default:
      return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), { status: 405 });
  }

  if (!WEBHOOK_SECRET || req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "RESEND_API_KEY not configured" }), { status: 500 });
  }

  let payload: { type?: string; to?: string; data?: Record<string, unknown>; idempotency_key?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 400 });
  }

  const { type, to, data } = payload;
  if (!type || !to) {
    return new Response(JSON.stringify({ ok: false, error: "missing type or to" }), { status: 400 });
  }

  const template = buildTemplate(type, data || {});
  if (!template) {
    return new Response(JSON.stringify({ ok: false, error: `unknown type: ${type}` }), { status: 400 });
  }

  const idem = typeof payload.idempotency_key === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(payload.idempotency_key) ? payload.idempotency_key : null;
  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idem ? { "Idempotency-Key": idem } : {}),
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      reply_to: REPLY_TO,
      subject: template.subject,
      html: template.html,
    }),
  });

  const resendBody = await resendRes.text();

  return new Response(
    JSON.stringify({ ok: resendRes.ok, status: resendRes.status, resend: resendBody }),
    { status: resendRes.ok ? 200 : 502, headers: { "Content-Type": "application/json" } }
  );
});

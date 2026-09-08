import { useState, useRef, useEffect, useCallback } from "react";
import { sb } from "./supabase";

/**
 * Email OTP verification for NEW partner signups only (not returning-user login).
 *
 * This screen only ever appears when the Supabase project has "Confirm email" ON
 * (i.e. `/auth/v1/signup` returns no session). For it to actually work end to end,
 * THREE dashboard-only things must be done — none of them live in this repo:
 *
 *   1. Authentication → Sign In/Providers → Email: turn "Confirm email" back ON.
 *   2. Authentication → Emails → "Confirm signup" template: replace
 *      {{ .ConfirmationURL }} with {{ .Token }} so the email carries a 6-digit
 *      code instead of a magic link.
 *   3. Configure a real SMTP provider — the shared Supabase test mailer is rate
 *      limited to a few messages per hour and is unusable for real signups.
 *
 * Until all three are done the project stays in "Confirm email OFF" mode, signup
 * returns a session immediately, and this component is simply never mounted.
 */

const RESEND_COOLDOWN = 45; // seconds
const OTP_LENGTH = 6;

export default function OtpVerification({ email, onVerified, onBack }) {
  const [digits, setDigits] = useState(Array(OTP_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN);
  const inputs = useRef([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  const code = digits.join("");
  const complete = code.length === OTP_LENGTH;

  function setDigit(i, val) {
    const clean = val.replace(/\D/g, "");
    if (!clean) {
      setDigits((d) => d.map((x, idx) => (idx === i ? "" : x)));
      return;
    }
    setDigits((d) => {
      const next = [...d];
      // If the user pasted / typed multiple chars, spread them across boxes.
      for (let k = 0; k < clean.length && i + k < OTP_LENGTH; k++) {
        next[i + k] = clean[k];
      }
      return next;
    });
    const landing = Math.min(i + clean.length, OTP_LENGTH - 1);
    inputs.current[landing]?.focus();
  }

  function onKeyDown(i, e) {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  }

  const verify = useCallback(
    async (e) => {
      e?.preventDefault();
      if (!complete || verifying) return;
      setVerifying(true);
      setError("");
      try {
        const data = await sb("/auth/v1/verify", {
          method: "POST",
          body: { type: "signup", email, token: code },
        });
        if (!data?.access_token) throw new Error("Verification failed — please try again.");
        // Session is now real — hand it back so the app can proceed to Stage 1.
        await onVerified(data.access_token, data.user);
      } catch (err) {
        setError(err.message || "That code didn't work. Check it and try again.");
        setDigits(Array(OTP_LENGTH).fill(""));
        inputs.current[0]?.focus();
      } finally {
        setVerifying(false);
      }
    },
    [complete, verifying, email, code, onVerified]
  );

  async function resend() {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError("");
    try {
      await sb("/auth/v1/resend", { method: "POST", body: { type: "signup", email } });
      setCooldown(RESEND_COOLDOWN);
    } catch (err) {
      const msg = String(err.message || "");
      if (/rate|limit|too many|seconds/i.test(msg)) {
        setError("Too many attempts, please wait a few minutes before requesting another code.");
        setCooldown(RESEND_COOLDOWN);
      } else {
        setError(msg || "Couldn't resend the code.");
      }
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-900 via-stone-950 to-stone-900 text-white flex flex-col justify-center px-6 py-16">
      <div className="max-w-sm mx-auto w-full">
        <button className="text-sm text-stone-400 mb-6" onClick={onBack}>
          ← Back
        </button>
        <h1 className="font-black text-3xl mb-1">Verify your email</h1>
        <p className="text-stone-400 text-sm mb-6">
          We sent a 6-digit code to <span className="text-stone-200">{email}</span>.
        </p>

        <form onSubmit={verify} className="flex flex-col gap-4">
          <div className="flex gap-2 justify-between">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => (inputs.current[i] = el)}
                inputMode="numeric"
                autoComplete={i === 0 ? "one-time-code" : "off"}
                maxLength={OTP_LENGTH}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                className="w-11 h-14 text-center text-xl font-semibold bg-stone-900 border border-white/10 rounded-xl text-white focus:outline-none focus:border-accent"
              />
            ))}
          </div>

          {error && <p className="text-rose-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={!complete || verifying}
            className="bg-accent text-[#170D0B] rounded-full px-5 py-3.5 text-sm font-semibold disabled:opacity-50"
          >
            {verifying ? "Verifying…" : "Verify"}
          </button>
        </form>

        <p className="text-center text-stone-500 text-sm mt-6">
          Didn't get it?{" "}
          {cooldown > 0 ? (
            <span className="text-stone-500">Resend in {cooldown}s</span>
          ) : (
            <button className="text-accent font-medium" onClick={resend} disabled={resending}>
              {resending ? "Sending…" : "Resend code"}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

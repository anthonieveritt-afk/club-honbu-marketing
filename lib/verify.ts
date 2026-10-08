import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Double opt-in for /get-started (email confirmation before anything is provisioned).
//
// On when SIGNUP_VERIFY_SECRET (32+ chars) is set: new sign-ups are stored as
// 'pending_verification' and emailed a signed, expiring link to /get-started/confirm.
// Only a confirmed sign-up becomes 'new' and can be auto-approved (AUTO_APPROVE_SIGNUPS)
// or approved by hand. Unconfirmed sign-ups expire after SIGNUP_VERIFY_TTL_HOURS (48).
// Without the secret, behaviour is exactly as before (status 'new', no auto-approve).
//
// Token: "<id>.<expiresUnix>.<base64url HMAC-SHA256(secret, confirm:<id>:<exp>:<email>)>".
// Nothing is stored for the token; it is bound to the sign-up id, its email and its expiry.

export function verifySecret(): string | null {
  const s = process.env.SIGNUP_VERIFY_SECRET || "";
  return s.length >= 32 ? s : null;
}

export function verificationEnabled(): boolean {
  return verifySecret() !== null;
}

export function verifyTtlHours(): number {
  const n = Number(process.env.SIGNUP_VERIFY_TTL_HOURS || 48);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

function sign(secret: string, id: string, exp: number, email: string): string {
  return createHmac("sha256", secret).update(`confirm:${id}:${exp}:${email.trim().toLowerCase()}`).digest("base64url");
}

export function makeConfirmToken(id: string, email: string, expiresAt: Date): string {
  const secret = verifySecret();
  if (!secret) throw new Error("SIGNUP_VERIFY_SECRET is not set");
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${id}.${exp}.${sign(secret, id, exp, email)}`;
}

/** Cheap structural parse (no DB). The signature is checked against the stored email in checkConfirmToken. */
export function parseConfirmToken(token: string): { id: string; exp: number; sig: string } | null {
  const m = /^(\d{1,18})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/.exec(String(token || "").trim());
  return m ? { id: m[1], exp: Number(m[2]), sig: m[3] } : null;
}

export type TokenCheck = "ok" | "invalid" | "expired";

export function checkConfirmToken(token: string, email: string, now = Date.now()): TokenCheck {
  const secret = verifySecret();
  const p = parseConfirmToken(token);
  if (!secret || !p) return "invalid";
  const want = Buffer.from(sign(secret, p.id, p.exp, email));
  const got = Buffer.from(p.sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "invalid";
  return p.exp * 1000 < now ? "expired" : "ok";
}

export function confirmUrl(token: string): string {
  const base = (process.env.SITE_URL || "https://clubhonbu.co.uk").replace(/\/$/, "");
  return `${base}/get-started/confirm?t=${encodeURIComponent(token)}`;
}

/**
 * Automated tests only: with SIGNUP_TEST_MODE=1 the form response includes the confirmation link
 * for addresses on reserved test domains (RFC 2606/6761: example.com/.net/.org, *.test, *.example,
 * *.invalid, *.localhost), which can never belong to a real person. Never active on Vercel production.
 */
export function testBypassAllowed(email: string): boolean {
  if (process.env.SIGNUP_TEST_MODE !== "1") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  const domain = String(email).trim().toLowerCase().split("@")[1] || "";
  return /^(.+\.)?example\.(com|net|org)$/.test(domain) || /\.(test|example|invalid|localhost)$/.test(domain);
}

/** Staging only: SIGNUP_LOG_CONFIRM_LINKS=1 writes the confirmation link to the server log (no email provider yet). */
export function logConfirmLinks(): boolean {
  return process.env.SIGNUP_LOG_CONFIRM_LINKS === "1" && process.env.VERCEL_ENV !== "production";
}

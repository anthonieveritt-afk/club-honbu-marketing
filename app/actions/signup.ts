"use server";

import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { getPool } from "@/lib/db";
import { autoApproveEnabled, checkRateLimit, hashIp, insertSignup, markNotified } from "@/lib/signups";
import { confirmUrl, logConfirmLinks, makeConfirmToken, testBypassAllowed, verificationEnabled, verifyTtlHours } from "@/lib/verify";

export type SignupState =
  | { status: "idle" }
  | {
      status: "success";
      clubName: string;
      /** Double opt-in: a confirmation link was emailed (or logged) and must be used first. */
      verify?: { email: string; hours: number };
      /** Automated tests only (SIGNUP_TEST_MODE=1 + reserved test domain): the link itself. */
      testConfirmUrl?: string;
    }
  | { status: "error"; message: string; fieldErrors?: Record<string, string> };

export interface SignupFormData {
  clubName: string;
  sportType: string;
  contactName: string;
  email: string;
  website: string;
  adminUsername: string;
  password: string;
  confirmPassword: string;
  /** Honeypot: hidden from people, bots tend to fill it. Must be empty. */
  company?: string;
  /** Milliseconds between the form loading and submit (bot timing check). */
  elapsedMs?: number;
}

const SPORT_TYPES = [
  "Martial Arts",
  "Football",
  "Netball",
  "Rugby",
  "Dance",
  "Gymnastics",
  "General",
];

function validateFields(data: SignupFormData): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!data.clubName.trim()) errors.clubName = "Club name is required.";
  else if (data.clubName.length > 120) errors.clubName = "Club name is too long.";
  if (!SPORT_TYPES.includes(data.sportType))
    errors.sportType = "Please select a sport type.";
  if (!data.contactName.trim()) errors.contactName = "Your name is required.";
  else if (data.contactName.length > 120) errors.contactName = "Name is too long.";
  if (data.website && data.website.length > 300) errors.website = "Website address is too long.";
  if (!data.email.trim()) {
    errors.email = "Email address is required.";
  } else if (data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    errors.email = "Please enter a valid email address.";
  }
  if (!data.adminUsername.trim()) {
    errors.adminUsername = "Preferred admin username is required.";
  } else if (!/^[a-z0-9_-]{3,30}$/.test(data.adminUsername.toLowerCase())) {
    errors.adminUsername =
      "Username must be 3–30 characters and contain only letters, numbers, hyphens, or underscores.";
  }
  if (!data.password) {
    errors.password = "Password is required.";
  } else if (data.password.length < 8) {
    errors.password = "Password must be at least 8 characters.";
  } else if (data.password.length > 72) {
    // bcrypt only uses the first 72 bytes
    errors.password = "Password must be 72 characters or fewer.";
  }
  if (!data.confirmPassword) {
    errors.confirmPassword = "Please confirm your password.";
  } else if (data.password !== data.confirmPassword) {
    errors.confirmPassword = "Passwords don't match.";
  }

  return errors;
}

const NOTIFY_TO = () => process.env.SIGNUP_NOTIFY_TO || "anthonieveritt@gmail.com";
// Until clubhonbu.co.uk is verified in Resend, only Resend's test sender works, and it can only
// deliver to the Resend account owner's own address (fine for the internal notification).
const FROM = () => process.env.RESEND_FROM || "Club Honbu <onboarding@resend.dev>";
const MIN_FILL_MS = 3000;

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[signup] RESEND_API_KEY not set. Email skipped:", opts.subject);
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM(),
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Resend error ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function clientIp(): string {
  const h = headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function submitSignup(data: SignupFormData): Promise<SignupState> {
  // Normalise
  data = {
    ...data,
    clubName: String(data.clubName ?? "").trim(),
    sportType: String(data.sportType ?? ""),
    contactName: String(data.contactName ?? "").trim(),
    email: String(data.email ?? "").trim(),
    website: String(data.website ?? "").trim(),
    adminUsername: String(data.adminUsername ?? "").trim().toLowerCase(),
    password: String(data.password ?? ""),
    confirmPassword: String(data.confirmPassword ?? ""),
  };

  // Bot checks: pretend success so bots learn nothing; store nothing.
  const honeypotFilled = !!(data.company && String(data.company).trim());
  const tooFast = typeof data.elapsedMs === "number" && data.elapsedMs < MIN_FILL_MS;
  if (honeypotFilled || tooFast) {
    console.warn("[signup] Dropped likely bot submission", { honeypotFilled, tooFast });
    return { status: "success", clubName: data.clubName || "your club" };
  }

  // Validate
  const fieldErrors = validateFields(data);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", message: "Please fix the errors below.", fieldErrors };
  }

  const ipHash = hashIp(clientIp());
  const userAgent = headers().get("user-agent") || "";

  // Store (the source of truth). Without a database we fall back to the email alone.
  let signupId: string | null = null;
  let storeError: unknown = null;
  // Double opt-in when SIGNUP_VERIFY_SECRET is set: nothing is approved until the link is used.
  const verify = verificationEnabled();
  const verifyExpiresAt = verify ? new Date(Date.now() + verifyTtlHours() * 3600_000) : null;
  if (getPool()) {
    try {
      const allowed = await checkRateLimit(ipHash, data.email);
      if (!allowed) {
        return {
          status: "error",
          message:
            "We've had several sign-ups from you recently. Please wait an hour and try again, or email hello@clubhonbu.co.uk.",
        };
      }
      const passwordHash = await bcrypt.hash(data.password, 12);
      signupId = await insertSignup({
        clubName: data.clubName,
        sportType: data.sportType,
        contactName: data.contactName,
        email: data.email,
        website: data.website,
        adminUsername: data.adminUsername,
        passwordHash,
        ipHash,
        userAgent,
        verifyExpiresAt,
      });
    } catch (err) {
      storeError = err;
      console.error("[signup] Failed to store sign-up:", err);
    }
  } else {
    console.error("[signup] DATABASE_URL not set: sign-up cannot be stored.");
  }

  // AUTO_APPROVE_SIGNUPS=1 only ever acts on a CONFIRMED email (app/actions/confirm.ts). Without
  // SIGNUP_VERIFY_SECRET there is no confirmation, so sign-ups wait for manual approval.
  if (signupId && autoApproveEnabled() && !verify) {
    console.warn(`[signup] AUTO_APPROVE_SIGNUPS is on but SIGNUP_VERIFY_SECRET is not set: #${signupId} left for manual approval`);
  }
  const autoApproved: string | null = null;

  // Confirmation link (double opt-in).
  let link: string | null = null;
  if (signupId && verify && verifyExpiresAt) {
    link = confirmUrl(makeConfirmToken(signupId, data.email, verifyExpiresAt));
    if (logConfirmLinks()) console.log(`[signup] confirmation link for #${signupId} (${data.email}): ${link}`);
  }

  // Notify Club Honbu (never includes the password).
  const siteUrl = process.env.SITE_URL || "https://clubhonbu.co.uk";
  const internalHtml = `
    <h2>New Club Honbu sign-up${signupId ? ` #${signupId}` : ""}</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Club Name</strong></td><td>${escapeHtml(data.clubName)}</td></tr>
      <tr><td><strong>Sport Type</strong></td><td>${escapeHtml(data.sportType)}</td></tr>
      <tr><td><strong>Contact Name</strong></td><td>${escapeHtml(data.contactName)}</td></tr>
      <tr><td><strong>Email</strong></td><td>${escapeHtml(data.email)}</td></tr>
      <tr><td><strong>Website</strong></td><td>${data.website ? escapeHtml(data.website) : "—"}</td></tr>
      <tr><td><strong>Admin Username</strong></td><td>${escapeHtml(data.adminUsername)}</td></tr>
    </table>
    <p style="font-family:sans-serif;font-size:14px;">${
      signupId
        ? `Saved.${verify ? " Waiting for the club to confirm its email address; nothing is built until then." : ""}${autoApproved ? ` <strong>${escapeHtml(autoApproved)}</strong>: the trial club is being built now.` : ""} View all sign-ups: <a href="${siteUrl}/admin/signups">${siteUrl}/admin/signups</a>`
        : `<strong>NOT saved to the database</strong> (${storeError ? "database error" : "DATABASE_URL not set"}). This email is the only record; the chosen password was not kept.`
    }</p>
    <p style="margin-top:16px;color:#5C5C5C;font-size:12px;">Submitted via clubhonbu.co.uk/get-started</p>
  `;
  const internalText = `New Club Honbu sign-up${signupId ? ` #${signupId}` : ""}\n\nClub: ${data.clubName}\nSport: ${data.sportType}\nContact: ${data.contactName}\nEmail: ${data.email}\nWebsite: ${data.website || "—"}\nUsername: ${data.adminUsername}\n\n${signupId ? `Saved.${verify ? " Waiting for the club to confirm its email address." : ""}${autoApproved ? ` ${autoApproved}: the trial club is being built now.` : ""} ${siteUrl}/admin/signups` : "NOT saved to the database. This email is the only record."}\n`;

  const notifyResult = await sendEmail({
    to: NOTIFY_TO(),
    subject: `New club sign-up: ${data.clubName}`,
    html: internalHtml,
    text: internalText,
    replyTo: data.email,
  });
  if (notifyResult.ok && signupId) {
    await markNotified(signupId).catch((err) => console.error("[signup] markNotified failed:", err));
  } else if (!notifyResult.ok && !notifyResult.skipped) {
    console.error("[signup] Failed to send internal notification:", notifyResult.error);
  }

  // Honesty: only report success if the sign-up landed somewhere we will see it.
  if (!signupId && !notifyResult.ok) {
    return {
      status: "error",
      message:
        "Sorry, we couldn't save your sign-up just now. Please try again in a few minutes, or email hello@clubhonbu.co.uk.",
    };
  }

  // Email to the club. Needs our own domain verified in Resend (RESEND_FROM set), because Resend's
  // test sender cannot deliver to other people's addresses.
  const canEmailClub = !!process.env.RESEND_FROM;
  if (link && verifyExpiresAt) {
    const hours = verifyTtlHours();
    const confirmHtml = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A;">
        <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">Confirm your email, ${escapeHtml(data.contactName)}</h1>
        <p style="color:#5C5C5C;margin-bottom:24px;">Thanks for signing up <strong>${escapeHtml(data.clubName)}</strong> for a 7-day Club Honbu trial. Please confirm this is your email address and we'll build your club straight away.</p>
        <p style="margin:28px 0;"><a href="${escapeHtml(link)}" style="background:#0A0A0A;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;">Confirm my email</a></p>
        <p style="color:#5C5C5C;font-size:13px;">The link works for ${hours} hours. If you didn't sign up, ignore this email and nothing will happen.</p>
        <p style="color:#5C5C5C;font-size:12px;word-break:break-all;">${escapeHtml(link)}</p>
        <hr style="border:none;border-top:1px solid #E8E2D7;margin:28px 0;" />
        <p style="font-size:12px;color:#5C5C5C;">Club Honbu · <a href="https://clubhonbu.co.uk" style="color:#0066cc;">clubhonbu.co.uk</a></p>
      </div>
    `;
    const confirmText = `Hi ${data.contactName},\n\nThanks for signing up ${data.clubName} for a 7-day Club Honbu trial. Please confirm your email address and we'll build your club straight away:\n\n${link}\n\nThe link works for ${hours} hours. If you didn't sign up, ignore this email and nothing will happen.\n\n— The Club Honbu team\nhttps://clubhonbu.co.uk`;
    if (canEmailClub) {
      const r = await sendEmail({
        to: data.email,
        subject: `Confirm your email to start your Club Honbu trial`,
        html: confirmHtml,
        text: confirmText,
        replyTo: process.env.SIGNUP_REPLY_TO || "hello@clubhonbu.co.uk",
      });
      if (!r.ok && !r.skipped) console.error("[signup] Failed to send confirmation-link email:", r.error);
    } else if (!logConfirmLinks()) {
      console.warn(`[signup] RESEND_FROM not set: confirmation link for #${signupId} not emailed (admin can mark it confirmed)`);
    }
    return {
      status: "success",
      clubName: data.clubName,
      verify: { email: data.email, hours },
      ...(testBypassAllowed(data.email) ? { testConfirmUrl: link } : {}),
    };
  }

  if (canEmailClub) {
    const confirmHtml = `
      <div style="font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A;">
        <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">Thanks, ${escapeHtml(data.contactName)}.</h1>
        <p style="color:#5C5C5C;margin-bottom:24px;">We've received your Club Honbu sign-up for <strong>${escapeHtml(data.clubName)}</strong>. We'll set up your account and email your login details shortly. Your 7-day free trial starts when your club is ready.</p>
        <p style="color:#5C5C5C;">If you have any questions in the meantime, just reply to this email.</p>
        <hr style="border:none;border-top:1px solid #E8E2D7;margin:28px 0;" />
        <p style="font-size:12px;color:#5C5C5C;">Club Honbu · <a href="https://clubhonbu.co.uk" style="color:#0066cc;">clubhonbu.co.uk</a></p>
      </div>
    `;
    const confirmText = `Hi ${data.contactName},\n\nThanks — we've received your Club Honbu sign-up for ${data.clubName}. We'll set up your account and email your login details shortly. Your 7-day free trial starts when your club is ready.\n\nIf you have any questions, just reply to this email.\n\n— The Club Honbu team\nhttps://clubhonbu.co.uk`;
    const confirmResult = await sendEmail({
      to: data.email,
      subject: `We've received your Club Honbu sign-up`,
      html: confirmHtml,
      text: confirmText,
      replyTo: process.env.SIGNUP_REPLY_TO || "hello@clubhonbu.co.uk",
    });
    if (!confirmResult.ok && !confirmResult.skipped) {
      console.error("[signup] Failed to send confirmation email:", confirmResult.error);
    }
  }

  return { status: "success", clubName: data.clubName };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

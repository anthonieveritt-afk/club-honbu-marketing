"use server";

export type SignupState =
  | { status: "idle" }
  | { status: "success"; clubName: string }
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
  if (!SPORT_TYPES.includes(data.sportType))
    errors.sportType = "Please select a sport type.";
  if (!data.contactName.trim()) errors.contactName = "Your name is required.";
  if (!data.email.trim()) {
    errors.email = "Email address is required.";
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
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
  }
  if (!data.confirmPassword) {
    errors.confirmPassword = "Please confirm your password.";
  } else if (data.password !== data.confirmPassword) {
    errors.confirmPassword = "Passwords don't match.";
  }

  return errors;
}

async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // No email service configured — log and continue gracefully in dev
    console.warn("[signup] RESEND_API_KEY not set. Email skipped:", opts.subject, "→", opts.to);
    return { ok: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Club Honbu <hello@clubhonbu.co.uk>",
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
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

export async function submitSignup(data: SignupFormData): Promise<SignupState> {
  // Validate
  const fieldErrors = validateFields(data);
  if (Object.keys(fieldErrors).length > 0) {
    return { status: "error", message: "Please fix the errors below.", fieldErrors };
  }

  // Send internal notification to Club Honbu team
  const internalHtml = `
    <h2>New Club Honbu Sign-Up</h2>
    <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Club Name</strong></td><td>${escapeHtml(data.clubName)}</td></tr>
      <tr><td><strong>Sport Type</strong></td><td>${escapeHtml(data.sportType)}</td></tr>
      <tr><td><strong>Contact Name</strong></td><td>${escapeHtml(data.contactName)}</td></tr>
      <tr><td><strong>Email</strong></td><td>${escapeHtml(data.email)}</td></tr>
      <tr><td><strong>Website</strong></td><td>${data.website ? escapeHtml(data.website) : "—"}</td></tr>
      <tr><td><strong>Admin Username</strong></td><td>${escapeHtml(data.adminUsername)}</td></tr>
    </table>
    <p style="margin-top:16px;color:#5C5C5C;font-size:12px;">Submitted via clubhonbu.co.uk/get-started</p>
  `;
  const internalText = `New Club Honbu Sign-Up\n\nClub: ${data.clubName}\nSport: ${data.sportType}\nContact: ${data.contactName}\nEmail: ${data.email}\nWebsite: ${data.website || "—"}\nUsername: ${data.adminUsername}\n`;

  const notifyResult = await sendEmail({
    to: "hello@clubhonbu.co.uk",
    subject: `New club sign-up: ${data.clubName}`,
    html: internalHtml,
    text: internalText,
  });

  if (!notifyResult.ok) {
    console.error("[signup] Failed to send internal notification:", notifyResult.error);
    // Don't fail the whole submission — log and continue
  }

  // Send confirmation to the club
  const confirmHtml = `
    <div style="font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A;">
      <h1 style="font-size:24px;font-weight:600;margin-bottom:8px;">You're on the list, ${escapeHtml(data.contactName)}.</h1>
      <p style="color:#5C5C5C;margin-bottom:24px;">Thanks for signing up to Club Honbu. We're setting up <strong>${escapeHtml(data.clubName)}</strong>'s account and you'll receive your login details within 24 hours.</p>
      <p style="color:#5C5C5C;">While you wait, feel free to reply to this email if you have any questions — we're real people and we'll get back to you quickly.</p>
      <hr style="border:none;border-top:1px solid #E8E2D7;margin:28px 0;" />
      <p style="font-size:12px;color:#5C5C5C;">Club Honbu · <a href="https://clubhonbu.co.uk" style="color:#0066cc;">clubhonbu.co.uk</a></p>
    </div>
  `;
  const confirmText = `Hi ${data.contactName},\n\nThanks for signing up to Club Honbu. We're setting up ${data.clubName}'s account and you'll receive your login details within 24 hours.\n\nIf you have any questions, just reply to this email.\n\n— The Club Honbu team\nhttps://clubhonbu.co.uk`;

  const confirmResult = await sendEmail({
    to: data.email,
    subject: `We're setting up your Club Honbu account`,
    html: confirmHtml,
    text: confirmText,
  });

  if (!confirmResult.ok) {
    console.error("[signup] Failed to send confirmation email:", confirmResult.error);
    // Still treat as success — the signup was received
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

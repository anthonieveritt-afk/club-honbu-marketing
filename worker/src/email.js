// Resend sender, used only when WELCOME_EMAIL_ENABLED=1. Injectable fetch.
export function createResendClient({ apiKey, fetchImpl = fetch }) {
  return {
    async send({ from, to, replyTo, subject, text, html, idempotencyKey }) {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text, html }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return body.id;
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function welcomeEmail({ contactName, clubName, instanceUrl, adminUsername, trialEndsAt }) {
  const ends = new Date(trialEndsAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  const login = `${instanceUrl}/admin/login`;
  const text = `Hi ${contactName},

${clubName} is ready on Club Honbu.

Sign in: ${login}
Username: ${adminUsername}
Password: the one you chose when you signed up (we never store or send it).

Your free trial runs until ${ends}. Reply to this email if you need a hand.

— The Club Honbu team
https://clubhonbu.co.uk`;
  const html = `<div style="font-family:Inter,ui-sans-serif,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A">
<h1 style="font-size:22px">${esc(clubName)} is ready on Club Honbu</h1>
<p>Hi ${esc(contactName)},</p>
<p><a href="${esc(login)}" style="color:#0066cc">Sign in at ${esc(login)}</a><br>Username: <strong>${esc(adminUsername)}</strong><br>Password: the one you chose when you signed up (we never store or send it).</p>
<p>Your free trial runs until <strong>${esc(ends)}</strong>. Just reply if you need a hand.</p>
<p style="font-size:12px;color:#5C5C5C">Club Honbu · clubhonbu.co.uk</p></div>`;
  return { subject: `${clubName} is ready on Club Honbu`, text, html };
}

// ── trial lifecycle emails (queued in outbound_emails; sent only when EMAILS_ENABLED=1) ──
const ukDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
const ukTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

function wrap(title, paras) {
  const html = `<div style="font-family:Inter,ui-sans-serif,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A">
<h1 style="font-size:22px">${esc(title)}</h1>
${paras.map((p) => `<p>${p.html ?? esc(p)}</p>`).join("\n")}
<p style="font-size:12px;color:#5C5C5C">Club Honbu · clubhonbu.co.uk</p></div>`;
  const text = `${paras.map((p) => p.text ?? p).join("\n\n")}\n\n— The Club Honbu team\nhttps://clubhonbu.co.uk`;
  return { html, text };
}

function upgradeLine({ upgradeUrl, contactEmail }) {
  return upgradeUrl
    ? { text: `Subscribe to keep your club: ${upgradeUrl}`, html: `<a href="${esc(upgradeUrl)}" style="display:inline-block;background:#0A0A0A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Subscribe</a>` }
    : { text: `To keep using Club Honbu, just reply to this email (or write to ${contactEmail}).`, html: `To keep using Club Honbu, just reply to this email (or write to ${esc(contactEmail)}).` };
}

export function reminderEmail({ contactName, clubName, instanceUrl, trialEndsAt, daysLeft, graceDays, upgradeUrl, contactEmail }) {
  const when = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
  const subject = `Your Club Honbu trial ends ${when}`;
  const { html, text } = wrap(subject, [
    `Hi ${contactName},`,
    `The free trial for ${clubName} ends ${when}, on ${ukDate(trialEndsAt)} at ${ukTime(trialEndsAt)} (UK time).`,
    { text: `Sign in: ${instanceUrl}/admin/login`, html: `<a href="${esc(instanceUrl)}/admin/login" style="color:#0066cc">Sign in to ${esc(clubName)}</a>` },
    upgradeLine({ upgradeUrl, contactEmail }),
    `If you don't upgrade, your account becomes read-only when the trial ends and everything is permanently deleted ${graceDays} days later.`,
  ]);
  return { subject, text, html };
}

export function expiredEmail({ contactName, clubName, trialEndsAt, teardownAfter, upgradeUrl, contactEmail }) {
  const subject = `Your Club Honbu trial has ended`;
  const { html, text } = wrap(subject, [
    `Hi ${contactName},`,
    `The free trial for ${clubName} ended on ${ukDate(trialEndsAt)}. Your account is now read-only.`,
    `Your data is kept until ${ukDate(teardownAfter)}. After that the club, its database and its web address are permanently deleted.`,
    upgradeLine({ upgradeUrl, contactEmail }),
  ]);
  return { subject, text, html };
}

export function removedEmail({ contactName, clubName, contactEmail }) {
  const subject = `Your Club Honbu trial club has been deleted`;
  const { html, text } = wrap(subject, [
    `Hi ${contactName},`,
    `As scheduled, the trial club ${clubName} and all of its data have now been permanently deleted from Club Honbu.`,
    `Thanks for trying Club Honbu. If you'd like to start again, reply to this email or write to ${contactEmail}.`,
  ]);
  return { subject, text, html };
}

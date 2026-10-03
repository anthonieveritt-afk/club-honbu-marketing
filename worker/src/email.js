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

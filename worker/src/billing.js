// Stripe Billing for Club Honbu trial clubs (TEST MODE first; nothing here is used by production yet).
//
//   trial reminder / "trial ended" email / locked club page ─▶ /subscribe?t=<token>   (marketing site)
//   ─▶ pick plan ─▶ POST /api/billing/checkout ─▶ Stripe Checkout (mode=subscription)
//   Stripe ─▶ POST /api/billing/webhook  (signature-checked, each event handled once)
//     checkout.session.completed / invoice.paid  ─▶ club 'converted' (paid): teardown cancelled,
//                                                  sync_trial job removes the trial lock from the club
//     invoice.payment_failed                      ─▶ billing 'past_due', grace until now + BILLING_GRACE_DAYS
//                                                  (club keeps working; email with "update card" link)
//     grace over and still unpaid (worker sweep)  ─▶ lapsed: back to 'expired' (locked now, the normal
//     customer.subscription.deleted               ─▶ TRIAL_GRACE_DAYS data-retention countdown, then teardown)
//   "Manage billing" ─▶ /api/billing/portal?t=<token> ─▶ Stripe Customer Portal
//
// Plain ESM with injected db ({ query }) + fetch, so the Next.js site and the worker's tests share it.
// Without STRIPE_SECRET_KEY everything degrades: no checkout (the page says "contact us"), webhook 503.
import { createHmac, timingSafeEqual } from "node:crypto";

const DAY = 86400000;

// ── plans (prices are PLACEHOLDERS copied from clubhonbu.co.uk; real prices live in Stripe) ────
export const PLANS = [
  { id: "starter", name: "Starter", monthlyGbp: 39, blurb: "For a single coach or instructor running one group or a small club." },
  { id: "club", name: "Club", monthlyGbp: 79, blurb: "For most clubs. Multiple coaches, full progression workflow, reporting.", highlight: true },
  { id: "association", name: "Association", monthlyGbp: 159, blurb: "For multi-club associations and federations running several sites." },
];
export const INTERVALS = ["month", "year"];

/** Stripe price for a plan: STRIPE_PRICE_<PLAN>_<MONTHLY|ANNUAL> (price_...) or lookup key clubhonbu_<plan>_<monthly|annual>. */
export function priceRef(env, plan, interval = "month") {
  const suffix = interval === "year" ? "ANNUAL" : "MONTHLY";
  const id = env[`STRIPE_PRICE_${plan.toUpperCase()}_${suffix}`];
  return id ? { priceId: id } : { lookupKey: `clubhonbu_${plan}_${suffix.toLowerCase()}` };
}

export function billingConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  const secretKey = env.STRIPE_SECRET_KEY || "";
  return {
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    enabled: Boolean(secretKey),
    liveKey: /^(sk|rk)_live_/.test(secretKey),
    allowLive: env.STRIPE_ALLOW_LIVE === "1",
    tokenSecret: (env.BILLING_TOKEN_SECRET || "").length >= 32 ? env.BILLING_TOKEN_SECRET : "",
    siteUrl: (env.BILLING_SITE_URL || env.SITE_URL || "https://clubhonbu.co.uk").replace(/\/$/, ""),
    graceDays: num(env.BILLING_GRACE_DAYS, 7),
    // after a lapse (cancelled / unpaid) the data is kept this long, like an expired trial
    retentionDays: num(env.TRIAL_GRACE_DAYS, 7),
    annualEnabled: env.BILLING_ANNUAL_ENABLED === "1",
    automaticTax: env.STRIPE_AUTOMATIC_TAX === "1",
    env,
  };
}

/** Refuses a live key unless STRIPE_ALLOW_LIVE=1 (this branch is test mode only). */
export function usableStripe(cfg) {
  return cfg.enabled && (!cfg.liveKey || cfg.allowLive);
}

// ── signed club links (no login needed; bound to the sign-up id, never expires, can't be guessed) ──
export function billingToken(secret, signupId) {
  const mac = createHmac("sha256", secret).update(`billing:${signupId}`).digest("base64url").slice(0, 32);
  return `${signupId}.${mac}`;
}
export function verifyBillingToken(secret, token) {
  if (!secret || typeof token !== "string") return null;
  const m = /^(\d{1,18})\.([A-Za-z0-9_-]{32})$/.exec(token.trim());
  if (!m) return null;
  const want = Buffer.from(billingToken(secret, m[1]).split(".")[1]);
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? m[1] : null;
}
export function subscribeUrl(cfg, signupId) {
  return cfg.tokenSecret ? `${cfg.siteUrl}/subscribe?t=${billingToken(cfg.tokenSecret, signupId)}` : "";
}
export function portalUrl(cfg, signupId) {
  return cfg.tokenSecret ? `${cfg.siteUrl}/api/billing/portal?t=${billingToken(cfg.tokenSecret, signupId)}` : "";
}

// ── minimal Stripe REST client (no SDK; form-encoded; injectable fetch for tests) ───────────────
export function formEncode(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join("&");
}

export function createStripeClient({ secretKey, fetchImpl = fetch, apiBase = "https://api.stripe.com/v1" }) {
  async function call(method, path, params, idempotencyKey) {
    const body = params && method !== "GET" ? formEncode(params) : undefined;
    const qs = params && method === "GET" ? `?${formEncode(params)}` : "";
    const res = await fetchImpl(`${apiBase}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`Stripe ${res.status}: ${json?.error?.message || "error"}`), { status: res.status, stripe: json?.error });
    return json;
  }
  return {
    call,
    async resolvePrice(ref) {
      if (ref.priceId) return ref.priceId;
      const r = await call("GET", "/prices", { active: "true", lookup_keys: [ref.lookupKey], limit: 1 });
      const p = r.data?.[0];
      if (!p) throw Object.assign(new Error(`No active Stripe price with lookup key ${ref.lookupKey}`), { status: 503 });
      return p.id;
    },
    createCheckoutSession: (params, key) => call("POST", "/checkout/sessions", params, key),
    createPortalSession: (params) => call("POST", "/billing_portal/sessions", params),
    getSubscription: (id) => call("GET", `/subscriptions/${encodeURIComponent(id)}`),
  };
}

// ── webhook signature (Stripe-Signature: t=..., v1=...) ───────────────────────────────────────
export function signPayload(secret, payload, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
export function verifyStripeSignature({ payload, header, secret, toleranceSec = 300, now = Date.now() }) {
  if (!secret) throw Object.assign(new Error("STRIPE_WEBHOOK_SECRET not set"), { status: 503 });
  const parts = String(header || "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) throw Object.assign(new Error("Bad Stripe-Signature header"), { status: 400 });
  if (Math.abs(now / 1000 - t) > toleranceSec) throw Object.assign(new Error("Stripe signature too old"), { status: 400 });
  const want = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  const ok = sigs.some((s) => { const b = Buffer.from(s); return b.length === want.length && timingSafeEqual(b, want); });
  if (!ok) throw Object.assign(new Error("Stripe signature mismatch"), { status: 400 });
  return JSON.parse(payload);
}

// ── DB helpers ─────────────────────────────────────────────────────────────────────────────────
async function tx(db, fn) {
  if (typeof db.connect !== "function") return fn((s, p) => db.query(s, p)); // already a client
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn((s, p) => c.query(s, p));
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
const ev = (q, id, step, message, level = "info") =>
  q(`INSERT INTO provisioning_events (signup_id, step, level, message) VALUES ($1,$2,$3,$4)`, [id, step, level, String(message).slice(0, 2000)]);
const queueSync = (q, id) => q(
  `INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, 'sync_trial')
   ON CONFLICT (signup_id, kind) DO UPDATE
      SET status = 'queued', attempts = 0, run_after = now(), state = '{}'::jsonb, last_error = NULL,
          finished_at = NULL, locked_by = NULL, locked_until = NULL, current_step = NULL, updated_at = now()
    WHERE provisioning_jobs.status IN ('queued','succeeded','failed','cancelled')`, [id]);
async function queueMail(q, id, kind, to, mail) {
  await q(`INSERT INTO outbound_emails (signup_id, kind, to_email, subject, body_text, body_html)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (signup_id, kind) DO NOTHING`, [id, kind, to, mail.subject, mail.text, mail.html]);
}

/** Can this club be sent to Checkout? Returns null or a human reason. */
export function checkoutBlocker(s) {
  if (!s) return "Club not found.";
  if (["removing", "removed"].includes(s.status)) return "This trial club has already been deleted. Reply to any Club Honbu email and we'll set you up again.";
  if (s.stripe_subscription_id && ["active", "trialing", "past_due"].includes(s.billing_status)) return "already_subscribed";
  if (!["trial_active", "expired", "converted"].includes(s.status)) return `This club isn't ready for a subscription yet (status ${s.status}).`;
  return null;
}

export async function getClub(db, id) {
  return (await db.query(
    `SELECT id, club_name, contact_name, email, status, slug, instance_url, trial_ends_at, teardown_after, converted_at,
            billing_status, billing_plan, billing_interval, stripe_customer_id, stripe_subscription_id,
            payment_grace_until, current_period_end FROM club_signups WHERE id = $1`, [id])).rows[0] || null;
}

/** Creates a Stripe Checkout Session (subscription mode) for a club; returns its URL. */
export async function createCheckout({ db, stripe, cfg, signupId, plan, interval = "month" }) {
  if (!PLANS.some((p) => p.id === plan)) throw Object.assign(new Error("Unknown plan"), { status: 400 });
  if (!INTERVALS.includes(interval) || (interval === "year" && !cfg.annualEnabled)) throw Object.assign(new Error("Unknown billing interval"), { status: 400 });
  const s = await getClub(db, signupId);
  const blocked = checkoutBlocker(s);
  if (blocked) throw Object.assign(new Error(blocked), { status: 409 });
  const price = await stripe.resolvePrice(priceRef(cfg.env, plan, interval));
  const t = billingToken(cfg.tokenSecret, s.id);
  const meta = { signup_id: String(s.id), slug: s.slug || "", plan, interval };
  const session = await stripe.createCheckoutSession({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: String(s.id),
    ...(s.stripe_customer_id ? { customer: s.stripe_customer_id } : { customer_email: s.email }),
    metadata: meta,
    subscription_data: { metadata: meta },
    allow_promotion_codes: "true",
    billing_address_collection: "required",
    ...(cfg.automaticTax ? { automatic_tax: { enabled: "true" }, tax_id_collection: { enabled: "true" }, ...(s.stripe_customer_id ? { customer_update: { address: "auto", name: "auto" } } : {}) } : {}),
    success_url: `${cfg.siteUrl}/subscribe/success?t=${t}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.siteUrl}/subscribe?t=${t}&cancelled=1`,
  }, `checkout-${s.id}-${plan}-${interval}-${Math.floor(Date.now() / 60000)}`);
  await ev((a, b) => db.query(a, b), s.id, "billing", `Checkout started: ${plan}/${interval} (session ${session.id})`);
  return session.url;
}

export async function createPortal({ db, stripe, cfg, signupId }) {
  const s = await getClub(db, signupId);
  if (!s?.stripe_customer_id) throw Object.assign(new Error("No Stripe customer for this club yet"), { status: 404 });
  const r = await stripe.createPortalSession({ customer: s.stripe_customer_id, return_url: `${cfg.siteUrl}/subscribe?t=${billingToken(cfg.tokenSecret, s.id)}` });
  return r.url;
}

// ── emails (queued in outbound_emails like every other lifecycle email) ───────────────────────
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function buttonHtml(url, label) {
  return `<a href="${esc(url)}" style="display:inline-block;background:#0A0A0A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a>`;
}
function mail(subject, paras) {
  const html = `<div style="font-family:Inter,ui-sans-serif,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#0A0A0A">
<h1 style="font-size:22px">${esc(subject)}</h1>
${paras.map((p) => `<p>${p.html ?? esc(p)}</p>`).join("\n")}
<p style="font-size:12px;color:#5C5C5C">Club Honbu · clubhonbu.co.uk</p></div>`;
  return { subject, html, text: `${paras.map((p) => p.text ?? p).join("\n\n")}\n\n— The Club Honbu team\nhttps://clubhonbu.co.uk` };
}
const ukDate = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });

// ── webhook handling ──────────────────────────────────────────────────────────────────────────
const signupIdOf = (o) => o?.metadata?.signup_id || o?.client_reference_id || o?.subscription_details?.metadata?.signup_id ||
  o?.parent?.subscription_details?.metadata?.signup_id || o?.lines?.data?.[0]?.metadata?.signup_id || null;
const subIdOf = (o) => (typeof o?.subscription === "string" ? o.subscription : o?.subscription?.id) ||
  o?.parent?.subscription_details?.subscription || null;
const custIdOf = (o) => (typeof o?.customer === "string" ? o.customer : o?.customer?.id) || null;

async function findClub(q, obj) {
  const id = signupIdOf(obj);
  if (id && /^\d+$/.test(String(id))) {
    const r = (await q(`SELECT * FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (r) return r;
  }
  const sub = obj?.object === "subscription" ? obj.id : subIdOf(obj);
  const cust = custIdOf(obj);
  if (!sub && !cust) return null;
  return (await q(`SELECT * FROM club_signups WHERE (stripe_subscription_id = $1 AND $1 IS NOT NULL) OR (stripe_customer_id = $2 AND $2 IS NOT NULL)
                    ORDER BY id LIMIT 1 FOR UPDATE`, [sub, cust])).rows[0] || null;
}

/** Marks the club paid. Never revives a deleted club (logged as an error for a manual refund). */
async function markPaid(q, s, { customer, subscription, plan, interval, periodEnd, via }, cfg) {
  if (["removing", "removed"].includes(s.status)) {
    // A started teardown is never stopped automatically (it may be half done).
    await q(`UPDATE club_signups SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id),
                    billing_status = 'active', updated_at = now() WHERE id = $1`, [s.id, customer, subscription]);
    await ev(q, s.id, "billing", `PAID (${via}) but club is ${s.status}: needs manual attention (restore or refund)`, "error");
    return "needs_attention";
  }
  // Cancel a teardown that hasn't started; one that has started is caught above (status removing).
  await q(`UPDATE provisioning_jobs SET status = 'cancelled', last_error = 'Cancelled: club subscribed', finished_at = now(), updated_at = now()
            WHERE signup_id = $1 AND kind = 'teardown' AND status IN ('queued','failed')`, [s.id]);
  const wasConverted = s.status === "converted";
  await q(`UPDATE club_signups
              SET status = 'converted', converted_at = COALESCE(converted_at, now()), teardown_after = NULL, removal_requested_at = NULL,
                  expired_at = NULL, billing_status = 'active', paid_at = COALESCE(paid_at, now()),
                  payment_failed_at = NULL, payment_grace_until = NULL,
                  stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id),
                  billing_plan = COALESCE($4, billing_plan), billing_interval = COALESCE($5, billing_interval),
                  current_period_end = COALESCE($6, current_period_end), updated_at = now()
            WHERE id = $1`, [s.id, customer, subscription, plan, interval, periodEnd]);
  // Always (re)sync: removes TRIAL_ENDS_AT so a locked club unlocks.
  if (!wasConverted || s.billing_status !== "active") await queueSync(q, s.id);
  if (!wasConverted || !s.paid_at) {
    await ev(q, s.id, "billing", `Subscribed (${via}): ${plan || s.billing_plan || "?"}/${interval || s.billing_interval || "?"}; club converted, lock and teardown cancelled`);
    const portal = portalUrl(cfg, s.id);
    await queueMail(q, s.id, "billing_subscribed", s.email, mail(`Welcome to Club Honbu, ${s.club_name}`, [
      `Hi ${s.contact_name},`,
      `Thanks for subscribing. ${s.club_name} is now a paid Club Honbu club, so the trial limits are gone and nothing will be deleted.`,
      ...(s.instance_url ? [{ text: `Your club: ${s.instance_url}`, html: `<a href="${esc(s.instance_url)}/admin/login" style="color:#0066cc">Sign in to ${esc(s.club_name)}</a>` }] : []),
      ...(portal ? [{ text: `Invoices, card and plan: ${portal}`, html: `Invoices, card and plan: <a href="${esc(portal)}" style="color:#0066cc">Manage billing</a>` }] : []),
    ]));
  } else if (s.billing_status === "past_due") {
    await ev(q, s.id, "billing", `Payment received (${via}); past-due grace cleared`);
  }
  return "paid";
}

/** The club goes back into the normal expiry path: locked now, data kept TRIAL_GRACE_DAYS, then teardown. */
export async function lapseClub(q, s, { reason, retentionDays, nowIso }, cfg) {
  if (s.status !== "converted" || !s.stripe_subscription_id) return false; // manual conversions are never touched
  await q(`UPDATE club_signups SET status = 'expired', converted_at = NULL, trial_ends_at = $2::timestamptz, expired_at = $2::timestamptz,
                  teardown_after = $2::timestamptz + ($3::numeric * interval '24 hours'), billing_status = $4, updated_at = now()
            WHERE id = $1`, [s.id, nowIso, String(retentionDays), reason === "canceled" ? "canceled" : "unpaid"]);
  await queueSync(q, s.id);
  const del = new Date(new Date(nowIso).getTime() + retentionDays * DAY);
  const url = subscribeUrl(cfg, s.id);
  await queueMail(q, s.id, `billing_lapsed:${nowIso}`, s.email, mail(`Your Club Honbu subscription has ended`, [
    `Hi ${s.contact_name},`,
    reason === "canceled" ? `The subscription for ${s.club_name} has been cancelled, so the club is now read-only.`
      : `We couldn't take payment for ${s.club_name}, so the club is now read-only.`,
    `Your data is kept until ${ukDate(del)}. After that the club, its database and its web address are permanently deleted.`,
    ...(url ? [{ text: `Subscribe again: ${url}`, html: buttonHtml(url, "Subscribe") }] : []),
  ]));
  await ev(q, s.id, "billing", `Subscription ${reason}: club locked; data kept until ${del.toISOString()}`, "warn");
  return true;
}

const unixIso = (t) => (t ? new Date(t * 1000).toISOString() : null);

/**
 * Handles one verified Stripe event. Idempotent: stripe_events records each event id once
 * (a crash before COMMIT means Stripe retries and we redo it). Returns a short outcome.
 */
/** @param {{ db: any, event: any, cfg: any, stripe?: any, now?: number }} args */
export async function handleStripeEvent({ db, event, cfg, stripe = null, now = Date.now() }) {
  return tx(db, async (q) => {
    const fresh = await q(`INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id`, [event.id, event.type]);
    if (!fresh.rowCount) return "duplicate";
    const o = event.data?.object || {};
    const nowIso = new Date(now).toISOString();
    const done = async (outcome, signupId = null) => {
      await q(`UPDATE stripe_events SET processed_at = now(), outcome = $2, signup_id = $3 WHERE id = $1`, [event.id, outcome, signupId]);
      return outcome;
    };
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (o.mode !== "subscription") return done("ignored:not_subscription");
        const s = await findClub(q, o);
        if (!s) return done("ignored:unknown_club");
        if (event.type === "checkout.session.completed" && o.payment_status === "unpaid") {
          // e.g. Bacs/SEPA: wait for async_payment_succeeded / invoice.paid
          await q(`UPDATE club_signups SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id), updated_at = now() WHERE id = $1`, [s.id, custIdOf(o), subIdOf(o)]);
          await ev(q, s.id, "billing", "Checkout completed; payment still processing");
          return done("pending_payment", s.id);
        }
        let periodEnd = null;
        if (stripe && subIdOf(o)) { try { const sub = await stripe.getSubscription(subIdOf(o)); periodEnd = unixIso(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end); } catch { /* optional */ } }
        return done(await markPaid(q, s, { customer: custIdOf(o), subscription: subIdOf(o), plan: o.metadata?.plan || null, interval: o.metadata?.interval || null, periodEnd, via: "checkout" }, cfg), s.id);
      }
      case "invoice.paid": {
        const s = await findClub(q, o);
        if (!s) return done("ignored:unknown_club");
        if (!subIdOf(o)) return done("ignored:not_subscription", s.id);
        const line = o.lines?.data?.[0];
        return done(await markPaid(q, s, { customer: custIdOf(o), subscription: subIdOf(o), plan: null, interval: null, periodEnd: unixIso(line?.period?.end), via: "invoice" }, cfg), s.id);
      }
      case "invoice.payment_failed": {
        const s = await findClub(q, o);
        if (!s) return done("ignored:unknown_club");
        if (s.status !== "converted" || !s.stripe_subscription_id) {
          await ev(q, s.id, "billing", `Payment failed while club is ${s.status}`, "warn");
          return done("noted", s.id);
        }
        const first = !s.payment_grace_until;
        await q(`UPDATE club_signups SET billing_status = 'past_due', payment_failed_at = COALESCE(payment_failed_at, $2::timestamptz),
                        payment_grace_until = COALESCE(payment_grace_until, $2::timestamptz + ($3::numeric * interval '24 hours')), updated_at = now()
                  WHERE id = $1`, [s.id, nowIso, String(cfg.graceDays)]);
        if (first) {
          const until = new Date(now + cfg.graceDays * DAY);
          const fix = portalUrl(cfg, s.id) || o.hosted_invoice_url || "";
          await queueMail(q, s.id, `billing_failed:${nowIso.slice(0, 10)}`, s.email, mail(`Payment failed for ${s.club_name}`, [
            `Hi ${s.contact_name},`,
            `We couldn't take this month's Club Honbu payment. Your club keeps working as normal while you sort it out.`,
            `Please update your card by ${ukDate(until)}. If payment still hasn't gone through by then, the club becomes read-only.`,
            ...(fix ? [{ text: `Update payment details: ${fix}`, html: buttonHtml(fix, "Update payment details") }] : []),
          ]));
        }
        await ev(q, s.id, "billing", `Payment failed (attempt ${o.attempt_count ?? "?"}); grace ${first ? "started" : "continues"}`, "warn");
        return done(first ? "past_due" : "past_due:repeat", s.id);
      }
      case "customer.subscription.deleted": {
        const s = await findClub(q, o);
        if (!s) return done("ignored:unknown_club");
        if (s.stripe_subscription_id && s.stripe_subscription_id !== o.id) return done("ignored:other_subscription", s.id);
        const lapsed = await lapseClub(q, s, { reason: "canceled", retentionDays: cfg.retentionDays, nowIso }, cfg);
        if (!lapsed) await q(`UPDATE club_signups SET billing_status = 'canceled', updated_at = now() WHERE id = $1`, [s.id]);
        return done(lapsed ? "lapsed" : "noted", s.id);
      }
      default:
        return done("ignored:type");
    }
  });
}

/** Worker sweep: past_due clubs whose grace ran out are locked (same path as a cancelled subscription). */
export async function sweepPaymentGrace({ db, cfg, now = Date.now(), retentionDays = cfg.retentionDays }) {
  const due = (await db.query(`SELECT id FROM club_signups WHERE status = 'converted' AND billing_status = 'past_due'
                                 AND payment_grace_until IS NOT NULL AND payment_grace_until <= $1`, [new Date(now).toISOString()])).rows;
  let n = 0;
  for (const { id } of due) {
    const ok = await tx(db, async (q) => {
      const s = (await q(`SELECT * FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!s || s.billing_status !== "past_due" || !s.payment_grace_until || new Date(s.payment_grace_until).getTime() > now) return false;
      return lapseClub(q, s, { reason: "unpaid", retentionDays, nowIso: new Date(now).toISOString() }, cfg);
    });
    if (ok) n++;
  }
  return n;
}

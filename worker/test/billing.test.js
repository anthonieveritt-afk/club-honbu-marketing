// Stripe Billing: checkout -> webhook -> paid (lock/teardown cancelled), failed payment grace, cancellation,
// customer portal. Real local Postgres (HQ tables), mocked Stripe (fetch) and mocked Railway; simulated clock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshHqDb, approvedSignup, testConfig } from "./helpers.js";
import { workOnce } from "../src/worker.js";
import { runLifecycleSweep } from "../src/lifecycle.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp } from "../src/fakes.js";
import {
  billingConfig, billingToken, verifyBillingToken, subscribeUrl, createStripeClient, createCheckout, createPortal,
  verifyStripeSignature, signPayload, handleStripeEvent, formEncode, priceRef, usableStripe,
} from "../src/billing.js";

const DAY = 86400000;
const quiet = () => {};
const SECRET = "billing-token-secret-billing-token-secret";
const WHSEC = "whsec_test_123";
let env;
before(async () => { env = await freshHqDb("bill"); });
after(async () => { await env.drop(); });
const one = async (q, p) => (await env.db.query(q, p)).rows[0];

const bcfg = (extra = {}) => billingConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_TOKEN_SECRET: SECRET,
  BILLING_SITE_URL: "https://clubhonbu.test", STRIPE_PRICE_CLUB_MONTHLY: "price_club_m", ...extra });
const wcfg = (b = bcfg()) => testConfig({ billing: b });

function clock(start = Date.now()) { let t = start; const now = () => t; now.set = (v) => { t = v; }; return now; }
function deps(now, railway = createFakeRailway()) {
  return { railway, cloudflare: createFakeCloudflare(), tenantDb: createFakeTenantDb(), httpStatus: createFakeHttp(), sleep: async () => {}, now };
}
async function drain(d, cfg) { for (let i = 0; i < 20; i++) if ((await workOnce({ store: env.store, deps: d, config: cfg, log: quiet })) === "idle") return; }

/** Mock Stripe API: records requests, answers like Stripe. */
function fakeStripe() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, body: init.body ? new URLSearchParams(init.body) : u.searchParams, headers: init.headers });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (u.pathname === "/v1/checkout/sessions") return ok({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    if (u.pathname === "/v1/billing_portal/sessions") return ok({ id: "bps_1", url: "https://billing.stripe.com/p/session/bps_1" });
    if (u.pathname === "/v1/prices") return u.searchParams.get("lookup_keys[0]") === "clubhonbu_starter_monthly" ? ok({ data: [{ id: "price_starter_lk" }] }) : ok({ data: [] });
    if (u.pathname.startsWith("/v1/subscriptions/")) return ok({ id: "sub_1", current_period_end: 1893456000 });
    return { ok: false, status: 404, json: async () => ({ error: { message: "nope" } }) };
  };
  return { calls, client: createStripeClient({ secretKey: "sk_test_x", fetchImpl }) };
}
const evt = (id, type, object) => ({ id, type, data: { object } });

async function trialClub(slug, now, d, cfg) {
  // earlier tests may leave unrelated jobs (e.g. a queued teardown): park them so this club provisions now
  await env.db.query(`UPDATE provisioning_jobs SET status='cancelled' WHERE status IN ('queued','running')`);
  const id = await approvedSignup(env.db, { slug, club: `Club ${slug}`, email: `${slug}@example.com` });
  await drain(d, cfg);
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "trial_active");
  return id;
}

test("tokens, form encoding, price refs, signature checks, live-key refusal", () => {
  const t = billingToken(SECRET, 42);
  assert.equal(verifyBillingToken(SECRET, t), "42");
  assert.equal(verifyBillingToken(SECRET, t.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), null);
  assert.equal(verifyBillingToken(SECRET, `43.${t.split(".")[1]}`), null);
  assert.equal(verifyBillingToken("", t), null);
  assert.equal(formEncode({ a: 1, line_items: [{ price: "p", quantity: 1 }], m: { x: "y z" } }), "a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&m%5Bx%5D=y%20z");
  assert.deepEqual(priceRef({ STRIPE_PRICE_CLUB_MONTHLY: "price_1" }, "club"), { priceId: "price_1" });
  assert.deepEqual(priceRef({}, "pro", "year"), { lookupKey: "clubhonbu_pro_annual" });
  const body = JSON.stringify({ id: "evt_1" });
  assert.equal(verifyStripeSignature({ payload: body, header: signPayload(WHSEC, body), secret: WHSEC }).id, "evt_1");
  assert.throws(() => verifyStripeSignature({ payload: body, header: signPayload("whsec_other", body), secret: WHSEC }), /mismatch/);
  assert.throws(() => verifyStripeSignature({ payload: body, header: signPayload(WHSEC, body, 1000), secret: WHSEC }), /too old/);
  assert.throws(() => verifyStripeSignature({ payload: body, header: "x", secret: "" }), /not set/);
  assert.equal(usableStripe(billingConfig({})), false, "no key: billing off");
  assert.equal(usableStripe(billingConfig({ STRIPE_SECRET_KEY: "rk_live_x" })), false, "live key refused on this branch");
  assert.equal(usableStripe(billingConfig({ STRIPE_SECRET_KEY: "rk_test_x" })), true);
  assert.equal(subscribeUrl(billingConfig({}), 1), "", "no token secret: no link (emails fall back to 'reply to upgrade')");
});

test("subscribe link goes into the club's TRIAL_UPGRADE_URL and every reminder/expiry email (Subscribe button)", async () => {
  const now = clock(); const railway = createFakeRailway(); const d = deps(now, railway); const cfg = wcfg();
  const id = await trialClub("sub-link", now, d, cfg);
  const url = subscribeUrl(cfg.billing, id);
  const svc = (await railway.listServices("proj_tenants")).find((s) => s.name === "club-sub-link");
  assert.equal((await railway.getVariables({ serviceId: svc.id })).TRIAL_UPGRADE_URL, url);
  const ends = new Date((await one("SELECT trial_ends_at FROM club_signups WHERE id=$1", [id])).trial_ends_at).getTime();
  now.set(ends - 1.5 * DAY); await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
  now.set(ends + 60000); await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
  const mails = (await env.db.query("SELECT kind, body_text, body_html FROM outbound_emails WHERE signup_id=$1 AND kind <> 'welcome' ORDER BY id", [id])).rows;
  assert.equal(mails.length, 2);
  for (const m of mails) { assert.ok(m.body_text.includes(url), m.kind); assert.match(m.body_html, />Subscribe<\/a>/); }
});

test("checkout session: subscription mode, metadata, existing customer reused, blocked states", async () => {
  const now = clock(); const d = deps(now); const cfg = wcfg();
  const id = await trialClub("checkout", now, d, cfg);
  const st = fakeStripe();
  const url = await createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "club" });
  assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_1");
  const b = st.calls.at(-1).body;
  assert.equal(b.get("mode"), "subscription");
  assert.equal(b.get("line_items[0][price]"), "price_club_m");
  assert.equal(b.get("client_reference_id"), String(id));
  assert.equal(b.get("metadata[signup_id]"), String(id));
  assert.equal(b.get("subscription_data[metadata][signup_id]"), String(id));
  assert.equal(b.get("customer_email"), "checkout@example.com");
  assert.ok(b.get("success_url").startsWith("https://clubhonbu.test/subscribe/success?t="));
  assert.ok(st.calls.at(-1).headers["Idempotency-Key"]);
  // lookup-key price
  await createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "starter" });
  assert.equal(st.calls.at(-1).body.get("line_items[0][price]"), "price_starter_lk");
  await assert.rejects(createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "association" }), /No active Stripe price/);
  await assert.rejects(createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "gold" }), /Unknown plan/);
  await assert.rejects(createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "club", interval: "year" }), /interval/, "annual off by default");
  await env.db.query("UPDATE club_signups SET stripe_customer_id='cus_9' WHERE id=$1", [id]);
  await createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "club" });
  assert.equal(st.calls.at(-1).body.get("customer"), "cus_9");
  await env.db.query("UPDATE club_signups SET status='removed' WHERE id=$1", [id]);
  await assert.rejects(createCheckout({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id, plan: "club" }), /deleted/);
});

test("paid: expired club unlocked, pending teardown cancelled, never torn down; events applied once", async () => {
  const now = clock(); const railway = createFakeRailway(); const d = deps(now, railway); const cfg = wcfg();
  const id = await trialClub("paid", now, d, cfg);
  const ends = new Date((await one("SELECT trial_ends_at FROM club_signups WHERE id=$1", [id])).trial_ends_at).getTime();
  now.set(ends + 8 * DAY); // expired + grace over -> teardown queued
  await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
  await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
  assert.equal((await one("SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id])).status, "queued");

  const st = fakeStripe();
  const e = evt("evt_paid_1", "checkout.session.completed", { object: "checkout.session", mode: "subscription", payment_status: "paid",
    client_reference_id: String(id), customer: "cus_1", subscription: "sub_1", metadata: { signup_id: String(id), plan: "club", interval: "month" } });
  assert.equal(await handleStripeEvent({ db: env.db, event: e, cfg: cfg.billing, stripe: st.client, now: now() }), "paid");
  assert.equal(await handleStripeEvent({ db: env.db, event: e, cfg: cfg.billing, stripe: st.client, now: now() }), "duplicate");
  const s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "converted"); assert.ok(s.converted_at); assert.equal(s.teardown_after, null);
  assert.equal(s.billing_status, "active"); assert.equal(s.billing_plan, "club"); assert.equal(s.stripe_subscription_id, "sub_1");
  assert.equal(new Date(s.current_period_end).getTime(), 1893456000 * 1000);
  assert.equal((await one("SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id])).status, "cancelled");
  await drain(d, cfg); // sync_trial removes the trial lock from the club
  const svc = (await railway.listServices("proj_tenants")).find((x) => x.name === "club-paid");
  assert.ok(svc, "service still exists");
  assert.equal("TRIAL_ENDS_AT" in (await railway.getVariables({ serviceId: svc.id })), false);
  now.set(now() + 60 * DAY);
  const r = await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
  assert.equal(r.teardownsQueued, 0);
  assert.ok(await one("SELECT 1 FROM outbound_emails WHERE signup_id=$1 AND kind='billing_subscribed'", [id]));
  // a later invoice.paid is a no-op apart from the period end
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_inv_2", "invoice.paid",
    { object: "invoice", customer: "cus_1", subscription: "sub_1", lines: { data: [{ period: { end: 1900000000 } }] } }) }), "paid");
  assert.equal((await one("SELECT count(*)::int n FROM outbound_emails WHERE signup_id=$1 AND kind='billing_subscribed'", [id])).n, 1);
});

test("unpaid async checkout waits for invoice.paid; unknown clubs and other modes are ignored", async () => {
  const now = clock(); const d = deps(now); const cfg = wcfg();
  const id = await trialClub("async", now, d, cfg);
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_a1", "checkout.session.completed",
    { mode: "subscription", payment_status: "unpaid", client_reference_id: String(id), customer: "cus_a", subscription: "sub_a", metadata: { signup_id: String(id) } }) }), "pending_payment");
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "trial_active");
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_a2", "invoice.paid",
    { object: "invoice", customer: "cus_a", subscription: "sub_a", lines: { data: [] } }) }), "paid");
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "converted");
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_a3", "checkout.session.completed", { mode: "payment" }) }), "ignored:not_subscription");
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_a4", "invoice.paid", { customer: "cus_zzz", subscription: "sub_zzz" }) }), "ignored:unknown_club");
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_a5", "customer.created", {}) }), "ignored:type");
});

test("failed payment: grace period, recovery, then lapse -> locked -> data kept -> teardown", async () => {
  const now = clock(); const railway = createFakeRailway(); const d = deps(now, railway); const cfg = wcfg();
  const id = await trialClub("grace", now, d, cfg);
  await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_g1", "checkout.session.completed",
    { mode: "subscription", payment_status: "paid", client_reference_id: String(id), customer: "cus_g", subscription: "sub_g", metadata: { signup_id: String(id), plan: "starter", interval: "month" } }) });
  await drain(d, cfg);
  const fail = (n) => evt(`evt_gf${n}`, "invoice.payment_failed", { object: "invoice", customer: "cus_g", subscription: "sub_g", attempt_count: n });
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: fail(1) }), "past_due");
  let s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "converted"); assert.equal(s.billing_status, "past_due");
  assert.equal(new Date(s.payment_grace_until).getTime(), now() + 7 * DAY);
  now.set(now() + 3 * DAY);
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: fail(2) }), "past_due:repeat");
  assert.equal(new Date((await one("SELECT payment_grace_until g FROM club_signups WHERE id=$1", [id])).g).getTime(), now() - 3 * DAY + 7 * DAY, "grace not extended by retries");
  // recovery
  await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_gp", "invoice.paid", { object: "invoice", customer: "cus_g", subscription: "sub_g" }) });
  s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.billing_status, "active"); assert.equal(s.payment_grace_until, null);
  // fails again and grace runs out
  await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: fail(3) });
  now.set(now() + 6 * DAY);
  assert.equal((await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet })).paymentLapsed, undefined, "still in grace");
  now.set(now() + 1.1 * DAY);
  assert.equal((await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet })).paymentLapsed, 1);
  s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "expired"); assert.equal(s.converted_at, null); assert.equal(s.billing_status, "unpaid");
  assert.equal(new Date(s.teardown_after).getTime(), now() + 7 * DAY);
  await drain(d, cfg);
  const svc = (await railway.listServices("proj_tenants")).find((x) => x.name === "club-grace");
  const vars = await railway.getVariables({ serviceId: svc.id });
  assert.equal(new Date(vars.TRIAL_ENDS_AT).getTime(), now(), "club locks itself now");
  assert.ok(vars.TRIAL_UPGRADE_URL.includes("/subscribe?t="));
  assert.ok(await one("SELECT 1 FROM outbound_emails WHERE signup_id=$1 AND kind LIKE 'billing_lapsed:%'", [id]));
  // paying again before teardown revives it
  await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_gp2", "invoice.paid", { object: "invoice", customer: "cus_g", subscription: "sub_g" }) });
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "converted");
});

test("subscription cancelled -> locked, teardown after retention; manual conversions untouched; deleted club never revived", async () => {
  const now = clock(); const d = deps(now); const cfg = wcfg();
  const id = await trialClub("cancel", now, d, cfg);
  await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_c1", "checkout.session.completed",
    { mode: "subscription", payment_status: "paid", client_reference_id: String(id), customer: "cus_c", subscription: "sub_c", metadata: { signup_id: String(id) } }) });
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_c2", "customer.subscription.deleted", { object: "subscription", id: "sub_c", customer: "cus_c", metadata: { signup_id: String(id) } }) }), "lapsed");
  let s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "expired"); assert.equal(s.billing_status, "canceled");
  now.set(now() + 7.1 * DAY);
  assert.equal((await runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet })).teardownsQueued, 1);

  // manual conversion (no Stripe) is never lapsed
  const m = await trialClub("manual", now, d, cfg);
  await env.db.query("UPDATE club_signups SET status='converted', converted_at=now() WHERE id=$1", [m]);
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_m1", "customer.subscription.deleted", { object: "subscription", id: "sub_m", metadata: { signup_id: String(m) } }) }), "noted");
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [m])).status, "converted");

  // payment for a club already being deleted: recorded, flagged, not revived
  const r = await trialClub("gone", now, d, cfg);
  await env.db.query("UPDATE club_signups SET status='removing' WHERE id=$1", [r]);
  assert.equal(await handleStripeEvent({ db: env.db, cfg: cfg.billing, now: now(), event: evt("evt_r1", "checkout.session.completed",
    { mode: "subscription", payment_status: "paid", client_reference_id: String(r), customer: "cus_r", subscription: "sub_r", metadata: { signup_id: String(r) } }) }), "needs_attention");
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [r])).status, "removing");
  assert.ok(await one("SELECT 1 FROM provisioning_events WHERE signup_id=$1 AND level='error' AND message LIKE 'PAID%'", [r]));
});

test("customer portal session for a paying club", async () => {
  const now = clock(); const d = deps(now); const cfg = wcfg();
  const id = await trialClub("billing-portal", now, d, cfg);
  const st = fakeStripe();
  await assert.rejects(createPortal({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id }), /No Stripe customer/);
  await env.db.query("UPDATE club_signups SET stripe_customer_id='cus_p' WHERE id=$1", [id]);
  assert.equal(await createPortal({ db: env.db, stripe: st.client, cfg: cfg.billing, signupId: id }), "https://billing.stripe.com/p/session/bps_1");
  assert.equal(st.calls.at(-1).body.get("customer"), "cus_p");
  assert.equal(st.calls.at(-1).body.get("return_url"), `https://clubhonbu.test/subscribe?t=${billingToken(SECRET, id)}`);
});

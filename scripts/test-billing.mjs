// HTTP check of the billing routes on a local build (no real Stripe calls succeed; webhook events are signed locally).
//   pnpm build
//   DATABASE_URL=postgres://postgres@127.0.0.1:5544/hq_billing STRIPE_SECRET_KEY=sk_test_fake STRIPE_WEBHOOK_SECRET=whsec_local \
//     BILLING_TOKEN_SECRET=<32+ chars> BILLING_SITE_URL=http://localhost:3103 pnpm start -p 3103 &
//   (same env) BASE_URL=http://localhost:3103 node scripts/test-billing.mjs
import assert from "node:assert/strict";
import pg from "pg";
import { billingToken, signPayload } from "../worker/src/billing.js";

const BASE = process.env.BASE_URL || "http://localhost:3103";
const URL_ = process.env.DATABASE_URL;
assert.ok(URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_), "DATABASE_URL must be a LOCAL throwaway database");
const SECRET = process.env.BILLING_TOKEN_SECRET, WH = process.env.STRIPE_WEBHOOK_SECRET;
const ok = (n) => console.log("PASS", n);
const db = new pg.Client({ connectionString: URL_ }); await db.connect();

const fs = await import("node:fs");
await db.query(fs.readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
const id = (await db.query(`INSERT INTO club_signups (club_name, sport_type, contact_name, email, admin_username, status, slug, trial_ends_at, expired_at, teardown_after, instance_url)
  VALUES ('Billing Dojo','Martial Arts','Bea','bea@example.com','bea','expired','billing-dojo', now() - interval '1 day', now() - interval '1 day', now() + interval '6 days', 'https://billing-dojo.clubhonbu.co.uk') RETURNING id`)).rows[0].id;
await db.query(`INSERT INTO provisioning_jobs (signup_id, kind, status) VALUES ($1,'teardown','queued')`, [id]);
const t = billingToken(SECRET, id);

let html = await (await fetch(`${BASE}/subscribe?t=nope`)).text();
assert.match(html, /subscribe-invalid/); ok("bad token -> invalid link page");
html = await (await fetch(`${BASE}/subscribe?t=${t}`)).text();
for (const p of ["starter", "club", "association"]) assert.match(html, new RegExp(`plan-${p}`));
assert.match(html, /Billing Dojo/); assert.match(html, /read-only/); ok("subscribe page lists 3 plans for the club");

const form = new URLSearchParams({ t, plan: "club", interval: "month" });
let r = await fetch(`${BASE}/api/billing/checkout`, { method: "POST", body: form, redirect: "manual" });
assert.equal(r.status, 303); assert.match(r.headers.get("location"), /error=(checkout|unavailable)/); ok("checkout with a fake key fails gracefully back to /subscribe");

const send = (obj, sig) => fetch(`${BASE}/api/billing/webhook`, { method: "POST", body: JSON.stringify(obj), headers: { "stripe-signature": sig ?? signPayload(WH, JSON.stringify(obj)) } });
const event = { id: `evt_http_${Date.now()}`, type: "checkout.session.completed", livemode: false, data: { object: { object: "checkout.session", mode: "subscription", payment_status: "paid",
  client_reference_id: String(id), customer: "cus_http", subscription: "sub_http", metadata: { signup_id: String(id), plan: "club", interval: "month" } } } };
assert.equal((await send(event, "t=1,v1=bad")).status, 400); ok("bad signature rejected");
r = await send(event); assert.equal(r.status, 200); assert.equal((await r.json()).outcome, "paid");
r = await send(event); assert.equal((await r.json()).outcome, "duplicate"); ok("signed webhook marks paid, once");
const s = (await db.query(`SELECT status, billing_status, teardown_after FROM club_signups WHERE id=$1`, [id])).rows[0];
assert.equal(s.status, "converted"); assert.equal(s.billing_status, "active"); assert.equal(s.teardown_after, null);
assert.equal((await db.query(`SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'`, [id])).rows[0].status, "cancelled");
assert.equal((await db.query(`SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='sync_trial'`, [id])).rows[0].status, "queued");
ok("club converted, teardown cancelled, unlock (sync_trial) queued");
html = await (await fetch(`${BASE}/subscribe?t=${t}`)).text();
assert.match(html, /billing-active/); assert.match(html, /Manage billing/); ok("subscribe page shows Manage billing");
await db.end();

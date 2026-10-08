// End-to-end check of the free-trial lifecycle WITHOUT payment, against a local build and a throwaway
// local Postgres, with FAKE Railway/Cloudflare/tenant-DB (nothing real is created or deleted):
//
//   /get-started sign-up ─▶ auto-approve (AUTO_APPROVE_SIGNUPS=1, slug from the club name, unique)
//   ─▶ worker provisions ─▶ 2-day + 1-day reminders ─▶ expiry ─▶ grace ─▶ teardown ─▶ removed
//   + admin actions on /admin/signups: Extend trial, Mark converted (never torn down), Delete now.
//
//   pnpm build
//   DATABASE_URL=postgres://postgres@127.0.0.1:5544/hq_e2e ADMIN_PASSWORD=... AUTO_APPROVE_SIGNUPS=1 pnpm start -p 3102 &
//   BASE_URL=http://localhost:3102 DATABASE_URL=... ADMIN_PASSWORD=... node scripts/test-trial-lifecycle.mjs
import assert from "node:assert/strict";
import pg from "pg";
import { chromium } from "playwright-core";
import { createPgStore } from "../worker/src/store.js";
import { workOnce, sendQueuedEmails } from "../worker/src/worker.js";
import { runLifecycleSweep } from "../worker/src/lifecycle.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp } from "../worker/src/fakes.js";
import { testConfig } from "../worker/test/helpers.js";

const BASE = process.env.BASE_URL || "http://localhost:3102";
const URL_ = process.env.DATABASE_URL;
assert.ok(URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_), "DATABASE_URL must be a LOCAL throwaway database");
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
assert.ok(ADMIN_PASS, "ADMIN_PASSWORD required");
const DAY = 86400000;
const ok = (n) => console.log("PASS", n);
const run = Date.now().toString(36).slice(-5);

const db = new pg.Client({ connectionString: URL_ });
await db.connect();
const one = async (q, p) => (await db.query(q, p)).rows[0];
const auth = { authorization: "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64") };
assert.equal((await fetch(`${BASE}/admin/signups`, { headers: auth })).status, 200); // applies the schema
await db.query(`TRUNCATE club_signups, provisioning_jobs, provisioning_events, outbound_emails, signup_attempts RESTART IDENTITY CASCADE`);

// Shared fakes + a simulated clock for the worker.
let t = Date.now();
const now = () => t;
const fakes = { railway: createFakeRailway(), cloudflare: createFakeCloudflare(), tenantDb: createFakeTenantDb(), httpStatus: createFakeHttp(), sleep: async () => {}, now };
const store = createPgStore({ connectionString: URL_ });
const config = testConfig();
const quiet = () => {};
const work = async () => { let r, n = 0; while ((r = await workOnce({ store, deps: fakes, config, log: quiet })) !== "idle" && n++ < 20) { /* drain */ } };
const sweep = () => runLifecycleSweep({ store, config, now: now(), log: quiet });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage();
async function signup(n, clubName) {
  await page.goto(`${BASE}/get-started`, { waitUntil: "networkidle" });
  const text0 = await page.innerText("main");
  assert.match(text0, /7-day trial/);
  assert.doesNotMatch(text0, /14-day/);
  await page.fill("#clubName", clubName);
  await page.selectOption("#sportType", "Martial Arts");
  await page.fill("#contactName", "Trial Tester");
  await page.fill("#email", `trial+${run}-${n}@example.com`);
  await page.fill("#adminUsername", `coach_${n}`);
  await page.fill("#password", `Trial-pass-${run}-${n}`);
  await page.fill("#confirmPassword", `Trial-pass-${run}-${n}`);
  await page.waitForTimeout(3200);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => /Thanks — we've got it|Something went wrong|couldn't save/.test(document.body.innerText), null, { timeout: 20000 });
  assert.match(await page.innerText("main"), /Thanks — we've got it/);
  return (await one(`SELECT * FROM club_signups WHERE email=$1`, [`trial+${run}-${n}@example.com`]));
}

// ── marketing copy ──
{
  const home = await (await fetch(`${BASE}/`)).text();
  assert.match(home, /7-day free trial/);
  assert.doesNotMatch(home, /14-day|14 days/);
  ok("home page and /get-started advertise a 7-day trial (no 14-day copy left)");
}

// ── 1. sign-up → auto-approve ──
const clubName = `Lifecycle Dojo ${run}`;
const slug = `lifecycle-dojo-${run}`;
let a = await signup(1, clubName);
assert.equal(a.status, "approved");
assert.equal(a.slug, slug);
assert.equal(a.auto_approved, true);
assert.equal((await one(`SELECT count(*)::int n FROM provisioning_jobs WHERE signup_id=$1 AND kind='provision' AND status='queued'`, [a.id])).n, 1);
ok(`sign-up auto-approved as ${slug} with one queued provisioning job`);

let b = await signup(2, clubName); // same club name again
assert.equal(b.slug, `${slug}-2`);
assert.equal(b.auto_approved, true);
ok("second sign-up with the same club name gets a unique subdomain (-2)");

// ── 2. provision both (fakes) ──
await work();
a = await one(`SELECT * FROM club_signups WHERE id=$1`, [a.id]);
b = await one(`SELECT * FROM club_signups WHERE id=$1`, [b.id]);
assert.equal(a.status, "trial_active"); assert.equal(b.status, "trial_active");
const ends = new Date(a.trial_ends_at).getTime();
assert.ok(Math.abs(ends - (Date.now() + 7 * DAY)) < 120000, "7-day trial");
assert.equal(fakes.railway._s.services.length, 2);
const svcA = fakes.railway._s.services.find((s) => s.name === `club-${slug}`);
assert.equal(fakes.railway._s.variables[svcA.id].TRIAL_ENDS_AT, new Date(a.trial_ends_at).toISOString());
ok("worker provisions both clubs: trial_active, TRIAL_ENDS_AT = now + 7 days on the instance");

const ctx = await browser.newContext({ httpCredentials: { username: "admin", password: ADMIN_PASS } });
const admin = await ctx.newPage();
await admin.setViewportSize({ width: 1700, height: 1000 });
const row = (id) => admin.locator(`tr[data-signup-id="${id}"]`);
const flash = async (kind, re) => {
  await admin.waitForFunction(([k, src]) => { const el = document.querySelector(`[data-testid="flash-${k}"]`); return el && new RegExp(src).test(el.textContent); }, [kind, re.source], { timeout: 15000 });
  return admin.innerText(`[data-testid="flash-${kind}"]`);
};
const open = () => admin.goto(`${BASE}/admin/signups`, { waitUntil: "networkidle" });
await open();
assert.match(await admin.innerText("main"), /Auto-approve is ON/);
assert.match(await row(a.id).innerText(), /Trial ends[\s\S]*auto-approved/);
ok("admin page shows auto-approve ON, trial end and 'auto-approved'");

// ── 3. reminders ──
t = ends - 2 * DAY + 60000; assert.equal((await sweep()).reminders, 2);
t = ends - DAY + 60000; assert.equal((await sweep()).reminders, 2);
assert.equal((await sweep()).reminders, 0);
assert.equal((await one(`SELECT count(*)::int n FROM outbound_emails WHERE signup_id=$1 AND kind LIKE 'trial_reminder_%'`, [a.id])).n, 2);
ok("2-day and 1-day reminder emails queued once each per club");

// ── 4. expiry ──
t = ends + 60000; assert.equal((await sweep()).expired, 2);
await open();
assert.equal(await row(a.id).locator('[data-testid="status"]').innerText(), "expired");
assert.match(await row(a.id).innerText(), /Expired .* deleted after/);
ok("trial end: both clubs expired, admin shows the deletion date");

// ── 5. admin: Extend B (expired) → trial_active again, instance updated ──
await row(b.id).locator('[data-testid="extend-form"] input[name="days"]').fill("3");
await row(b.id).getByRole("button", { name: "Extend trial" }).click();
await flash("ok", new RegExp(`Extended #${b.id} by 3 day`));
b = await one(`SELECT * FROM club_signups WHERE id=$1`, [b.id]);
assert.equal(b.status, "trial_active"); assert.equal(b.trial_extended_days, 3);
await work();
const svcB = fakes.railway._s.services.find((s) => s.name === `club-${slug}-2`);
assert.equal(fakes.railway._s.variables[svcB.id].TRIAL_ENDS_AT, new Date(b.trial_ends_at).toISOString());
ok("Extend trial: expired club back to trial_active (+3 days), worker pushed the new TRIAL_ENDS_AT and restarted it");

// ── 6. admin: Mark converted on B → never torn down ──
await open();
await row(b.id).getByRole("button", { name: "Mark converted" }).click();
await flash("ok", /marked converted/);
await work();
assert.equal(fakes.railway._s.variables[svcB.id].TRIAL_ENDS_AT, undefined);
ok("Mark converted: status converted, trial limit removed from the instance");

// ── 7. grace over → A torn down, B (converted) untouched ──
t = ends + 7 * DAY + 60000;
const sw = await sweep();
assert.equal(sw.teardownsQueued, 1, "only the unconverted club");
await work();
a = await one(`SELECT * FROM club_signups WHERE id=$1`, [a.id]);
assert.equal(a.status, "removed");
assert.equal(fakes.railway._s.services.some((s) => s.name === `club-${slug}`), false);
assert.equal(fakes.railway._s.services.some((s) => s.name === `club-${slug}-2`), true, "converted club kept");
assert.equal(fakes.tenantDb._s.databases.has(`club_${slug.replace(/-/g, "_")}`), false);
assert.equal(fakes.cloudflare._s.records.filter((r) => r.name.includes(`${slug}.`)).length, 0);
t = ends + 60 * DAY; assert.equal((await sweep()).teardownsQueued, 0);
await open();
assert.equal(await row(a.id).locator('[data-testid="status"]').innerText(), "removed");
assert.match(await row(a.id).innerText(), /Removed /);
assert.equal(await row(b.id).locator('[data-testid="status"]').innerText(), "converted");
assert.match(await row(b.id).innerText(), /never removed automatically/);
assert.equal(await row(b.id).locator('[data-testid="delete-form"]').count(), 0, "no Delete now for converted clubs");
ok("grace over: unconverted club removed (service, DNS, DB gone); converted club kept, even 60 days later");

// ── 8. Delete now (with confirmation) + Retry removal after a failure ──
t = Date.now();
const c = await signup(3, `Delete Me ${run}`);
await work();
await open();
await row(c.id).locator('[data-testid="delete-form"] input[name="confirm"]').fill("wrong-name");
await row(c.id).getByRole("button", { name: "Delete now" }).click();
await flash("err", /Type the subdomain/);
assert.equal((await one(`SELECT status FROM club_signups WHERE id=$1`, [c.id])).status, "trial_active");
await row(c.id).locator('[data-testid="delete-form"] input[name="confirm"]').fill(c.slug);
await row(c.id).getByRole("button", { name: "Delete now" }).click();
await flash("ok", /is being removed/);
const bad = new Error("Not Authorized"); bad.retryable = false;
const origDelete = fakes.railway.deleteService;
fakes.railway.deleteService = async () => { throw bad; };
await work();
assert.equal((await one(`SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'`, [c.id])).status, "failed");
await open();
assert.match(await row(c.id).innerText(), /Not Authorized/);
await row(c.id).getByRole("button", { name: "Retry removal" }).click();
await flash("ok", /Teardown for #\d+ re-queued/);
fakes.railway.deleteService = origDelete;
await work();
assert.equal((await one(`SELECT status FROM club_signups WHERE id=$1`, [c.id])).status, "removed");
assert.equal(fakes.railway._s.services.some((s) => s.name === `club-${c.slug}`), false);
ok("Delete now needs the subdomain typed; failed removal shows the error, Retry removal finishes it");

// ── 9. emails (enabled only in this test, fake Resend) ──
const sent = [];
const resend = { async send(m) { sent.push(m); return `re_${sent.length}`; } };
await sendQueuedEmails({ store, resend, config: testConfig({ email: { ...testConfig().email, enabled: true } }), log: quiet });
const subjectsA = sent.filter((m) => m.to === a.email).map((m) => m.subject);
assert.deepEqual(subjectsA, [`${clubName} is ready on Club Honbu`, "Your Club Honbu trial ends in 2 days", "Your Club Honbu trial ends tomorrow", "Your Club Honbu trial has ended", "Your Club Honbu trial club has been deleted"]);
ok("club A received: welcome, 2-day, 1-day, trial ended, deleted (once each)");

await admin.screenshot({ path: process.env.SCREENSHOT || "/tmp/hq-trial-lifecycle.png", fullPage: true });
await browser.close();
await store.end();
await db.end();
console.log("ALL PASS");

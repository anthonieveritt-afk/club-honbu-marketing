// End-to-end check of the HQ approval flow: /admin/signups Approve/Reject/Retry → provisioning_jobs
// → worker (with FAKE Railway/Cloudflare/tenant-DB/HTTP) → admin page shows trial_active + URL.
// Runs against a local build and a throwaway local Postgres ONLY:
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5544/hq_e2e ADMIN_PASSWORD=... pnpm start -p 3101 &
//   BASE_URL=http://localhost:3101 DATABASE_URL=... ADMIN_PASSWORD=... node scripts/test-hq-approval.mjs
import assert from "node:assert/strict";
import pg from "pg";
import { chromium } from "playwright-core";
import { createPgStore } from "../worker/src/store.js";
import { workOnce } from "../worker/src/worker.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp } from "../worker/src/fakes.js";
import { testConfig, HASH } from "../worker/test/helpers.js";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const URL_ = process.env.DATABASE_URL;
assert.ok(URL_ && /@(localhost|127\.0\.0\.1)[:/]/.test(URL_), "DATABASE_URL must be a LOCAL throwaway database");
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
assert.ok(ADMIN_PASS, "ADMIN_PASSWORD required");

const db = new pg.Client({ connectionString: URL_ });
await db.connect();
const ok = (n) => console.log("PASS", n);
const run = Date.now().toString(36);

// Make sure the schema exists (the site applies it on first DB use).
let r = await fetch(`${BASE}/admin/signups`, { headers: { authorization: "Basic " + Buffer.from(`admin:${ADMIN_PASS}`).toString("base64") } });
assert.equal(r.status, 200);
// Throwaway local DB (asserted above): start from empty so job order is deterministic.
await db.query(`TRUNCATE club_signups, provisioning_jobs, provisioning_events, outbound_emails RESTART IDENTITY CASCADE`);

async function insert(club, email) {
  const { rows } = await db.query(
    `INSERT INTO club_signups (club_name, sport_type, contact_name, email, admin_username, password_hash)
     VALUES ($1,'Martial Arts','Olive Owner',$2,'owner',$3) RETURNING id`, [club, email, HASH]);
  return rows[0].id;
}
const a = await insert(`Alpha Dojo ${run}`, `alpha-${run}@example.com`);
const b = await insert(`Beta Club ${run}`, `beta-${run}@example.com`);
const c = await insert(`Gamma Gym ${run}`, `gamma-${run}@example.com`);
const d = await insert(`Delta ${run}`, `delta-${run}@example.com`);

// Server actions are protected by Basic auth (middleware) too.
r = await fetch(`${BASE}/admin/signups`, { method: "POST", headers: { "next-action": "x" }, body: "" });
assert.equal(r.status, 401);
ok("unauthenticated POST to /admin/signups (server actions) → 401");

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ httpCredentials: { username: process.env.ADMIN_USERNAME || "admin", password: ADMIN_PASS } });
const page = await ctx.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
async function flash(kind, re) {
  await page.waitForFunction(([k, src]) => {
    const el = document.querySelector(`[data-testid="flash-${k}"]`);
    return el && new RegExp(src).test(el.textContent);
  }, [kind, re.source], { timeout: 15000 });
  return page.innerText(`[data-testid="flash-${kind}"]`);
}
const row = (id) => page.locator(`tr[data-signup-id="${id}"]`);
await page.goto(`${BASE}/admin/signups`, { waitUntil: "networkidle" });

// Suggested slug is pre-filled.
const slugA = `alpha-dojo-${run}`;
assert.equal(await row(a).locator('input[name="slug"]').inputValue(), slugA);
ok("approve form pre-fills the suggested subdomain");

// Reserved slug is refused.
await row(a).locator('input[name="slug"]').fill("admin");
await row(a).getByRole("button", { name: "Approve" }).click();
await flash("err", /not a usable subdomain/);
assert.equal((await db.query(`SELECT status FROM club_signups WHERE id=$1`, [a])).rows[0].status, "new");
ok("reserved subdomain rejected, nothing changed");

// Approve A.
await row(a).locator('input[name="slug"]').fill(slugA);
await row(a).getByRole("button", { name: "Approve" }).click();
await flash("ok", new RegExp(`Approved #${a} `));
let s = (await db.query(`SELECT status, slug, decided_at FROM club_signups WHERE id=$1`, [a])).rows[0];
assert.equal(s.status, "approved"); assert.equal(s.slug, slugA); assert.ok(s.decided_at);
let jobs = (await db.query(`SELECT * FROM provisioning_jobs WHERE signup_id=$1`, [a])).rows;
assert.equal(jobs.length, 1); assert.equal(jobs[0].status, "queued");
assert.match(await row(a).innerText(), /job queued/);
assert.equal(await row(a).locator('[data-testid="approve-form"]').count(), 0);
ok("Approve → status approved, slug saved, exactly one queued provisioning job, shown on page");

// Duplicate slug on B is refused.
await row(b).locator('input[name="slug"]').fill(slugA);
await row(b).getByRole("button", { name: "Approve" }).click();
await flash("err", /already used/);
assert.equal((await db.query(`SELECT count(*)::int n FROM provisioning_jobs WHERE signup_id=$1`, [b])).rows[0].n, 0);
ok("duplicate subdomain refused");

// Reject C (with reason) and Reject an approved-but-queued D.
await row(c).locator('input[name="reason"]').fill("Not a real club");
await row(c).getByRole("button", { name: "Reject" }).click();
await flash("ok", new RegExp(`Rejected #${c}`));
s = (await db.query(`SELECT status, rejected_reason, password_hash FROM club_signups WHERE id=$1`, [c])).rows[0];
assert.deepEqual(s, { status: "rejected", rejected_reason: "Not a real club", password_hash: null });
ok("Reject → status rejected, reason stored, password hash cleared");

await row(d).getByRole("button", { name: "Approve" }).click();
await flash("ok", new RegExp(`Approved #${d} `));
await row(d).getByRole("button", { name: "Reject" }).click();
await flash("ok", new RegExp(`Rejected #${d}`));
assert.equal((await db.query(`SELECT status FROM provisioning_jobs WHERE signup_id=$1`, [d])).rows[0].status, "cancelled");
assert.equal((await db.query(`SELECT status FROM club_signups WHERE id=$1`, [d])).rows[0].status, "rejected");
ok("Reject after approve (job not started) cancels the queued job");

if (process.env.SCREENSHOT_PENDING) await page.screenshot({ path: process.env.SCREENSHOT_PENDING, fullPage: true });

// Approve B now (unique slug); its provisioning will fail permanently to exercise Retry.
await row(b).locator('input[name="slug"]').fill(`beta-club-${run}`);
await row(b).getByRole("button", { name: "Approve" }).click();
await flash("ok", new RegExp(`Approved #${b} `));

// ── worker with fakes ──
const store = createPgStore({ connectionString: URL_ });
const config = testConfig();
const fakes = (fail) => ({
  railway: createFakeRailway({ fail }), cloudflare: createFakeCloudflare(), tenantDb: createFakeTenantDb(),
  httpStatus: createFakeHttp(), sleep: async () => {}, now: () => Date.now(),
});
const deps = fakes();
const quiet = () => {};
let res = await workOnce({ store, deps, config, log: quiet });
// B's job: make createService fail with a non-retryable error.
const bad = new Error("Not Authorized"); bad.retryable = false;
const depsBad = fakes({ createService: [bad] });
res = await workOnce({ store, deps: depsBad, config, log: quiet });
res = await workOnce({ store, deps, config, log: quiet });
assert.equal(res, "idle", "queue drained");
const ja = (await db.query(`SELECT status FROM provisioning_jobs WHERE signup_id=$1`, [a])).rows[0];
const jb = (await db.query(`SELECT status, last_error FROM provisioning_jobs WHERE signup_id=$1`, [b])).rows[0];
assert.equal(ja.status, "succeeded");
assert.equal(jb.status, "failed"); assert.match(jb.last_error, /Not Authorized/);

await page.goto(`${BASE}/admin/signups`, { waitUntil: "networkidle" });
assert.equal(await row(a).locator('[data-testid="status"]').innerText(), "trial_active");
assert.equal(await row(a).locator('[data-testid="instance-url"]').innerText(), `${slugA}.clubhonbu.co.uk`);
assert.match(await row(a).innerText(), /Trial ends/);
s = (await db.query(`SELECT password_hash, instance_url FROM club_signups WHERE id=$1`, [a])).rows[0];
assert.equal(s.password_hash, null); assert.equal(s.instance_url, `https://${slugA}.clubhonbu.co.uk`);
ok("worker (fakes) provisions the approved club; page shows trial_active, URL and trial end");

assert.match(await row(b).innerText(), /job failed[\s\S]*Not Authorized/);
await row(b).getByRole("button", { name: "Retry provisioning" }).click();
await flash("ok", new RegExp(`re-queued`));
assert.equal((await db.query(`SELECT status FROM provisioning_jobs WHERE signup_id=$1`, [b])).rows[0].status, "queued");
await workOnce({ store, deps, config, log: quiet });
await page.goto(`${BASE}/admin/signups`, { waitUntil: "networkidle" });
assert.equal(await row(b).locator('[data-testid="status"]').innerText(), "trial_active");
ok("failed job shows error + Retry; Retry re-queues and the worker completes it");

assert.equal((await db.query(`SELECT count(*)::int n FROM provisioning_jobs WHERE signup_id IN ($1,$2)`, [a, b])).rows[0].n, 2);
assert.equal(deps.railway._s.services.filter((x) => x.name === `club-${slugA}`).length, 1);
ok("no duplicate jobs or services");

await page.screenshot({ path: process.env.SCREENSHOT || "/tmp/hq-admin-signups.png", fullPage: true });
await browser.close();
await store.end();
await db.end();
console.log("ALL PASS");

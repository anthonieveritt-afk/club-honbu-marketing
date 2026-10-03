// End-to-end check of sign-up capture against a running build and a real Postgres.
//
//   pnpm build
//   DATABASE_URL=postgres://... ADMIN_PASSWORD=... SIGNUP_LIMIT_PER_IP_HOUR=4 pnpm start -p 3100 &
//   BASE_URL=http://localhost:3100 DATABASE_URL=... ADMIN_PASSWORD=... SIGNUP_LIMIT_PER_IP_HOUR=4 \
//   CHROME_PATH=/usr/bin/google-chrome node scripts/test-signup-capture.mjs
//
// Uses a unique run id so it can run against a database that already has rows.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import bcrypt from "bcryptjs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const LIMIT = Number(process.env.SIGNUP_LIMIT_PER_IP_HOUR || 5);
assert.ok(process.env.DATABASE_URL, "DATABASE_URL required");
assert.ok(ADMIN_PASS, "ADMIN_PASSWORD required");

const run = Date.now().toString(36);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const results = [];
const ok = (name) => { results.push(name); console.log("PASS", name); };
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

// 0. db/schema.sql and the embedded copy agree
{
  const sql = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
  const ts = readFileSync(new URL("../lib/schema.ts", import.meta.url), "utf8");
  assert.ok(ts.includes(sql), "lib/schema.ts must embed db/schema.sql verbatim");
  ok("schema.sql embedded verbatim in lib/schema.ts");
}

// 1. admin page is protected
{
  let r = await fetch(`${BASE}/admin/signups`);
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") || "", /Basic/);
  r = await fetch(`${BASE}/admin/signups`, { headers: { authorization: basic(ADMIN_USER, "wrong-password-123") } });
  assert.equal(r.status, 401);
  // middleware-bypass header (CVE-2025-29927) must not help
  r = await fetch(`${BASE}/admin/signups`, {
    headers: { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
  });
  assert.notEqual(r.status, 200);
  ok("admin page: 401 without/with wrong credentials, bypass header rejected");
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();

async function submit(fields, { waitMs = 3500, honeypot = "" } = {}) {
  await page.goto(`${BASE}/get-started`, { waitUntil: "networkidle" });
  await page.fill("#clubName", fields.clubName);
  await page.selectOption("#sportType", fields.sportType);
  await page.fill("#contactName", fields.contactName);
  await page.fill("#email", fields.email);
  await page.fill("#website", fields.website ?? "");
  await page.fill("#adminUsername", fields.adminUsername);
  await page.fill("#password", fields.password);
  await page.fill("#confirmPassword", fields.confirmPassword ?? fields.password);
  if (honeypot) await page.fill("#company", honeypot, { force: true });
  await page.waitForTimeout(waitMs);
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => /Thanks — we've got it|don't match|is required|several sign-ups|couldn't save|Something went wrong/.test(document.body.innerText),
    null,
    { timeout: 20000 }
  );
  return page.innerText("main");
}

const base = (n) => ({
  clubName: `Test Dojo ${run}-${n}`,
  sportType: "Martial Arts",
  contactName: "Test Person",
  email: `test+${run}-${n}@example.com`,
  website: "example.com",
  adminUsername: `Coach_${n}`,
  password: `S3cret-pass-${run}-${n}`,
});
const rowsFor = async (n) => {
  try {
    return (await db.query("SELECT * FROM club_signups WHERE email = $1", [base(n).email])).rows;
  } catch (e) {
    if (e.code === "42P01") return []; // fresh DB: the app creates the table on first sign-up
    throw e;
  }
};

// 2. validation still works (password mismatch) and stores nothing
{
  const text = await submit({ ...base(0), confirmPassword: "different-pass" });
  assert.match(text, /Passwords don't match/);
  assert.equal((await rowsFor(0)).length, 0);
  ok("validation error shown, nothing stored");
}

// 3. a real submission is stored with a bcrypt hash and honest success text
{
  const f = base(1);
  const text = await submit(f);
  assert.match(text, /Thanks — we've got it/);
  assert.match(text, /We'll email your login details shortly/);
  assert.doesNotMatch(text, /Check your inbox|within 24 hours/);
  const rows = await rowsFor(1);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.club_name, f.clubName);
  assert.equal(r.sport_type, "Martial Arts");
  assert.equal(r.website, "example.com");
  assert.equal(r.admin_username, "coach_1");
  assert.equal(r.status, "new");
  assert.match(r.password_hash, /^\$2[aby]\$12\$/);
  assert.ok(await bcrypt.compare(f.password, r.password_hash), "hash verifies");
  assert.ok(!JSON.stringify(r).includes(f.password), "plain password not stored");
  assert.match(r.ip_hash, /^[0-9a-f]{64}$/);
  ok(`submission stored (id ${r.id}), bcrypt cost 12, plain password absent`);
}

// 4. honeypot and too-fast submissions look successful but store nothing
{
  let text = await submit(base(2), { honeypot: "Acme Ltd" });
  assert.match(text, /Thanks — we've got it/);
  assert.equal((await rowsFor(2)).length, 0);
  text = await submit(base(3), { waitMs: 0 });
  assert.match(text, /Thanks — we've got it/);
  assert.equal((await rowsFor(3)).length, 0);
  ok("honeypot + <3s submissions silently dropped");
}

// 5. second submission; admin page lists both, newest first, no hashes
{
  await submit(base(4));
  assert.equal((await rowsFor(4)).length, 1);
  const r = await fetch(`${BASE}/admin/signups`, { headers: { authorization: basic(ADMIN_USER, ADMIN_PASS) } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await r.text();
  const i4 = html.indexOf(base(4).clubName);
  const i1 = html.indexOf(base(1).clubName);
  assert.ok(i4 > -1 && i1 > -1, "both sign-ups listed");
  assert.ok(i4 < i1, "newest first");
  assert.ok(html.includes(base(1).email.replace("+", "+")));
  assert.ok(!html.includes("$2a$") && !html.includes("$2b$"), "no password hashes on page");
  ok("admin page lists sign-ups newest-first without hashes");
}

// 6. rate limit: attempts from this IP so far = 2 valid; keep going until blocked
{
  const already = 2;
  let blockedAt = null;
  for (let n = 5; n < 5 + LIMIT + 1; n++) {
    const text = await submit(base(n));
    if (/several sign-ups/.test(text)) { blockedAt = n; break; }
  }
  const allowedThisLoop = blockedAt - 5;
  assert.equal(already + allowedThisLoop, LIMIT, `blocked after ${LIMIT} attempts/hour`);
  assert.equal((await rowsFor(blockedAt)).length, 0);
  ok(`rate limit: attempt ${LIMIT + 1} within the hour blocked, not stored`);
}

await browser.close();
await db.end();
console.log(`\nALL ${results.length} CHECKS PASSED (run ${run})`);

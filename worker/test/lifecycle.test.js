// Trial lifecycle: provision -> reminders -> expiry -> grace -> teardown, with a real local Postgres
// (HQ tables) and mocked Railway / Cloudflare / tenant DB. Time is simulated via `now`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshHqDb, approvedSignup, testConfig } from "./helpers.js";
import { workOnce, sendQueuedEmails } from "../src/worker.js";
import { runLifecycleSweep, planLifecycle, dueReminder, dryRunDeps, readOnlyStore, runTeardownJob } from "../src/lifecycle.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp, transientError } from "../src/fakes.js";

const DAY = 86400000;
const quiet = () => {};
let env;
before(async () => { env = await freshHqDb("life"); });
after(async () => { await env.drop(); });

const one = async (q, p) => (await env.db.query(q, p)).rows[0];
const all = async (q, p) => (await env.db.query(q, p)).rows;
const count = (fake, name) => fake._s.calls.filter((c) => c.name === name).length;

/** A clock the worker and the sweep share. */
function clock(start = Date.now()) {
  let t = start;
  const now = () => t;
  now.set = (v) => { t = typeof v === "number" ? v : new Date(v).getTime(); };
  return now;
}
function deps(now, opts = {}) {
  return {
    railway: opts.railway || createFakeRailway(),
    cloudflare: opts.cloudflare || createFakeCloudflare(),
    tenantDb: opts.tenantDb || createFakeTenantDb(),
    httpStatus: createFakeHttp(), sleep: async () => {}, now,
  };
}
const sweep = (now, cfg = testConfig()) => runLifecycleSweep({ store: env.store, config: cfg, now: now(), log: quiet });
const work = (d, cfg = testConfig()) => workOnce({ store: env.store, deps: d, config: cfg, log: quiet });
async function drain(d, cfg) { let n = 0, r; while ((r = await work(d, cfg)) !== "idle" && n++ < 20) { /* run all due jobs */ } return r; }

async function provisioned(slug, now, d) {
  const id = await approvedSignup(env.db, { slug, club: `Club ${slug}`, email: `${slug}@example.com` });
  assert.equal(await work(d), "succeeded");
  const s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "trial_active");
  return { id, ends: new Date(s.trial_ends_at).getTime() };
}

// Mirrors lib/signups.ts markConverted / extendTrial (the e2e script drives the real ones).
async function convert(id) {
  await env.db.query(`UPDATE club_signups SET status='converted', converted_at=now(), teardown_after=NULL WHERE id=$1`, [id]);
  await env.store.enqueueJob(id, "sync_trial", { requeueFrom: ["queued", "succeeded", "failed", "cancelled"] });
}
async function extend(id, days, now) {
  await env.db.query(
    `UPDATE club_signups SET trial_ends_at = GREATEST(trial_ends_at, $3) + ($2::numeric * interval '24 hours'), status='trial_active',
            expired_at=NULL, teardown_after=NULL, trial_extended_days = trial_extended_days + $2::int WHERE id=$1`,
    [id, String(days), new Date(now())]);
  await env.db.query(`UPDATE provisioning_jobs SET status='cancelled' WHERE signup_id=$1 AND kind='teardown' AND status='queued'`, [id]);
  await env.store.enqueueJob(id, "sync_trial", { requeueFrom: ["queued", "succeeded", "failed", "cancelled"] });
}

test("pure planner: due reminder windows", () => {
  const now = Date.now();
  const at = (days) => new Date(now + days * DAY).toISOString();
  assert.equal(dueReminder({ trialEndsAt: at(3), now, reminderDays: [2, 1] }), null);
  assert.equal(dueReminder({ trialEndsAt: at(1.9), now, reminderDays: [2, 1] }), 2);
  assert.equal(dueReminder({ trialEndsAt: at(0.5), now, reminderDays: [2, 1] }), 1, "only the most urgent one");
  assert.equal(dueReminder({ trialEndsAt: at(-0.1), now, reminderDays: [2, 1] }), null);
  const plan = planLifecycle({ now, config: testConfig(), signups: [
    { id: 1, status: "trial_active", trial_ends_at: at(1.5) },
    { id: 2, status: "trial_active", trial_ends_at: at(-1) },
    { id: 3, status: "expired", teardown_after: at(-0.1) },
    { id: 4, status: "expired", teardown_after: at(2) },
    { id: 5, status: "converted", converted_at: at(-3), trial_ends_at: at(-10) },
    { id: 6, status: "expired", converted_at: at(-1), teardown_after: at(-1) },
  ] });
  assert.deepEqual(plan.map((p) => `${p.signup.id}:${p.action}`), ["1:remind", "2:expire", "3:teardown"]);
});

test("full lifecycle: provision -> 2-day + 1-day reminders -> expiry -> grace -> teardown -> removed", async () => {
  const now = clock();
  const d = deps(now);
  const { id, ends } = await provisioned("life-dojo", now, d);
  assert.ok(Math.abs(ends - (now() + 7 * DAY)) < 5000, "7-day trial");
  const rw = d.railway._s;
  const svcId = rw.services[0].id;
  assert.equal(rw.variables[svcId].TRIAL_GRACE_DAYS, "7");

  // day 4: nothing due
  now.set(ends - 3 * DAY);
  assert.deepEqual(await sweep(now), { reminders: 0, expired: 0, teardownsQueued: 0 });

  // 2 days before: 2-day reminder, exactly once even if swept repeatedly / concurrently
  now.set(ends - 2 * DAY + 60000);
  const [a, b] = await Promise.all([sweep(now), sweep(now)]);
  assert.equal(a.reminders + b.reminders, 1, "two workers sweeping at once queue one reminder");
  assert.equal((await sweep(now)).reminders, 0);
  let mails = await all("SELECT kind, subject, body_text FROM outbound_emails WHERE signup_id=$1 ORDER BY id", [id]);
  assert.equal(mails.length, 2, "welcome + 2-day reminder");
  assert.match(mails[1].kind, /^trial_reminder_2d:/);
  assert.equal(mails[1].subject, "Your Club Honbu trial ends in 2 days");
  assert.match(mails[1].body_text, /https:\/\/life-dojo\.clubhonbu\.co\.uk\/admin\/login/);
  assert.match(mails[1].body_text, /permanently deleted 7 days later/);

  // 1 day before: 1-day reminder
  now.set(ends - DAY + 60000);
  assert.equal((await sweep(now)).reminders, 1);
  assert.equal((await one("SELECT subject FROM outbound_emails WHERE signup_id=$1 AND kind LIKE 'trial_reminder_1d:%'", [id])).subject, "Your Club Honbu trial ends tomorrow");

  // end of trial: expired, teardown scheduled for end + 7 days, "trial ended" email
  now.set(ends + 60000);
  assert.equal((await sweep(now)).expired, 1);
  assert.equal((await sweep(now)).expired, 0, "idempotent");
  let s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "expired");
  assert.equal(new Date(s.teardown_after).getTime(), ends + 7 * DAY);
  assert.ok(await one("SELECT 1 FROM outbound_emails WHERE signup_id=$1 AND kind LIKE 'trial_expired:%'", [id]));
  assert.equal(rw.services.length, 1, "nothing deleted at expiry (the club app locks itself)");

  // during grace: nothing queued
  now.set(ends + 6 * DAY);
  assert.equal((await sweep(now)).teardownsQueued, 0);
  assert.equal(await work(d), "idle");

  // grace over: teardown queued once, then run
  now.set(ends + 7 * DAY + 60000);
  assert.equal((await sweep(now)).teardownsQueued, 1);
  assert.equal((await sweep(now)).teardownsQueued, 0, "not queued twice");
  assert.equal(await work(d), "succeeded");

  s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "removed");
  assert.ok(s.removal_requested_at && s.removed_at);
  assert.equal(rw.services.length, 0, "Railway service deleted");
  assert.equal(rw.customDomains.length, 0, "custom domain deleted");
  assert.equal(d.cloudflare._s.records.length, 0, "both DNS records deleted");
  assert.equal(d.tenantDb._s.databases.size, 0, "tenant database + role dropped");
  assert.ok(await one("SELECT 1 FROM outbound_emails WHERE signup_id=$1 AND kind='trial_removed'", [id]));
  const job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id]);
  assert.equal(job.status, "succeeded");
  assert.deepEqual(Object.keys(job.state.done).sort(), ["custom_domain", "database", "dns", "finalize", "guard", "service"]);
  const ev = (await all("SELECT step, level, message FROM provisioning_events WHERE signup_id=$1 ORDER BY id", [id])).map((e) => `${e.step}|${e.message}`);
  for (const re of [/^reminder\|Queued 2-day/, /^reminder\|Queued 1-day/, /^expire\|Trial ended/, /^teardown\|Grace period over/,
    /^teardown:dns\|Deleted DNS CNAME life-dojo/, /^teardown:dns\|Deleted DNS TXT _railway-verify\.life-dojo/,
    /^teardown:custom_domain\|Deleted Railway custom domain/, /^teardown:service\|Deleted Railway service club-life-dojo/,
    /^teardown:database\|Dropped database club_life_dojo and role club_life_dojo_app/, /^teardown:finalize\|All resources/]) {
    assert.ok(ev.some((e) => re.test(e)), `event ${re} logged`);
  }

  // re-running the finished teardown (stale lease / manual requeue) deletes nothing and fails nothing
  await env.db.query(`UPDATE provisioning_jobs SET status='queued', state='{}'::jsonb, run_after=now() WHERE id=$1`, [job.id]);
  const before = d.railway._s.calls.length;
  assert.equal(await work(d), "cancelled", "status is removed: the guard stops it");
  assert.equal(count(d.railway, "deleteService"), 1);
  assert.ok(d.railway._s.calls.length - before <= 1);
  assert.equal(await sweep(now).then((r) => r.teardownsQueued), 0, "removed clubs are never queued again");

  // emails go out only when enabled, once each, with idempotency keys
  const sent = [];
  const resend = { async send(m) { sent.push(m); return `re_${sent.length}`; } };
  const on = testConfig({ email: { ...testConfig().email, enabled: true } });
  await sendQueuedEmails({ store: env.store, resend, config: on, log: quiet });
  const subjects = sent.filter((m) => m.to === "life-dojo@example.com").map((m) => m.subject);
  assert.deepEqual(subjects, ["Club life-dojo is ready on Club Honbu", "Your Club Honbu trial ends in 2 days", "Your Club Honbu trial ends tomorrow",
    "Your Club Honbu trial has ended", "Your Club Honbu trial club has been deleted"]);
  assert.equal(await sendQueuedEmails({ store: env.store, resend, config: on, log: quiet }), 0);
});

test("converted clubs are never torn down (sweep, forced job, and conversion mid-teardown)", async () => {
  const now = clock();
  const d = deps(now);
  const { id, ends } = await provisioned("paid-club", now, d);
  const svcId = d.railway._s.services.find((s) => s.name === "club-paid-club").id;
  await convert(id);
  assert.equal(await work(d), "succeeded", "sync job");
  const vars = d.railway._s.variables[svcId];
  assert.equal(vars.TRIAL_ENDS_AT, undefined, "trial end removed from the instance");
  assert.equal(vars.TRIAL_GRACE_DAYS, undefined);
  assert.equal(d.railway._s.redeploys, 1, "service restarted to pick it up");

  now.set(ends + 60 * DAY);
  assert.deepEqual(await sweep(now), { reminders: 0, expired: 0, teardownsQueued: 0 });
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "converted");

  // even a teardown job inserted by hand is refused before anything is touched
  await env.db.query(`INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, 'teardown')`, [id]);
  assert.equal(await work(d), "cancelled");
  assert.equal(count(d.railway, "deleteService") + count(d.cloudflare, "deleteRecord") + count(d.tenantDb, "dropDatabase"), 0);
  assert.match((await one("SELECT last_error FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id])).last_error, /converted/);

  // a club converted while its teardown is part-way through: the next destructive step stops
  const now2 = clock();
  const d2 = deps(now2, { railway: createFakeRailway({ fail: { deleteCustomDomain: [transientError()] } }) });
  const { id: id2, ends: ends2 } = await provisioned("late-payer", now2, d2);
  now2.set(ends2 + 60000); await sweep(now2);
  now2.set(ends2 + 8 * DAY); await sweep(now2);
  assert.equal(await work(d2), "requeued", "dns done, custom domain call failed");
  await env.db.query(`UPDATE club_signups SET status='converted', converted_at=now() WHERE id=$1`, [id2]);
  await env.db.query(`UPDATE provisioning_jobs SET run_after=now() WHERE signup_id=$1 AND kind='teardown'`, [id2]);
  assert.equal(await work(d2), "cancelled");
  assert.equal(d2.railway._s.services.filter((s) => s.name === "club-late-payer").length, 1, "service kept");
  assert.equal(d2.tenantDb._s.databases.has("club_late_payer"), true, "database kept");
});

test("teardown retries: lost responses and transient errors resume without double-deleting", async () => {
  const now = clock();
  const railway = createFakeRailway({ fail: { deleteService: ["throw-after-create"] } });
  const cloudflare = createFakeCloudflare({ fail: { deleteRecord: [null, transientError()] } });
  const tenantDb = createFakeTenantDb({ fail: { dropDatabase: [transientError("connection reset")] } });
  const d = deps(now, { railway, cloudflare, tenantDb });
  const { id, ends } = await provisioned("retry-club", now, d);
  now.set(ends + 1000); await sweep(now);
  now.set(ends + 7 * DAY + 1000); await sweep(now);
  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    const o = await work(d);
    outcomes.push(o);
    if (o === "succeeded" || o === "idle") break;
    await env.db.query(`UPDATE provisioning_jobs SET run_after=now(), attempts=0 WHERE signup_id=$1 AND kind='teardown' AND status='queued'`, [id]);
  }
  assert.deepEqual(outcomes, ["requeued", "requeued", "requeued", "succeeded"]);
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "removed");
  assert.equal(count(railway, "deleteService"), 1, "service delete not repeated after the lost response");
  assert.equal(railway._s.services.length, 0);
  assert.equal(cloudflare._s.records.length, 0);
  assert.equal(tenantDb._s.databases.size, 0);
  const ev = (await all("SELECT step, message FROM provisioning_events WHERE signup_id=$1 ORDER BY id", [id])).map((e) => `${e.step}|${e.message}`);
  assert.ok(ev.some((e) => /^teardown:service\|Service club-retry-club already gone/.test(e)), "second attempt sees it gone");
});

test("teardown never touches DNS records it doesn't own, or a service with an unexpected name", async () => {
  const now = clock();
  const cf = createFakeCloudflare();
  const d = deps(now, { cloudflare: cf });
  const { id, ends } = await provisioned("shared-dns", now, d);
  cf._s.records.push({ id: "foreign", type: "TXT", name: "_railway-verify.shared-dns.clubhonbu.co.uk", content: "someone else", comment: "manual" });
  now.set(ends + 1000); await sweep(now);
  now.set(ends + 8 * DAY); await sweep(now);
  assert.equal(await work(d), "succeeded");
  assert.deepEqual(cf._s.records.map((r) => r.id), ["foreign"], "foreign record left alone");
  assert.ok(await one("SELECT 1 FROM provisioning_events WHERE signup_id=$1 AND level='warn' AND message LIKE '%not managed by HQ%'", [id]));

  // provisioning state points at a service that was renamed: refuse instead of deleting it
  const now2 = clock();
  const d2 = deps(now2);
  const { id: id2, ends: ends2 } = await provisioned("renamed-svc", now2, d2);
  d2.railway._s.services.find((s) => s.name === "club-renamed-svc").name = "forza-production";
  now2.set(ends2 + 1000); await sweep(now2);
  now2.set(ends2 + 8 * DAY); await sweep(now2);
  assert.equal(await work(d2), "failed");
  assert.match((await one("SELECT last_error FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id2])).last_error, /refusing to touch it/);
  assert.equal(d2.railway._s.services.filter((s) => s.name === "forza-production").length, 1);
});

test("extend: expired club unlocked, pending teardown cancelled, instance gets the new TRIAL_ENDS_AT, reminders re-armed", async () => {
  const now = clock();
  const d = deps(now);
  const { id, ends } = await provisioned("needs-time", now, d);
  const svcId = d.railway._s.services.find((s) => s.name === "club-needs-time").id;
  now.set(ends - 2 * DAY + 1000); await sweep(now);
  now.set(ends + 1000); await sweep(now);
  now.set(ends + 7 * DAY + 1000); assert.equal((await sweep(now)).teardownsQueued, 1);
  await extend(id, 7, now); // admin clicks "Extend trial" before the worker picked the teardown up
  assert.equal(await drain(d), "idle");
  const s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "trial_active");
  assert.equal(s.teardown_after, null);
  assert.equal(new Date(s.trial_ends_at).getTime(), now() + 7 * DAY);
  assert.equal((await one("SELECT status FROM provisioning_jobs WHERE signup_id=$1 AND kind='teardown'", [id])).status, "cancelled");
  assert.equal(d.railway._s.services.length >= 1, true);
  assert.equal(d.railway._s.variables[svcId].TRIAL_ENDS_AT, new Date(s.trial_ends_at).toISOString(), "instance unlocked with the new date");
  assert.equal(d.railway._s.redeploys, 1);
  // the 2-day reminder for the NEW end date goes out again
  now.set(new Date(s.trial_ends_at).getTime() - 2 * DAY + 1000);
  assert.equal((await sweep(now)).reminders, 1);
  assert.equal((await one("SELECT count(*)::int n FROM outbound_emails WHERE signup_id=$1 AND kind LIKE 'trial_reminder_2d:%'", [id])).n, 2);
  // a sync job re-run with nothing to change is a no-op
  await env.store.enqueueJob(id, "sync_trial", { requeueFrom: ["succeeded"] });
  assert.equal(await work(d), "succeeded");
  assert.equal(d.railway._s.redeploys, 1, "no restart when variables already match");
});

test("TEARDOWN_ENABLED=0 queues nothing; DRY RUN teardown preview reads but never deletes or writes", async () => {
  const now = clock();
  const d = deps(now);
  const { id, ends } = await provisioned("preview-club", now, d);
  now.set(ends + 1000); await sweep(now);
  now.set(ends + 8 * DAY);
  const off = testConfig({ lifecycle: { ...testConfig().lifecycle, teardownEnabled: false } });
  assert.equal((await sweep(now, off)).teardownsQueued, 0);

  const snapshot = async () => JSON.stringify(await all(
    `SELECT (SELECT json_agg(s ORDER BY id) FROM club_signups s) a, (SELECT json_agg(j ORDER BY id) FROM provisioning_jobs j) b,
            (SELECT count(*) FROM provisioning_events) c, (SELECT count(*) FROM outbound_emails) e`));
  const before = await snapshot();
  const lines = [];
  const log = (m) => lines.push(m);
  const store = readOnlyStore(env.store, log, { simulateRemoving: true });
  const callsBefore = { svc: count(d.railway, "deleteService"), rec: count(d.cloudflare, "deleteRecord"), db: count(d.tenantDb, "dropDatabase") };
  await runTeardownJob({ job: { id: null, signup_id: id, state: {} }, store, deps: dryRunDeps(d, log), config: { ...testConfig(), dryRun: true }, now });
  assert.equal(await snapshot(), before, "HQ database unchanged");
  assert.deepEqual({ svc: count(d.railway, "deleteService"), rec: count(d.cloudflare, "deleteRecord"), db: count(d.tenantDb, "dropDatabase") }, callsBefore, "nothing deleted");
  assert.ok(lines.some((l) => /WOULD railway\.deleteService/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /WOULD cloudflare\.deleteRecord/.test(l)));
  assert.ok(lines.some((l) => /WOULD tenantDb\.dropDatabase .*club_preview_club/.test(l)));
  assert.equal(d.railway._s.services.filter((s) => s.name === "club-preview-club").length, 1);
});

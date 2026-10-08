import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshHqDb, approvedSignup, approve, testConfig, makeRunnable, HASH } from "./helpers.js";
import { workOnce, sendQueuedEmails } from "../src/worker.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp, transientError } from "../src/fakes.js";

let env;
before(async () => { env = await freshHqDb("prov"); });
after(async () => { await env.drop(); });

const quiet = () => {};
function deps(opts = {}) {
  return {
    railway: opts.railway || createFakeRailway(),
    cloudflare: opts.cloudflare || createFakeCloudflare(),
    tenantDb: opts.tenantDb || createFakeTenantDb(),
    httpStatus: opts.httpStatus || createFakeHttp(),
    sleep: async () => {},
    now: () => Date.now(),
  };
}
const count = (fake, name) => fake._s.calls.filter((c) => c.name === name).length;
const one = async (q, p) => (await env.db.query(q, p)).rows[0];

test("success: approved sign-up -> service, DB, variables, DNS, deploy, health -> trial_active", async () => {
  const id = await approvedSignup(env.db, { slug: "happy-dojo", club: "Happy Dojo", email: "happy@example.com" });
  const d = deps();
  const before = Date.now();
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "succeeded");

  const s = await one("SELECT * FROM club_signups WHERE id=$1", [id]);
  assert.equal(s.status, "trial_active");
  assert.equal(s.instance_url, "https://happy-dojo.clubhonbu.co.uk");
  assert.match(s.railway_url, /^https:\/\/.*\.up\.railway\.app$/);
  assert.equal(s.password_hash, null, "hash removed from HQ once handed to the instance");
  const days = (new Date(s.trial_ends_at) - before) / 86400000;
  assert.ok(days > 6.99 && days < 7.01, `trial ends in ~7 days (${days})`);

  const job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.equal(job.status, "succeeded");
  assert.equal(job.attempts, 1);
  assert.deepEqual(Object.keys(job.state.done).sort(), ["configure", "database", "deploy", "dns", "domains", "finalize", "health", "prepare", "service"].sort());

  const rw = d.railway._s;
  assert.equal(rw.services.length, 1);
  assert.equal(rw.services[0].name, "club-happy-dojo");
  const vars = rw.variables[rw.services[0].id];
  assert.equal(vars.CLUB_PROFILE, "neutral");
  assert.equal(vars.DB_BOOTSTRAP, "1");
  assert.equal(vars.CLUB_NAME, "Happy Dojo");
  assert.equal(vars.CLUB_TYPE, "martial_arts");
  assert.equal(vars.ADMIN_USERNAME, "owner");
  assert.equal(vars.ADMIN_PASSWORD_HASH, HASH);
  assert.equal(vars.TRIAL_ENDS_AT, new Date(s.trial_ends_at).toISOString());
  assert.equal(vars.TRIAL_GRACE_DAYS, "7");
  assert.equal(vars.TRIAL_CONTACT_EMAIL, "hello@clubhonbu.co.uk");
  assert.match(vars.ADMIN_JWT_SECRET, /^[0-9a-f]{64}$/);
  assert.notEqual(vars.ADMIN_JWT_SECRET, vars.PORTAL_JWT_SECRET);
  assert.match(vars.DATABASE_URL, /^postgresql:\/\/club_happy_dojo_app:[0-9a-f]{32}@postgres\.railway\.internal:5432\/club_happy_dojo$/);
  assert.equal(vars.ADMIN_PASSWORD, undefined, "no plain password anywhere");
  assert.equal(rw.instance[rw.services[0].id].region, "europe-west4-drams3a");
  assert.equal(rw.instance[rw.services[0].id].sleepApplication, true);
  assert.deepEqual(rw.sources[rw.services[0].id], { serviceId: rw.services[0].id, image: undefined, repo: "anthonieveritt-afk/club-honbu", branch: "feat/trial-instance" });
  // the source is connected only AFTER variables are set (no deploy without config)
  const order = rw.calls.map((c) => c.name);
  assert.ok(order.indexOf("upsertVariables") < order.indexOf("connectSource"));
  assert.equal(rw.deployments.length, 1);

  const recs = d.cloudflare._s.records.map((r) => `${r.type} ${r.name} ${r.proxied}`).sort();
  assert.deepEqual(recs, ["CNAME happy-dojo.clubhonbu.co.uk false", "TXT _railway-verify.happy-dojo.clubhonbu.co.uk false"]);
  assert.match(d.cloudflare._s.records.find((r) => r.type === "TXT").content, /^railway-verify=a{64}$/);
  assert.deepEqual([...d.tenantDb._s.databases.keys()], ["club_happy_dojo"]);

  const mail = await one("SELECT * FROM outbound_emails WHERE signup_id=$1", [id]);
  assert.equal(mail.status, "queued", "queued, not sent (emails disabled)");
  assert.equal(mail.to_email, "happy@example.com");
  assert.match(mail.body_text, /https:\/\/happy-dojo\.clubhonbu\.co\.uk\/admin\/login/);
  assert.doesNotMatch(mail.body_text, /\$2a\$/);
  const ev = await one("SELECT count(*)::int AS n FROM provisioning_events WHERE signup_id=$1", [id]);
  assert.ok(ev.n >= 8);
});

test("retry after partial failure resumes where it stopped, without duplicates", async () => {
  const id = await approvedSignup(env.db, { slug: "flaky-club", club: "Flaky Club", email: "flaky@example.com" });
  const d = deps({
    railway: createFakeRailway({ fail: { createService: ["throw-after-create"], createCustomDomain: [transientError()] } }),
    cloudflare: createFakeCloudflare({ fail: { createRecord: [null, "throw-after-create"] } }),
  });
  const cfg = testConfig();
  // attempt 1: service is created but the response is lost
  assert.equal(await workOnce({ store: env.store, deps: d, config: cfg, log: quiet }), "requeued");
  let job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.equal(job.status, "queued");
  assert.equal(job.attempts, 1);
  assert.equal(job.state.done.database, true);
  assert.equal(job.state.done.service, undefined);
  assert.match(job.last_error, /socket hang up/);
  const trialEnds1 = job.state.trialEndsAt;
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "provisioning");

  // attempt 2: finds the service by name, then the custom domain call fails (503)
  await makeRunnable(env.db);
  assert.equal(await workOnce({ store: env.store, deps: d, config: cfg, log: quiet }), "requeued");
  job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.equal(job.state.done.configure, true);
  assert.equal(job.state.done.domains, undefined);

  // attempt 3: domains ok; the 2nd DNS record is created but the response is lost.
  // max_attempts is 3, so allow one more manual retry like the HQ "Retry" button does.
  await makeRunnable(env.db);
  assert.equal(await workOnce({ store: env.store, deps: d, config: cfg, log: quiet }), "failed");
  await env.db.query(`UPDATE provisioning_jobs SET status='queued', attempts=0, run_after=now() WHERE signup_id=$1`, [id]);
  assert.equal(await workOnce({ store: env.store, deps: d, config: cfg, log: quiet }), "succeeded");

  job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.equal(job.state.trialEndsAt, trialEnds1, "trial end fixed on the first attempt");
  const rw = d.railway._s;
  assert.equal(rw.services.filter((s) => s.name === "club-flaky-club").length, 1, "one service");
  assert.equal(count(d.railway, "createService"), 1);
  assert.equal(rw.customDomains.length, 1, "one custom domain");
  assert.equal(rw.domains.length, 1, "one railway domain");
  assert.equal(rw.deployments.length, 1, "one deployment");
  assert.equal(d.cloudflare._s.records.length, 2, "two DNS records, none duplicated");
  assert.equal(d.tenantDb._s.databases.size, 1);
  assert.equal((await one("SELECT status FROM club_signups WHERE id=$1", [id])).status, "trial_active");
  assert.equal((await one("SELECT count(*)::int n FROM outbound_emails WHERE signup_id=$1", [id])).n, 1);
});

test("failed deployment: retry triggers a fresh deploy and succeeds", async () => {
  const id = await approvedSignup(env.db, { slug: "deploy-fail", club: "Deploy Fail FC", email: "df@example.com" });
  const railway = createFakeRailway({ deployOutcome: ["BUILDING", "FAILED"] });
  const d = deps({ railway });
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "requeued");
  let job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.match(job.last_error, /ended FAILED/);
  assert.equal(job.state.done.deploy, false);
  // the next deployment succeeds
  const origDeploy = railway.deploy;
  railway.deploy = async (a) => { const did = await origDeploy(a); railway._s.deployments.at(-1).statuses = ["DEPLOYING", "SUCCESS"]; return did; };
  await makeRunnable(env.db);
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "succeeded");
  assert.equal(railway._s.deployments.length, 2, "one failed + one fresh deployment");
  assert.equal(count(railway, "connectSource"), 1, "source connected once");
  assert.equal(railway._s.services.length, 1);
});

test("no duplicates: double approve = one job; concurrent workers = one runner; re-running a finished job creates nothing", async () => {
  const id = await approvedSignup(env.db, { slug: "dup-check", club: "Dup Check", email: "dup@example.com" });
  assert.equal(await approve(env.db, id, "dup-check"), 0, "second approve is a no-op");
  assert.equal((await one("SELECT count(*)::int n FROM provisioning_jobs WHERE signup_id=$1", [id])).n, 1);

  // two workers race for the same queue
  const [a, b] = await Promise.all([env.store.claimJob("w1"), env.store.claimJob("w2")]);
  assert.ok((a && !b) || (!a && b), "exactly one worker claims the job");
  const claimed = a || b;
  await env.db.query(`UPDATE provisioning_jobs SET status='queued', attempts=0, locked_by=NULL WHERE id=$1`, [claimed.id]);

  const d = deps();
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "succeeded");
  const calls = d.railway._s.calls.length;
  // someone re-queues the finished job (or a stale lease expires): nothing new is created
  await env.db.query(`UPDATE provisioning_jobs SET status='queued', run_after=now() WHERE id=$1`, [claimed.id]);
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "succeeded");
  assert.equal(d.railway._s.calls.length, calls, "no Railway calls at all on the re-run");
  assert.equal(d.railway._s.services.length, 1);

  // a crashed worker (expired lease) is resumed by another worker, still without duplicates
  const id2 = await approvedSignup(env.db, { slug: "crash-resume", club: "Crash Resume", email: "cr@example.com" });
  const d2 = deps({ railway: createFakeRailway({ fail: { connectSource: [new Error("worker killed")] } }) });
  await workOnce({ store: env.store, deps: d2, config: testConfig(), log: quiet });
  await env.db.query(`UPDATE provisioning_jobs SET status='running', locked_until=now() - interval '1 minute', run_after=now() WHERE signup_id=$1`, [id2]);
  assert.equal(await workOnce({ store: env.store, deps: d2, config: testConfig(), log: quiet }), "succeeded");
  assert.equal(d2.railway._s.services.length, 1);
  assert.equal(d2.cloudflare._s.records.length, 2);
});

test("permanent problems fail fast: foreign DNS record, rejected sign-up, reserved slug", async () => {
  const id = await approvedSignup(env.db, { slug: "taken-name", club: "Taken", email: "t@example.com" });
  const cf = createFakeCloudflare({ existing: [{ type: "CNAME", name: "taken-name.clubhonbu.co.uk", content: "someone-else.example.net", comment: "" }] });
  assert.equal(await workOnce({ store: env.store, deps: deps({ cloudflare: cf }), config: testConfig(), log: quiet }), "failed");
  const job = await one("SELECT * FROM provisioning_jobs WHERE signup_id=$1", [id]);
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /not managed by HQ/);
  assert.equal(cf._s.records[0].content, "someone-else.example.net", "foreign record untouched");

  const id2 = await approvedSignup(env.db, { slug: "rejected-one", club: "Rejected", email: "r@example.com" });
  await env.db.query(`UPDATE club_signups SET status='rejected' WHERE id=$1`, [id2]);
  const d = deps();
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig(), log: quiet }), "failed");
  assert.equal(d.railway._s.calls.length, 0, "nothing created for a rejected sign-up");

  const id3 = await approvedSignup(env.db, { slug: "admin", club: "Sneaky", email: "s@example.com" });
  assert.equal(await workOnce({ store: env.store, deps: deps(), config: testConfig(), log: quiet }), "failed");
  assert.match((await one("SELECT last_error FROM provisioning_jobs WHERE signup_id=$1", [id3])).last_error, /reserved/);
});

test("welcome email is only sent when WELCOME_EMAIL_ENABLED, once, with an idempotency key", async () => {
  const sent = [];
  const resend = { async send(m) { sent.push(m); return `re_${sent.length}`; } };
  const queued = (await one("SELECT count(*)::int n FROM outbound_emails WHERE status='queued'")).n;
  assert.ok(queued >= 1);
  assert.equal(await sendQueuedEmails({ store: env.store, resend, config: testConfig(), log: quiet }), 0, "disabled: nothing sent");
  const on = testConfig({ email: { ...testConfig().email, enabled: true } });
  assert.equal(await sendQueuedEmails({ store: env.store, resend, config: on, log: quiet }), queued);
  assert.equal(await sendQueuedEmails({ store: env.store, resend, config: on, log: quiet }), 0, "not sent twice");
  assert.match(sent[0].idempotencyKey, /^outbound-email-\d+$/);
  assert.equal((await one("SELECT count(*)::int n FROM outbound_emails WHERE status='sent' AND provider_id IS NOT NULL")).n, queued);
});

test("BASE_DOMAIN on a subdomain (staging): Railway's zone-relative verify host is not doubled", async () => {
  await approvedSignup(env.db, { slug: "stage-dojo", club: "Stage Dojo", email: "stage@example.com" });
  const d = deps();
  assert.equal(await workOnce({ store: env.store, deps: d, config: testConfig({ baseDomain: "staging.clubhonbu.co.uk" }), log: quiet }), "succeeded");
  const recs = d.cloudflare._s.records.map((r) => `${r.type} ${r.name}`).sort();
  assert.deepEqual(recs, ["CNAME stage-dojo.staging.clubhonbu.co.uk", "TXT _railway-verify.stage-dojo.staging.clubhonbu.co.uk"]);
});

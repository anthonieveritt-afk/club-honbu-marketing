import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freshHqDb, approvedSignup } from "./helpers.js";

const run = promisify(execFile);
let env;
before(async () => { env = await freshHqDb("dry"); });
after(async () => { await env.drop(); });

test("dry-run prints the plan and writes nothing", async () => {
  const id = await approvedSignup(env.db, { slug: "dry-dojo", club: "Dry Dojo" });
  const snapshot = async () => JSON.stringify((await env.db.query(
    `SELECT (SELECT json_agg(s ORDER BY id) FROM club_signups s) a, (SELECT json_agg(j ORDER BY id) FROM provisioning_jobs j) b,
            (SELECT count(*) FROM provisioning_events) c, (SELECT count(*) FROM outbound_emails) d`)).rows[0]);
  const before = await snapshot();
  const { stdout } = await run("node", ["src/cli.js", "dry-run", String(id)], {
    env: { PATH: process.env.PATH, HQ_DATABASE_URL: env.url }, cwd: new URL("..", import.meta.url).pathname,
  });
  assert.match(stdout, /DRY RUN for signup \d+ "Dry Dojo"/);
  assert.match(stdout, /would call: railway\.createService .*"name":"club-dry-dojo"/);
  assert.match(stdout, /would call: tenantDb\.ensureDatabase club_dry_dojo/);
  assert.match(stdout, /would call: cloudflare\.createRecord .*dry-dojo\.clubhonbu\.co\.uk/);
  assert.match(stdout, /ADMIN_PASSWORD_HASH=\*\*\*/);
  assert.match(stdout, /CLUB_PROFILE=neutral/);
  assert.match(stdout, /Welcome email queued \(not sent\)/);
  assert.equal(await snapshot(), before, "HQ database unchanged");
});

test("DRY_RUN=1 run/once/sweep = read-only observe mode: prints the lifecycle plan, writes nothing", async () => {
  const id = await approvedSignup(env.db, { slug: "observe-me", club: "Observe Me", email: "obs@example.com" });
  // pretend it was provisioned 8 days ago: its trial is over
  await env.db.query(`UPDATE club_signups SET status='trial_active', trial_ends_at=now() - interval '1 hour' WHERE id=$1`, [id]);
  const snapshot = async () => JSON.stringify((await env.db.query(
    `SELECT (SELECT json_agg(s ORDER BY id) FROM club_signups s) a, (SELECT json_agg(j ORDER BY id) FROM provisioning_jobs j) b,
            (SELECT count(*) FROM provisioning_events) c, (SELECT count(*) FROM outbound_emails) d`)).rows[0]);
  const before = await snapshot();
  for (const cmd of ["once", "sweep", "plan"]) {
    const { stdout } = await run("node", ["src/cli.js", cmd], {
      env: { PATH: process.env.PATH, HQ_DATABASE_URL: env.url, DRY_RUN: "1" }, cwd: new URL("..", import.meta.url).pathname,
    });
    assert.match(stdout, /read-only/);
    assert.match(stdout, new RegExp(`would mark #${id} Observe Me \\(observe-me\\) expired`), stdout);
    assert.match(stdout, /trial 7d, grace 7d, reminders 2\/1d/);
  }
  assert.equal(await snapshot(), before, "HQ database unchanged");
});

test("live mode refuses to start without CLUB_SOURCE_BRANCH (club-honbu main has no trial code)", async () => {
  const r = await run("node", ["src/cli.js", "once"], {
    env: { PATH: process.env.PATH, HQ_DATABASE_URL: env.url, WORKER_SECRET: "x".repeat(40), RAILWAY_API_TOKEN: "t", TENANT_PROJECT_ID: "p",
      TENANT_ENVIRONMENT_ID: "e", TENANT_PG_ADMIN_URL: "postgres://x@127.0.0.1:1/x", CLOUDFLARE_API_TOKEN: "c", CLOUDFLARE_ZONE_ID: "z" },
    cwd: new URL("..", import.meta.url).pathname,
  }).catch((e) => e);
  assert.notEqual(r.code ?? 0, 0);
  assert.match(String(r.stderr), /CLUB_SOURCE_BRANCH/);
});

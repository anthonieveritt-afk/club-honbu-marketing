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

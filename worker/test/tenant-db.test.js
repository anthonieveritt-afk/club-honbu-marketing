import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createTenantDb, tenantDatabaseUrl } from "../src/tenant-db.js";
import { ADMIN_URL } from "./helpers.js";

test("real tenant DB: creates role + database once, isolates it, idempotent on re-run", async () => {
  const dbName = `club_tenanttest_${process.pid}`;
  const roleName = `${dbName}_app`;
  const password = "Abc123def456ghi789jkl012";
  const t = createTenantDb({ adminUrl: ADMIN_URL });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    assert.equal(await t.ensureDatabase({ dbName, roleName, password }), true);
    assert.equal(await t.ensureDatabase({ dbName, roleName, password }), false, "second call creates nothing");
    const owner = (await admin.query(`SELECT pg_get_userbyid(datdba) o FROM pg_database WHERE datname=$1`, [dbName])).rows[0].o;
    assert.equal(owner, roleName);
    const acl = (await admin.query(`SELECT datacl::text a FROM pg_database WHERE datname=$1`, [dbName])).rows[0].a;
    const publicPrivs = (acl.match(/(?:^|[{,])=([A-Za-z*]*)\//) || [, ""])[1];
    assert.ok(!publicPrivs.includes("c"), `PUBLIC has no CONNECT (acl ${acl})`);
    const url = tenantDatabaseUrl({ appHost: "127.0.0.1:5544", dbName, roleName, password });
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    assert.equal((await c.query("select current_database() d")).rows[0].d, dbName);
    await c.end();
    await assert.rejects(t.ensureDatabase({ dbName: "x; drop", roleName, password }), /Unsafe/);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`);
    await admin.end();
  }
});

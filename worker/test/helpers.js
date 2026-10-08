import pg from "pg";
import fs from "node:fs";
import { SCHEMA_PATH, createPgStore } from "../src/store.js";

export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || "postgresql://postgres@127.0.0.1:5544/postgres";

export async function freshHqDb(label) {
  const name = `hqtest_${label}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const store = createPgStore({ connectionString: url });
  await store.db.query(fs.readFileSync(SCHEMA_PATH, "utf8"));
  return {
    name, url, store, db: store.db,
    async drop() {
      await store.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const HASH = "$2a$12$abcdefghijklmnopqrstuuJ2bW9b8m1gm3yQ0e8uK0Tq7VZ8m0Dq6"; // dummy bcrypt-format hash

/** Inserts a sign-up and approves it exactly like the marketing site does (status + slug + job). */
export async function approvedSignup(db, { slug = "test-dojo", club = "Test Dojo", email = "owner@example.com" } = {}) {
  const { rows } = await db.query(
    `INSERT INTO club_signups (club_name, sport_type, contact_name, email, website, admin_username, password_hash)
     VALUES ($1, 'Martial Arts', 'Olive Owner', $2, 'testdojo.example', 'owner', $3) RETURNING id`,
    [club, email, HASH]
  );
  const id = rows[0].id;
  await approve(db, id, slug);
  return id;
}

export async function approve(db, id, slug) {
  // Mirrors approveSignup() in lib/signups.ts on the site.
  await db.query("BEGIN");
  try {
    const r = await db.query(
      `UPDATE club_signups SET status='approved', slug=$2, decided_at=now(), updated_at=now()
        WHERE id=$1 AND status IN ('new','contacted') RETURNING id`, [id, slug]);
    await db.query(
      `INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, 'provision') ON CONFLICT (signup_id, kind) DO NOTHING`, [id]);
    await db.query("COMMIT");
    return r.rowCount;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}

export function testConfig(overrides = {}) {
  return {
    workerId: "test-worker",
    workerSecret: "test-secret-test-secret-test-secret-0123",
    trialDays: 7,
    lifecycle: { enabled: true, sweepIntervalMs: 0, graceDays: 7, reminderDays: [2, 1], teardownEnabled: true },
    baseDomain: "clubhonbu.co.uk",
    railway: { projectId: "proj_tenants", environmentId: "env_prod", region: "europe-west4-drams3a", sleepApplication: true,
      sourceRepo: "anthonieveritt-afk/club-honbu", sourceBranch: "feat/trial-instance", sourceImage: "", appPort: 8080 },
    tenantDb: { appHost: "postgres.railway.internal:5432" },
    health: { deployTimeoutMs: 1000, healthTimeoutMs: 1000, customDomainTimeoutMs: 100, intervalMs: 0 },
    email: { enabled: false, from: "Club Honbu <hello@clubhonbu.co.uk>", replyTo: "hello@clubhonbu.co.uk" },
    trialUpgradeUrl: "",
    contactEmail: "hello@clubhonbu.co.uk",
    ...overrides,
  };
}

export async function makeRunnable(db) {
  await db.query(`UPDATE provisioning_jobs SET run_after = now() WHERE status = 'queued'`);
}

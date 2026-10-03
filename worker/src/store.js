import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
// Same schema file the marketing site applies (club_signups + HQ tables). Idempotent.
export const SCHEMA_PATH = process.env.HQ_SCHEMA_PATH || path.resolve(here, "../../db/schema.sql");

const BACKOFF_MINUTES = [1, 5, 15, 60];

/** Postgres-backed store (the HQ database: Neon). */
export function createPgStore({ connectionString, pool } = {}) {
  const db = pool || new pg.Pool({ connectionString, max: 3 });
  return {
    db,
    async ensureSchema() {
      await db.query(fs.readFileSync(SCHEMA_PATH, "utf8"));
    },
    async end() { await db.end(); },

    // ── jobs ──
    async claimJob(workerId, leaseMinutes = 30) {
      const { rows } = await db.query(
        `UPDATE provisioning_jobs j
            SET status = 'running', locked_by = $1, locked_until = now() + ($2 || ' minutes')::interval,
                attempts = attempts + 1, updated_at = now()
          WHERE j.id = (
            SELECT id FROM provisioning_jobs
             WHERE (status = 'queued' AND run_after <= now())
                OR (status = 'running' AND locked_until < now())   -- crashed worker: resume
             ORDER BY run_after, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
        RETURNING j.*`,
        [workerId, String(leaseMinutes)]
      );
      return rows[0] || null;
    },
    async saveJobProgress(jobId, step, state) {
      await db.query(
        `UPDATE provisioning_jobs SET current_step = $2, state = $3::jsonb, updated_at = now() WHERE id = $1`,
        [jobId, step, JSON.stringify(state)]
      );
    },
    async completeJob(jobId, state) {
      await db.query(
        `UPDATE provisioning_jobs SET status = 'succeeded', state = $2::jsonb, current_step = 'done',
                last_error = NULL, locked_by = NULL, locked_until = NULL, finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [jobId, JSON.stringify(state)]
      );
    },
    /** Requeues with backoff while attempts remain and the error is retryable; else marks failed. */
    async failJob(job, error, { retryable = true } = {}) {
      const msg = String(error?.message || error).slice(0, 2000);
      const giveUp = !retryable || job.attempts >= job.max_attempts;
      const delay = BACKOFF_MINUTES[Math.min(job.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 1;
      await db.query(
        `UPDATE provisioning_jobs
            SET status = $2, last_error = $3, locked_by = NULL, locked_until = NULL,
                run_after = now() + ($4 || ' minutes')::interval,
                finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [job.id, giveUp ? "failed" : "queued", msg, String(delay)]
      );
      return giveUp ? "failed" : "requeued";
    },
    async getJob(jobId) {
      return (await db.query(`SELECT * FROM provisioning_jobs WHERE id = $1`, [jobId])).rows[0] || null;
    },

    // ── sign-ups ──
    async getSignup(id) {
      return (await db.query(`SELECT * FROM club_signups WHERE id = $1`, [id])).rows[0] || null;
    },
    async markSignupProvisioning(id) {
      await db.query(
        `UPDATE club_signups SET status = 'provisioning', updated_at = now()
          WHERE id = $1 AND status IN ('approved', 'provisioning')`,
        [id]
      );
    },
    async finalizeSignup({ signupId, instanceUrl, railwayUrl, trialEndsAt }) {
      await db.query(
        `UPDATE club_signups
            SET status = 'trial_active', instance_url = $2, railway_url = $3, trial_ends_at = $4,
                provisioned_at = COALESCE(provisioned_at, now()),
                password_hash = NULL,           -- the club's instance has it now; don't keep a copy
                updated_at = now()
          WHERE id = $1`,
        [signupId, instanceUrl, railwayUrl, trialEndsAt]
      );
    },
    async logEvent({ jobId, signupId, step, level = "info", message }) {
      await db.query(
        `INSERT INTO provisioning_events (job_id, signup_id, step, level, message) VALUES ($1,$2,$3,$4,$5)`,
        [jobId, signupId, step, level, String(message).slice(0, 2000)]
      );
    },

    // ── email outbox ──
    async queueEmail({ signupId, kind, to, subject, text, html }) {
      await db.query(
        `INSERT INTO outbound_emails (signup_id, kind, to_email, subject, body_text, body_html)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (signup_id, kind) DO NOTHING`,
        [signupId, kind, to, subject, text, html]
      );
    },
    async claimQueuedEmails(limit = 10) {
      return (await db.query(
        `SELECT * FROM outbound_emails WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT $1`, [limit]
      )).rows;
    },
    async markEmail(id, { status, providerId = null, error = null }) {
      await db.query(
        `UPDATE outbound_emails SET status = $2, provider_id = COALESCE($3, provider_id), last_error = $4,
                attempts = attempts + 1, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
          WHERE id = $1`,
        [id, status, providerId, error]
      );
    },
  };
}

/** In-memory store with the same interface (dry-run and fast unit tests). */
export function createMemoryStore({ signups = [], jobs = [] } = {}) {
  const s = {
    signups: new Map(signups.map((x) => [String(x.id), { ...x }])),
    jobs: new Map(jobs.map((j) => [String(j.id), { status: "queued", attempts: 0, max_attempts: 3, state: {}, ...j }])),
    events: [], emails: [],
  };
  return {
    _s: s,
    async claimJob(workerId) {
      const j = [...s.jobs.values()].find((x) => x.status === "queued");
      if (!j) return null;
      Object.assign(j, { status: "running", locked_by: workerId, attempts: j.attempts + 1 });
      return { ...j, state: structuredClone(j.state) };
    },
    async saveJobProgress(id, step, state) { Object.assign(s.jobs.get(String(id)) || {}, { current_step: step, state: structuredClone(state) }); },
    async completeJob(id, state) { Object.assign(s.jobs.get(String(id)) || {}, { status: "succeeded", state: structuredClone(state), last_error: null }); },
    async failJob(job, error, { retryable = true } = {}) {
      const j = s.jobs.get(String(job.id));
      const giveUp = !retryable || job.attempts >= job.max_attempts;
      Object.assign(j, { status: giveUp ? "failed" : "queued", last_error: String(error?.message || error) });
      return giveUp ? "failed" : "requeued";
    },
    async getJob(id) { return s.jobs.get(String(id)) || null; },
    async getSignup(id) { return s.signups.get(String(id)) || null; },
    async markSignupProvisioning(id) {
      const x = s.signups.get(String(id));
      if (x && ["approved", "provisioning"].includes(x.status)) x.status = "provisioning";
    },
    async finalizeSignup({ signupId, instanceUrl, railwayUrl, trialEndsAt }) {
      Object.assign(s.signups.get(String(signupId)), { status: "trial_active", instance_url: instanceUrl, railway_url: railwayUrl, trial_ends_at: trialEndsAt, password_hash: null });
    },
    async logEvent(e) { s.events.push(e); },
    async queueEmail(e) {
      if (!s.emails.find((x) => x.signupId === e.signupId && x.kind === e.kind)) s.emails.push({ ...e, status: "queued" });
    },
    async claimQueuedEmails() { return s.emails.filter((e) => e.status === "queued"); },
    async markEmail() {},
  };
}

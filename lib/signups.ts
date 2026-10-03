import "server-only";
import { createHash } from "node:crypto";
import { getPool } from "./db";
import { SCHEMA_SQL } from "./schema";
import { isValidSlug } from "./slug";

export type SignupStatus =
  | "new"
  | "contacted"
  | "approved"
  | "provisioning"
  | "trial_active"
  | "converted"
  | "expired"
  | "rejected";

export interface SignupRow {
  id: string;
  created_at: Date;
  club_name: string;
  sport_type: string;
  contact_name: string;
  email: string;
  website: string | null;
  admin_username: string;
  status: SignupStatus;
  notified_at: Date | null;
  slug: string | null;
  decided_at: Date | null;
  rejected_reason: string | null;
  instance_url: string | null;
  railway_url: string | null;
  trial_ends_at: Date | null;
  job_id: string | null;
  job_status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | null;
  job_step: string | null;
  job_attempts: number | null;
  job_error: string | null;
}

// Rate limits (per salted IP hash / per email address).
export const LIMITS = {
  perIpPerHour: Number(process.env.SIGNUP_LIMIT_PER_IP_HOUR || 5),
  perEmailPerDay: Number(process.env.SIGNUP_LIMIT_PER_EMAIL_DAY || 3),
};

let schemaReady: Promise<void> | null = null;

export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  if (!schemaReady) {
    schemaReady = pool.query(SCHEMA_SQL).then(() => undefined);
    schemaReady.catch(() => {
      schemaReady = null; // retry next time
    });
  }
  return schemaReady;
}

export function hashIp(ip: string): string {
  const salt = process.env.SIGNUP_HASH_SALT || "club-honbu-signup";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

/** Records an attempt and returns false if the caller is over a limit. */
export async function checkRateLimit(ipHash: string, email: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  await ensureSchema();
  const { rows } = await pool.query<{ ip_count: string; email_count: string }>(
    `SELECT
       (SELECT count(*) FROM signup_attempts
         WHERE ip_hash = $1 AND created_at > now() - interval '1 hour') AS ip_count,
       (SELECT count(*) FROM signup_attempts
         WHERE lower(email) = lower($2) AND created_at > now() - interval '1 day') AS email_count`,
    [ipHash, email]
  );
  const ipCount = Number(rows[0].ip_count);
  const emailCount = Number(rows[0].email_count);
  if (ipCount >= LIMITS.perIpPerHour || emailCount >= LIMITS.perEmailPerDay) return false;
  await pool.query(`INSERT INTO signup_attempts (ip_hash, email) VALUES ($1, $2)`, [ipHash, email]);
  // Opportunistic pruning keeps the table tiny.
  if (Math.random() < 0.1) {
    await pool.query(`DELETE FROM signup_attempts WHERE created_at < now() - interval '2 days'`);
  }
  return true;
}

export async function insertSignup(s: {
  clubName: string;
  sportType: string;
  contactName: string;
  email: string;
  website: string;
  adminUsername: string;
  passwordHash: string;
  ipHash: string;
  userAgent: string;
}): Promise<string> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  await ensureSchema();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO club_signups
       (club_name, sport_type, contact_name, email, website, admin_username,
        password_hash, ip_hash, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      s.clubName,
      s.sportType,
      s.contactName,
      s.email,
      s.website || null,
      s.adminUsername,
      s.passwordHash,
      s.ipHash,
      s.userAgent.slice(0, 300),
    ]
  );
  return rows[0].id;
}

export async function markNotified(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`UPDATE club_signups SET notified_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

export async function listSignups(limit = 500): Promise<SignupRow[]> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  await ensureSchema();
  const { rows } = await pool.query<SignupRow>(
    `SELECT s.id, s.created_at, s.club_name, s.sport_type, s.contact_name, s.email, s.website,
            s.admin_username, s.status, s.notified_at, s.slug, s.decided_at, s.rejected_reason,
            s.instance_url, s.railway_url, s.trial_ends_at,
            j.id AS job_id, j.status AS job_status, j.current_step AS job_step,
            j.attempts AS job_attempts, j.last_error AS job_error
       FROM club_signups s
       LEFT JOIN provisioning_jobs j ON j.signup_id = s.id AND j.kind = 'provision'
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── HQ actions (called from /admin/signups server actions, admin-only) ───────────────────────
// Vercel never calls Railway/Cloudflare: approving only writes a provisioning_jobs row, which the
// worker (worker/) polls and executes.

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

async function inTransaction<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((sql, params) => client.query(sql, params as any[]));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** new/contacted → approved, with a slug, and exactly one queued provisioning job. Idempotent. */
export async function approveSignup(id: string, rawSlug: string): Promise<ActionResult> {
  const slug = String(rawSlug || "").trim().toLowerCase();
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  if (!isValidSlug(slug)) {
    return { ok: false, error: `"${slug}" is not a usable subdomain (3–30 chars, a–z, 0–9 and single hyphens, not reserved).` };
  }
  try {
    return await inTransaction(async (q) => {
      const cur = (await q(`SELECT id, status, slug FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) return { ok: false, error: "Sign-up not found." };
      if (cur.status === "approved" || cur.status === "provisioning" || cur.status === "trial_active") {
        // Double-click / second admin: make sure the job exists, change nothing else.
        await q(`INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, 'provision') ON CONFLICT (signup_id, kind) DO NOTHING`, [id]);
        return { ok: true, message: `Already ${cur.status} (${cur.slug}). No duplicate job created.` };
      }
      if (cur.status !== "new" && cur.status !== "contacted") {
        return { ok: false, error: `Cannot approve a sign-up that is ${cur.status}.` };
      }
      const taken = (await q(`SELECT id FROM club_signups WHERE slug = $1 AND id <> $2`, [slug, id])).rows[0];
      if (taken) return { ok: false, error: `Subdomain "${slug}" is already used by sign-up #${taken.id}.` };
      await q(
        `UPDATE club_signups SET status = 'approved', slug = $2, decided_at = now(), rejected_reason = NULL,
                updated_at = now() WHERE id = $1`,
        [id, slug]
      );
      const job = await q(
        `INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, 'provision')
         ON CONFLICT (signup_id, kind) DO NOTHING RETURNING id`,
        [id]
      );
      await q(
        `INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'approve', $3)`,
        [job.rows[0]?.id ?? null, id, `Approved as ${slug}; provisioning job queued`]
      );
      return { ok: true, message: `Approved #${id} as ${slug}. Provisioning job queued for the worker.` };
    });
  } catch (err: any) {
    if (err?.code === "23505") return { ok: false, error: `Subdomain "${slug}" is already taken.` };
    throw err;
  }
}

/** new/contacted/approved (job not started) → rejected. Clears the stored password hash. */
export async function rejectSignup(id: string, reason: string): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  const why = String(reason || "").trim().slice(0, 500) || null;
  return inTransaction(async (q) => {
    const cur = (await q(`SELECT id, status FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) return { ok: false, error: "Sign-up not found." };
    if (cur.status === "rejected") return { ok: true, message: `#${id} was already rejected.` };
    if (!["new", "contacted", "approved"].includes(cur.status)) {
      return { ok: false, error: `Cannot reject a sign-up that is ${cur.status}.` };
    }
    const job = (await q(`SELECT id, status FROM provisioning_jobs WHERE signup_id = $1 AND kind = 'provision' FOR UPDATE`, [id])).rows[0];
    if (job && job.status !== "queued" && job.status !== "cancelled") {
      return { ok: false, error: `Provisioning has already started (job ${job.status}); cannot reject here.` };
    }
    if (job) {
      await q(`UPDATE provisioning_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1`, [job.id]);
    }
    await q(
      `UPDATE club_signups SET status = 'rejected', rejected_reason = $2, decided_at = now(),
              password_hash = NULL, slug = NULL, updated_at = now() WHERE id = $1`,
      [id, why]
    );
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'reject', $3)`,
      [job?.id ?? null, id, `Rejected${why ? `: ${why}` : ""}`]);
    return { ok: true, message: `Rejected #${id}.` };
  });
}

/** failed job → queued again (resumes from the failed step; the worker keeps its state). */
export async function retryJob(id: string): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  return inTransaction(async (q) => {
    const r = await q(
      `UPDATE provisioning_jobs SET status = 'queued', attempts = 0, run_after = now(), finished_at = NULL,
              updated_at = now()
        WHERE signup_id = $1 AND kind = 'provision' AND status = 'failed' RETURNING id`,
      [id]
    );
    if (!r.rowCount) return { ok: false, error: "No failed job to retry." };
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'retry', 'Retry requested by admin')`,
      [r.rows[0].id, id]);
    return { ok: true, message: `Job for #${id} re-queued.` };
  });
}

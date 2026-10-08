import "server-only";
import { createHash } from "node:crypto";
import { getPool } from "./db";
import { SCHEMA_SQL } from "./schema";
import { isValidSlug, slugCandidates } from "./slug";

export type SignupStatus =
  | "new"
  | "contacted"
  | "approved"
  | "provisioning"
  | "trial_active"
  | "converted"
  | "expired"
  | "rejected"
  | "removing"
  | "removed";

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
  auto_approved: boolean;
  expired_at: Date | null;
  teardown_after: Date | null;
  converted_at: Date | null;
  removal_requested_at: Date | null;
  removed_at: Date | null;
  trial_extended_days: number;
  teardown_status: JobStatus | null;
  teardown_step: string | null;
  teardown_error: string | null;
  sync_status: JobStatus | null;
  sync_error: string | null;
  last_event: string | null;
  last_event_level: "info" | "warn" | "error" | null;
  last_event_at: Date | null;
}

type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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
            s.auto_approved, s.expired_at, s.teardown_after, s.converted_at, s.removal_requested_at,
            s.removed_at, s.trial_extended_days,
            j.id AS job_id, j.status AS job_status, j.current_step AS job_step,
            j.attempts AS job_attempts, j.last_error AS job_error,
            t.status AS teardown_status, t.current_step AS teardown_step, t.last_error AS teardown_error,
            y.status AS sync_status, y.last_error AS sync_error,
            e.message AS last_event, e.level AS last_event_level, e.created_at AS last_event_at
       FROM club_signups s
       LEFT JOIN provisioning_jobs j ON j.signup_id = s.id AND j.kind = 'provision'
       LEFT JOIN provisioning_jobs t ON t.signup_id = s.id AND t.kind = 'teardown'
       LEFT JOIN provisioning_jobs y ON y.signup_id = s.id AND y.kind = 'sync_trial'
       LEFT JOIN LATERAL (SELECT message, level, created_at FROM provisioning_events
                           WHERE signup_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) e ON true
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
export async function retryJob(id: string, kind: "provision" | "teardown" | "sync_trial" = "provision"): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  if (!["provision", "teardown", "sync_trial"].includes(kind)) return { ok: false, error: "Bad job kind." };
  return inTransaction(async (q) => {
    const r = await q(
      `UPDATE provisioning_jobs SET status = 'queued', attempts = 0, run_after = now(), finished_at = NULL,
              updated_at = now()
        WHERE signup_id = $1 AND kind = $2 AND status = 'failed' RETURNING id`,
      [id, kind]
    );
    if (!r.rowCount) return { ok: false, error: "No failed job to retry." };
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'retry', $3)`,
      [r.rows[0].id, id, `Retry of ${kind} requested by admin`]);
    return { ok: true, message: `${kind === "provision" ? "Job" : kind === "teardown" ? "Teardown" : "Trial sync"} for #${id} re-queued.` };
  });
}

// ── Auto-approve (AUTO_APPROVE_SIGNUPS=1) ───────────────────────────────────────────────────────

export function autoApproveEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.AUTO_APPROVE_SIGNUPS || "");
}
const AUTO_APPROVE_MAX_PER_DAY = () => Number(process.env.AUTO_APPROVE_MAX_PER_DAY || 20);

/**
 * Approves a fresh sign-up with a unique subdomain derived from the club name, so the worker
 * provisions it straight away. Same code path as the manual Approve button. If anything is off
 * (daily cap reached, no usable subdomain, DB error) the sign-up simply stays "new" for a person.
 */
export async function autoApproveSignup(id: string, clubName: string): Promise<ActionResult> {
  const pool = getPool();
  if (!pool) return { ok: false, error: "DATABASE_URL is not set" };
  await ensureSchema();
  const recent = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM club_signups WHERE auto_approved AND decided_at > now() - interval '1 day'`
  );
  if (Number(recent.rows[0].n) >= AUTO_APPROVE_MAX_PER_DAY()) {
    await logEvent(id, "auto-approve", `Daily auto-approve cap (${AUTO_APPROVE_MAX_PER_DAY()}) reached; left for manual approval`, "warn");
    return { ok: false, error: "Auto-approve daily cap reached." };
  }
  const taken = new Set(
    (await pool.query<{ slug: string }>(`SELECT slug FROM club_signups WHERE slug IS NOT NULL AND id <> $1`, [id])).rows.map((r) => r.slug)
  );
  for (const slug of slugCandidates(clubName, id)) {
    if (taken.has(slug)) continue;
    const r = await approveSignup(id, slug);
    if (r.ok) {
      await pool.query(`UPDATE club_signups SET auto_approved = true, updated_at = now() WHERE id = $1 AND slug = $2`, [id, slug]);
      await logEvent(id, "auto-approve", `Auto-approved as ${slug} (AUTO_APPROVE_SIGNUPS)`);
      return { ok: true, message: `Auto-approved as ${slug}` };
    }
    if (!/already (used|taken)/.test(r.error)) {
      await logEvent(id, "auto-approve", `Auto-approve failed: ${r.error}`, "warn");
      return r;
    }
    taken.add(slug); // lost a race for this subdomain: try the next candidate
  }
  await logEvent(id, "auto-approve", "No free subdomain found; left for manual approval", "warn");
  return { ok: false, error: "No free subdomain found." };
}

async function logEvent(signupId: string, step: string, message: string, level: "info" | "warn" | "error" = "info") {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`INSERT INTO provisioning_events (signup_id, step, level, message) VALUES ($1, $2, $3, $4)`, [signupId, step, level, message]);
}

// ── Trial lifecycle admin actions ───────────────────────────────────────────────────────────────
// They only change club_signups and queue jobs; the worker does the Railway/Cloudflare/Postgres work.

const MAX_EXTEND_DAYS = 60;

async function queueJob(q: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>, id: string, kind: string, requeueFrom: string[]) {
  return (await q(
    `INSERT INTO provisioning_jobs (signup_id, kind) VALUES ($1, $2)
     ON CONFLICT (signup_id, kind) DO UPDATE
        SET status = 'queued', attempts = 0, run_after = now(), state = '{}'::jsonb, last_error = NULL,
            finished_at = NULL, locked_by = NULL, locked_until = NULL, current_step = NULL, updated_at = now()
      WHERE provisioning_jobs.status = ANY($3::text[])
     RETURNING id`,
    [id, kind, requeueFrom]
  )).rows[0]?.id ?? null;
}

/** Cancels a teardown that hasn't started yet. Returns an error string if it already started. */
async function stopPendingTeardown(q: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>, id: string): Promise<string | null> {
  const t = (await q(`SELECT id, status, state FROM provisioning_jobs WHERE signup_id = $1 AND kind = 'teardown' FOR UPDATE`, [id])).rows[0];
  if (!t) return null;
  const started = t.status === "running" || t.status === "succeeded" || Object.keys(t.state?.done || {}).length > 0;
  if (started) return `Removal has already started (teardown ${t.status}); it can't be stopped from here.`;
  if (t.status !== "cancelled") {
    await q(`UPDATE provisioning_jobs SET status = 'cancelled', last_error = 'Cancelled by admin', finished_at = now(), updated_at = now() WHERE id = $1`, [t.id]);
  }
  return null;
}

/** trial_active/expired (or removing before teardown starts) → trial_active with a later end. */
export async function extendTrial(id: string, rawDays: string | number): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) return { ok: false, error: `Extend by 1–${MAX_EXTEND_DAYS} whole days.` };
  return inTransaction(async (q) => {
    const cur = (await q(`SELECT id, status, trial_ends_at, converted_at FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) return { ok: false, error: "Sign-up not found." };
    if (!["trial_active", "expired", "removing"].includes(cur.status) || !cur.trial_ends_at) {
      return { ok: false, error: `Cannot extend a sign-up that is ${cur.status}.` };
    }
    const blocked = await stopPendingTeardown(q, id);
    if (blocked) return { ok: false, error: blocked };
    // From the later of the current end and now, so extending an expired trial gives real days.
    const upd = (await q(
      `UPDATE club_signups
          SET trial_ends_at = GREATEST(trial_ends_at, now()) + ($2::numeric * interval '24 hours'),
              status = 'trial_active', expired_at = NULL, teardown_after = NULL, removal_requested_at = NULL,
              trial_extended_days = trial_extended_days + $2::int, updated_at = now()
        WHERE id = $1 RETURNING trial_ends_at`,
      [id, String(days)]
    )).rows[0];
    const jobId = await queueJob(q, id, "sync_trial", ["queued", "succeeded", "failed", "cancelled"]);
    const ends = new Date(upd.trial_ends_at).toISOString();
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'extend', $3)`,
      [jobId, id, `Trial extended by ${days} day(s) to ${ends} by admin${jobId ? "; sync job queued" : " (sync job already running; it re-checks)"}`]);
    return { ok: true, message: `Extended #${id} by ${days} day(s). New end: ${ends}.` };
  });
}

/** Paying club (handled outside the system for now): never torn down, trial vars removed from the instance. */
export async function markConverted(id: string): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  return inTransaction(async (q) => {
    const cur = (await q(`SELECT id, status FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) return { ok: false, error: "Sign-up not found." };
    if (cur.status === "converted") return { ok: true, message: `#${id} is already converted.` };
    if (!["trial_active", "expired", "removing"].includes(cur.status)) {
      return { ok: false, error: `Cannot mark a sign-up that is ${cur.status} as converted.` };
    }
    const blocked = await stopPendingTeardown(q, id);
    if (blocked) return { ok: false, error: blocked };
    await q(
      `UPDATE club_signups SET status = 'converted', converted_at = now(), teardown_after = NULL,
              removal_requested_at = NULL, updated_at = now() WHERE id = $1`,
      [id]
    );
    const jobId = await queueJob(q, id, "sync_trial", ["queued", "succeeded", "failed", "cancelled"]);
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'convert', $3)`,
      [jobId, id, "Marked converted by admin: will never be torn down; trial limits removed from the instance"]);
    return { ok: true, message: `#${id} marked converted. It will never be removed automatically.` };
  });
}

/** Start teardown immediately (skips the rest of the trial and the grace period). Needs the subdomain typed in. */
export async function deleteNow(id: string, confirmSlug: string): Promise<ActionResult> {
  if (!/^\d+$/.test(String(id))) return { ok: false, error: "Bad sign-up id." };
  return inTransaction(async (q) => {
    const cur = (await q(`SELECT id, status, slug, converted_at FROM club_signups WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) return { ok: false, error: "Sign-up not found." };
    if (cur.converted_at || cur.status === "converted") return { ok: false, error: "Converted clubs are never deleted from here." };
    if (cur.status === "removing" || cur.status === "removed") return { ok: true, message: `#${id} is already ${cur.status}.` };
    const prov = (await q(`SELECT status FROM provisioning_jobs WHERE signup_id = $1 AND kind = 'provision'`, [id])).rows[0];
    const halfBuilt = cur.status === "provisioning" && prov?.status === "failed";
    if (!["trial_active", "expired"].includes(cur.status) && !halfBuilt) {
      return { ok: false, error: `Cannot delete a sign-up that is ${cur.status}.` };
    }
    if (String(confirmSlug || "").trim().toLowerCase() !== cur.slug) {
      return { ok: false, error: `Type the subdomain (${cur.slug}) to confirm deletion.` };
    }
    await q(
      `UPDATE club_signups SET status = 'removing', removal_requested_at = now(), teardown_after = now(),
              updated_at = now() WHERE id = $1`,
      [id]
    );
    const jobId = await queueJob(q, id, "teardown", ["cancelled", "failed"]);
    await q(`INSERT INTO provisioning_events (job_id, signup_id, step, message) VALUES ($1, $2, 'delete-now', $3)`,
      [jobId, id, `Delete now requested by admin; teardown job queued`]);
    return { ok: true, message: `#${id} (${cur.slug}) is being removed. The worker deletes its service, domain, DNS and database.` };
  });
}

import "server-only";
import { createHash } from "node:crypto";
import { getPool } from "./db";
import { SCHEMA_SQL } from "./schema";

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
    `SELECT id, created_at, club_name, sport_type, contact_name, email, website,
            admin_username, status, notified_at
       FROM club_signups
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

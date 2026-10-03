import "server-only";
import { Pool } from "pg";

// Works with a Neon (Vercel Marketplace) or Railway Postgres connection string.
// Neon's integration sets DATABASE_URL (and POSTGRES_URL); either is accepted.
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

const globalForPg = globalThis as unknown as { __chmPool?: Pool };

export function getPool(): Pool | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!globalForPg.__chmPool) {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    globalForPg.__chmPool = new Pool({
      connectionString: url,
      max: 3, // serverless: keep it small
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // TLS is verified by default (Neon has public certs). Set PG_SSL_NO_VERIFY=1 only for a
      // provider whose proxy presents a self-signed certificate.
      ssl:
        local || /sslmode=disable/.test(url)
          ? undefined
          : { rejectUnauthorized: process.env.PG_SSL_NO_VERIFY !== "1" },
    });
  }
  return globalForPg.__chmPool;
}

import { createHmac } from "node:crypto";

/**
 * Deterministic per-club secrets derived from WORKER_SECRET, so a retried job sets the
 * exact same values (no rotation, nothing secret stored in the job state).
 */
export function deriveSecret(workerSecret, label, length = 48) {
  if (!workerSecret || workerSecret.length < 32) throw new Error("WORKER_SECRET must be at least 32 characters");
  return createHmac("sha256", workerSecret).update(label).digest("hex").slice(0, length);
}

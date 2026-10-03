import { runProvisionJob } from "./provision.js";

/** Claims and runs at most one job. Returns a short outcome string. */
export async function workOnce({ store, deps, config, log = console.log }) {
  const job = await store.claimJob(config.workerId);
  if (!job) return "idle";
  log(`[worker] job ${job.id} (signup ${job.signup_id}) attempt ${job.attempts}/${job.max_attempts}`);
  try {
    const state = await runProvisionJob({ job, store, deps, config, now: deps.now });
    await store.completeJob(job.id, state);
    log(`[worker] job ${job.id} succeeded`);
    return "succeeded";
  } catch (err) {
    const outcome = await store.failJob(job, err, { retryable: err.retryable !== false });
    log(`[worker] job ${job.id} ${outcome}: ${err.message}`);
    return outcome;
  }
}

/** Sends queued outbox emails only when explicitly enabled (WELCOME_EMAIL_ENABLED=1). */
export async function sendQueuedEmails({ store, resend, config, log = console.log }) {
  if (!config.email.enabled || !resend) return 0;
  let sent = 0;
  for (const e of await store.claimQueuedEmails()) {
    try {
      const providerId = await resend.send({
        from: config.email.from, to: e.to_email, replyTo: config.email.replyTo,
        subject: e.subject, text: e.body_text, html: e.body_html, idempotencyKey: `outbound-email-${e.id}`,
      });
      await store.markEmail(e.id, { status: "sent", providerId });
      sent++;
    } catch (err) {
      await store.markEmail(e.id, { status: "queued", error: err.message });
      log(`[worker] email ${e.id} failed: ${err.message}`);
    }
  }
  return sent;
}

export async function runForever({ store, deps, resend, config, log = console.log, signal }) {
  log(`[worker] ${config.workerId} polling every ${config.pollIntervalMs} ms (emails ${config.email.enabled ? "ON" : "off"})`);
  while (!signal?.aborted) {
    let outcome = "idle";
    try {
      outcome = await workOnce({ store, deps, config, log });
      await sendQueuedEmails({ store, resend, config, log });
    } catch (err) {
      log(`[worker] loop error: ${err.message}`);
    }
    if (outcome === "idle") await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

import { runProvisionJob } from "./provision.js";
import { runTeardownJob, runSyncTrialJob, runLifecycleSweep } from "./lifecycle.js";

const RUNNERS = { provision: runProvisionJob, teardown: runTeardownJob, sync_trial: runSyncTrialJob };

/** Claims and runs at most one job (any kind). Returns a short outcome string. */
export async function workOnce({ store, deps, config, log = console.log }) {
  const job = await store.claimJob(config.workerId);
  if (!job) return "idle";
  const kind = job.kind || "provision";
  log(`[worker] ${kind} job ${job.id} (signup ${job.signup_id}) attempt ${job.attempts}/${job.max_attempts}`);
  try {
    if (kind === "teardown" && !config.lifecycle?.teardownEnabled) {
      throw Object.assign(new Error("Teardown is switched off (TEARDOWN_ENABLED=0); job left for later"), { retryable: true });
    }
    const runner = RUNNERS[kind];
    if (!runner) throw Object.assign(new Error(`Unknown job kind ${kind}`), { retryable: false });
    const state = await runner({ job, store, deps, config, now: deps.now });
    await store.completeJob(job.id, state);
    log(`[worker] ${kind} job ${job.id} succeeded`);
    return "succeeded";
  } catch (err) {
    if (err.cancel) {
      await store.cancelJob(job.id, err.message);
      log(`[worker] ${kind} job ${job.id} cancelled: ${err.message}`);
      return "cancelled";
    }
    const outcome = await store.failJob(job, err, { retryable: err.retryable !== false });
    log(`[worker] ${kind} job ${job.id} ${outcome}: ${err.message}`);
    return outcome;
  }
}

/** Sends queued outbox emails only when explicitly enabled (EMAILS_ENABLED=1 / WELCOME_EMAIL_ENABLED=1). */
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

/** The deployed loop: jobs + outbox every poll, lifecycle sweep every SWEEP_INTERVAL_MS. */
export async function runForever({ store, deps, resend, config, log = console.log, signal }) {
  const lc = config.lifecycle;
  log(`[worker] ${config.workerId} polling every ${config.pollIntervalMs} ms (emails ${config.email.enabled ? "ON" : "off"}; ` +
    `lifecycle ${lc?.enabled ? `ON every ${lc.sweepIntervalMs} ms, trial ${config.trialDays}d, grace ${lc.graceDays}d, reminders ${lc.reminderDays.join("/")}d, teardown ${lc.teardownEnabled ? "ON" : "off"}` : "off"})`);
  let lastSweep = 0;
  while (!signal?.aborted) {
    let outcome = "idle";
    try {
      if (lc?.enabled && deps.now() - lastSweep >= lc.sweepIntervalMs) {
        lastSweep = deps.now();
        await runLifecycleSweep({ store, config, now: deps.now(), log });
      }
      outcome = await workOnce({ store, deps, config, log });
      await sendQueuedEmails({ store, resend, config, log });
    } catch (err) {
      log(`[worker] loop error: ${err.message}`);
    }
    if (outcome === "idle") await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

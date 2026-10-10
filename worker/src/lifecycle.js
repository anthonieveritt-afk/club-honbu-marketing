// Trial lifecycle, run by the worker next to provisioning (no payment yet):
//
//   trial_active ──(TRIAL_REMINDER_DAYS before end)──▶ reminder emails (2 days, 1 day)
//   trial_active ──(TRIAL_ENDS_AT passed)───────────▶ expired   (club app is read-only + "trial ended" screen
//                                                               by itself, from its own TRIAL_ENDS_AT)
//   expired ──────(TRIAL_ENDS_AT + TRIAL_GRACE_DAYS)─▶ teardown job ─▶ removing ─▶ removed
//   converted ────────────────────────────────────── never torn down (checked at every destructive step)
//
// Admin actions on /admin/signups (lib/signups.ts) change club_signups and queue jobs:
//   Extend trial / Mark converted ─▶ 'sync_trial' job: pushes TRIAL_ENDS_AT (or removes it) to the
//                                    club's Railway service and restarts it.
//   Delete now                     ─▶ status 'removing' + 'teardown' job.
//
// Everything is idempotent (deterministic names, look-before-create/delete, per-step progress in
// provisioning_jobs.state) and every action is written to provisioning_events.
import { namesFor, PermanentError, HQ_DNS_COMMENT, clubUpgradeUrl } from "./provision.js";
import { sweepPaymentGrace } from "./billing.js";
import { isValidSlug } from "./slug.js";
import { reminderEmail, expiredEmail, removedEmail } from "./email.js";

const DAY = 86400000;

export class CancelJob extends Error {
  constructor(message) { super(message); this.name = "CancelJob"; this.retryable = false; this.cancel = true; }
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Which reminder (if any) is due for a trial right now: the smallest offset whose window has opened. */
export function dueReminder({ trialEndsAt, now, reminderDays }) {
  const msLeft = new Date(trialEndsAt).getTime() - now;
  if (msLeft <= 0) return null;
  const open = reminderDays.filter((d) => msLeft <= d * DAY);
  return open.length ? Math.min(...open) : null;
}

/**
 * Pure planner (no I/O) used by the sweep and by DRY_RUN / observe mode.
 * signups: rows from club_signups. Returns a list of { action, signup, ... }.
 */
export function planLifecycle({ signups, now, config }) {
  const { reminderDays, graceDays } = config.lifecycle;
  const plan = [];
  for (const s of signups) {
    if (s.converted_at || s.status === "converted") continue;
    if (s.status === "trial_active" && s.trial_ends_at) {
      const ends = new Date(s.trial_ends_at).getTime();
      if (ends <= now) {
        plan.push({ action: "expire", signup: s, teardownAfter: new Date(ends + graceDays * DAY).toISOString() });
      } else {
        const d = dueReminder({ trialEndsAt: s.trial_ends_at, now, reminderDays });
        if (d) plan.push({ action: "remind", signup: s, days: d, kind: `trial_reminder_${d}d:${iso(s.trial_ends_at)}` });
      }
    } else if (s.status === "expired" && s.teardown_after && new Date(s.teardown_after).getTime() <= now) {
      plan.push({ action: "teardown", signup: s });
    }
  }
  return plan;
}

/** One sweep. Safe to run from several workers at once (all writes are conditional/unique). */
export async function runLifecycleSweep({ store, config, now = Date.now(), log = console.log }) {
  const lc = config.lifecycle;
  const out = { reminders: 0, expired: 0, teardownsQueued: 0, unconfirmedExpired: 0 };
  const ev = (signupId, step, message, level = "info") => store.logEvent({ jobId: null, signupId, step, level, message });
  const mailCtx = { upgradeUrl: config.trialUpgradeUrl, contactEmail: config.contactEmail, graceDays: lc.graceDays };

  // 1. reminders
  const maxDays = Math.max(0, ...lc.reminderDays);
  if (maxDays > 0) {
    for (const s of await store.listEndingTrials(now, maxDays)) {
      const d = dueReminder({ trialEndsAt: s.trial_ends_at, now, reminderDays: lc.reminderDays });
      if (!d) continue;
      const kind = `trial_reminder_${d}d:${iso(s.trial_ends_at)}`;
      const mail = reminderEmail({ contactName: s.contact_name, clubName: s.club_name, instanceUrl: s.instance_url, trialEndsAt: s.trial_ends_at, daysLeft: d, ...mailCtx, upgradeUrl: clubUpgradeUrl(config, s.id) });
      if (await store.queueEmail({ signupId: s.id, kind, to: s.email, ...mail })) {
        out.reminders++;
        await ev(s.id, "reminder", `Queued ${d}-day trial reminder (trial ends ${iso(s.trial_ends_at)})`);
      }
    }
  }

  // 1b. sign-ups whose email was never confirmed (double opt-in): expire them, drop the password hash
  if (store.expireUnverifiedSignups) {
    for (const s of await store.expireUnverifiedSignups(now)) {
      out.unconfirmedExpired++;
      await ev(s.id, "verify", "Email not confirmed in time; sign-up expired and password hash deleted");
    }
  }

  // 2. expiry (the club app locks itself from its own TRIAL_ENDS_AT; this records it in HQ + emails)
  for (const s of await store.expireDueTrials(now, lc.graceDays)) {
    out.expired++;
    await ev(s.id, "expire", `Trial ended ${iso(s.trial_ends_at)}; club is read-only. Teardown scheduled after ${iso(s.teardown_after)}`);
    const mail = expiredEmail({ contactName: s.contact_name, clubName: s.club_name, trialEndsAt: s.trial_ends_at, teardownAfter: s.teardown_after, ...mailCtx, upgradeUrl: clubUpgradeUrl(config, s.id) });
    await store.queueEmail({ signupId: s.id, kind: `trial_expired:${iso(s.trial_ends_at)}`, to: s.email, ...mail });
  }

  // 2b. paid clubs whose failed-payment grace ran out -> locked, back on the expiry/teardown path
  if (store.db && config.billing) {
    const n = await sweepPaymentGrace({ db: store.db, cfg: config.billing, now, retentionDays: lc.graceDays });
    if (n) out.paymentLapsed = n;
  }

  // 3. grace over -> queue teardown (the job re-checks everything before deleting anything)
  if (lc.teardownEnabled) {
    for (const s of await store.listDueTeardowns(now)) {
      const job = await store.enqueueJob(s.id, "teardown", { requeueFrom: ["cancelled"] });
      if (job) {
        out.teardownsQueued++;
        await ev(s.id, "teardown", `Grace period over (${iso(s.teardown_after)}); teardown job ${job.id} queued`);
      }
    }
  }
  if (out.reminders || out.expired || out.teardownsQueued || out.unconfirmedExpired || out.paymentLapsed) log(`[lifecycle] ${JSON.stringify(out)}`);
  return out;
}

// ── teardown job ─────────────────────────────────────────────────────────────────────────────
export const TEARDOWN_STEPS = ["guard", "dns", "custom_domain", "service", "database", "finalize"];

async function assertRemovable(ctx) {
  const s = await ctx.store.getSignup(ctx.signup.id);
  if (!s) throw new CancelJob("Sign-up no longer exists");
  if (s.converted_at || s.status === "converted") throw new CancelJob("Club is converted: never torn down");
  if (s.status !== "removing" && !(ctx.currentStep === "guard" && s.status === "expired")) {
    throw new CancelJob(`Club is ${s.status}; not removing`);
  }
  return s;
}

const teardownSteps = {
  async guard(ctx) {
    const { store, state, config } = ctx;
    const s = await assertRemovable(ctx);
    if (!s.slug || !isValidSlug(s.slug)) throw new PermanentError(`Refusing teardown: invalid slug ${s.slug}`);
    const marked = await store.markSignupRemoving(s.id, ctx.now());
    if (!marked) throw new CancelJob(`Not eligible for teardown (status ${s.status}, teardown after ${iso(s.teardown_after)})`);
    const prov = (await store.getJobFor(s.id, "provision"))?.state || {};
    Object.assign(state, {
      slug: s.slug, ...namesFor(s.slug), fqdn: `${s.slug}.${config.baseDomain}`,
      serviceId: prov.serviceId || null, customDomainId: prov.customDomainId || null,
      dnsRecords: prov.dnsRecords || [],
    });
    ctx.info(`Removing ${state.fqdn} (service ${state.serviceName}, database ${state.dbName})${config.dryRun ? " [DRY RUN]" : ""}`);
  },

  async dns(ctx) {
    await assertRemovable(ctx);
    const { state, deps, config } = ctx;
    const zone = config.baseDomain;
    const wanted = new Map();
    for (const r of state.dnsRecords || []) wanted.set(`${r.type} ${r.name}`, r);
    for (const r of [{ type: "CNAME", name: state.fqdn }, { type: "TXT", name: `_railway-verify.${state.fqdn}` }]) wanted.set(`${r.type} ${r.name}`, r);
    for (const r of wanted.values()) {
      if (!(r.name === zone || r.name.endsWith(`.${zone}`))) continue; // never touch other zones
      const existing = await deps.cloudflare.listRecords({ type: r.type, name: r.name });
      if (!existing.length) { ctx.info(`DNS ${r.type} ${r.name} already gone`); continue; }
      for (const rec of existing) {
        if (!(rec.comment || "").startsWith(HQ_DNS_COMMENT)) {
          ctx.warn(`DNS ${r.type} ${r.name} is not managed by HQ; left untouched`);
          continue;
        }
        try {
          await deps.cloudflare.deleteRecord(rec.id);
          ctx.info(`Deleted DNS ${r.type} ${r.name}`);
        } catch (err) {
          if (/81044|does not exist|not found/i.test(err.message)) ctx.info(`DNS ${r.type} ${r.name} already gone`);
          else throw err;
        }
      }
    }
  },

  async custom_domain(ctx) {
    await assertRemovable(ctx);
    const { state, deps, config } = ctx;
    const { projectId, environmentId } = config.railway;
    const svc = await findService(ctx);
    if (!svc) { ctx.info("Service already gone, so its domains are too"); return; }
    const doms = await deps.railway.listDomains({ projectId, environmentId, serviceId: svc.id });
    const custom = (doms.customDomains || []).filter((d) => d.domain === state.fqdn);
    if (!custom.length) { ctx.info(`Custom domain ${state.fqdn} already gone`); return; }
    for (const d of custom) {
      await deps.railway.deleteCustomDomain(d.id);
      ctx.info(`Deleted Railway custom domain ${d.domain}`);
    }
  },

  async service(ctx) {
    await assertRemovable(ctx);
    const { deps, config, state } = ctx;
    const svc = await findService(ctx);
    if (!svc) { ctx.info(`Service ${state.serviceName} already gone`); return; }
    await deps.railway.deleteService({ id: svc.id, environmentId: config.railway.environmentId });
    ctx.info(`Deleted Railway service ${svc.name} (${svc.id})`);
  },

  async database(ctx) {
    await assertRemovable(ctx);
    const { deps, state } = ctx;
    const r = await deps.tenantDb.dropDatabase({ dbName: state.dbName, roleName: state.roleName });
    ctx.info(r.droppedDb || r.droppedRole
      ? `Dropped ${r.droppedDb ? `database ${state.dbName}` : ""}${r.droppedDb && r.droppedRole ? " and " : ""}${r.droppedRole ? `role ${state.roleName}` : ""}`
      : `Database ${state.dbName} and role ${state.roleName} already gone`);
  },

  async finalize(ctx) {
    const s = await assertRemovable(ctx);
    const { store, config } = ctx;
    await store.markSignupRemoved(s.id, ctx.now());
    const mail = removedEmail({ contactName: s.contact_name, clubName: s.club_name, contactEmail: config.contactEmail });
    await store.queueEmail({ signupId: s.id, kind: "trial_removed", to: s.email, ...mail });
    ctx.info(`All resources for ${ctx.state.fqdn} deleted; sign-up marked removed`);
  },
};

/** The club's Railway service, found by id (from provisioning) or by its deterministic name. */
async function findService(ctx) {
  const { deps, config, state } = ctx;
  const services = await deps.railway.listServices(config.railway.projectId);
  const byId = state.serviceId ? services.find((s) => s.id === state.serviceId) : null;
  if (byId && byId.name !== state.serviceName) {
    throw new PermanentError(`Service ${byId.id} is named ${byId.name}, expected ${state.serviceName}; refusing to touch it`);
  }
  return byId || services.find((s) => s.name === state.serviceName) || null;
}

// ── sync_trial job (Extend trial / Mark converted -> the club's Railway variables) ──────────
export const SYNC_STEPS = ["sync"];
const LIFECYCLE_VARS = ["TRIAL_ENDS_AT", "TRIAL_GRACE_DAYS", "CLUB_SUSPENDED"];

const syncSteps = {
  async sync(ctx) {
    const { store, deps, config, state } = ctx;
    const { projectId, environmentId } = config.railway;
    for (let round = 0; round < 3; round++) {
      const s = await store.getSignup(ctx.signup.id);
      if (!s) throw new CancelJob("Sign-up no longer exists");
      if (["removing", "removed"].includes(s.status)) throw new CancelJob(`Club is ${s.status}; nothing to sync`);
      const prov = (await store.getJobFor(s.id, "provision"))?.state || {};
      const names = s.slug ? namesFor(s.slug) : null;
      const services = await deps.railway.listServices(projectId);
      const svc = services.find((x) => x.id === prov.serviceId) || (names && services.find((x) => x.name === names.serviceName));
      if (!svc) throw new CancelJob("Club has no Railway service yet; nothing to sync");
      const current = await deps.railway.getVariables({ projectId, environmentId, serviceId: svc.id });
      let desired;
      if (s.converted_at || s.status === "converted") {
        desired = { remove: LIFECYCLE_VARS.filter((k) => k in current), set: {} };
      } else if (["trial_active", "expired"].includes(s.status) && s.trial_ends_at) {
        const upgrade = clubUpgradeUrl(config, s.id);
        const want = { TRIAL_ENDS_AT: iso(s.trial_ends_at), TRIAL_GRACE_DAYS: String(config.lifecycle.graceDays), ...(upgrade ? { TRIAL_UPGRADE_URL: upgrade } : {}) };
        const set = Object.fromEntries(Object.entries(want).filter(([k, v]) => current[k] !== v));
        desired = { remove: "CLUB_SUSPENDED" in current ? ["CLUB_SUSPENDED"] : [], set };
      } else {
        throw new CancelJob(`Club is ${s.status}; nothing to sync`);
      }
      const changed = desired.remove.length || Object.keys(desired.set).length;
      if (!changed) {
        ctx.info(round ? "Variables now match HQ" : `Variables already match HQ (${s.converted_at ? "converted: no trial vars" : `trial ends ${iso(s.trial_ends_at)}`})`);
        return;
      }
      if (Object.keys(desired.set).length) {
        await deps.railway.upsertVariables({ projectId, environmentId, serviceId: svc.id, variables: desired.set });
      }
      for (const name of desired.remove) {
        try { await deps.railway.deleteVariable({ projectId, environmentId, serviceId: svc.id, name }); }
        catch (err) { if (!/not found/i.test(err.message)) throw err; }
      }
      await deps.railway.redeploy({ serviceId: svc.id, environmentId });
      state.syncedAt = new Date(ctx.now()).toISOString();
      ctx.info(`Set ${JSON.stringify(desired.set)}${desired.remove.length ? `, removed ${desired.remove.join(", ")}` : ""}; restarted ${svc.name}`);
      // loop: re-read in case an admin changed the trial again while we were working
    }
  },
};

// ── shared step runner ───────────────────────────────────────────────────────────────────────
async function runSteps({ kind, stepNames, impl, job, store, deps, config, now }) {
  const signup = await store.getSignup(job.signup_id);
  if (!signup) throw new CancelJob(`Sign-up ${job.signup_id} not found`);
  const state = structuredClone(job.state || {});
  state.done ||= {};
  let currentStep = null;
  const ctx = {
    signup, state, config, deps, store, now,
    get currentStep() { return currentStep; },
    info: (message) => store.logEvent({ jobId: job.id, signupId: signup.id, step: `${kind}:${currentStep}`, message }),
    warn: (message) => store.logEvent({ jobId: job.id, signupId: signup.id, step: `${kind}:${currentStep}`, level: "warn", message }),
  };
  for (const step of stepNames) {
    if (state.done[step]) continue;
    currentStep = step;
    try {
      await impl[step](ctx);
    } catch (err) {
      await store.saveJobProgress(job.id, step, state);
      await store.logEvent({ jobId: job.id, signupId: signup.id, step: `${kind}:${step}`, level: err.cancel ? "warn" : "error", message: err.message });
      throw err;
    }
    state.done[step] = true;
    await store.saveJobProgress(job.id, step, state);
  }
  return state;
}

export function runTeardownJob({ job, store, deps, config, now = () => Date.now() }) {
  return runSteps({ kind: "teardown", stepNames: TEARDOWN_STEPS, impl: teardownSteps, job, store, deps, config, now });
}

export function runSyncTrialJob({ job, store, deps, config, now = () => Date.now() }) {
  // A re-queued sync job always starts fresh (enqueueJob resets state), so it re-reads HQ.
  return runSteps({ kind: "sync_trial", stepNames: SYNC_STEPS, impl: syncSteps, job, store, deps, config, now });
}

// ── DRY RUN helpers ──────────────────────────────────────────────────────────────────────────
const DESTRUCTIVE = {
  railway: ["createService", "updateServiceInstance", "upsertVariables", "createServiceDomain", "createCustomDomain", "connectSource", "deploy", "deleteVariable", "redeploy", "deleteCustomDomain", "deleteService"],
  cloudflare: ["createRecord", "updateRecord", "deleteRecord"],
  tenantDb: ["ensureDatabase", "dropDatabase"],
};
/**
 * Wraps real clients so read calls (list/get) go to the real APIs and every write/delete is
 * only printed. Used by `cli.js teardown-plan` so Anthoni can see exactly what would be deleted.
 */
export function dryRunDeps(deps, log) {
  const out = { ...deps };
  for (const [name, methods] of Object.entries(DESTRUCTIVE)) {
    if (!deps[name]) continue;
    const real = deps[name];
    out[name] = new Proxy(real, {
      get(target, prop) {
        if (methods.includes(prop)) {
          return async (...args) => {
            log(`WOULD ${name}.${String(prop)} ${JSON.stringify(args)}`);
            if (prop === "dropDatabase") return { droppedDb: true, droppedRole: true };
            return undefined;
          };
        }
        return target[prop];
      },
    });
  }
  return out;
}

/**
 * Store wrapper for dry runs: reads pass through, writes are printed and skipped.
 * `simulateRemoving`: preview a teardown as if it had been triggered (status 'removing'),
 * which is what "Delete now" or the end of the grace period would do. Converted clubs are
 * still refused, exactly like the real job.
 */
export function readOnlyStore(store, log, { simulateRemoving = false } = {}) {
  const writes = new Set(["saveJobProgress", "completeJob", "failJob", "markSignupProvisioning", "finalizeSignup", "queueEmail", "enqueueJob", "cancelJob", "expireDueTrials", "markSignupRemoved", "claimJob", "markEmail"]);
  const overlay = new Map();
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "logEvent") return async (e) => log(`[${e.step}] ${e.level && e.level !== "info" ? `${e.level.toUpperCase()}: ` : ""}${e.message}`);
      if (prop === "getSignup") {
        return async (id) => {
          const s = await target.getSignup(id);
          if (!s) return s;
          if (simulateRemoving && !s.converted_at && s.status !== "converted" && !overlay.has(String(id))) overlay.set(String(id), { status: "removing" });
          return { ...s, ...(overlay.get(String(id)) || {}) };
        };
      }
      if (prop === "markSignupRemoving") {
        // what the real call would return, without writing
        return async (id, now) => {
          const s = { ...(await target.getSignup(id)), ...(overlay.get(String(id)) || {}) };
          const ok = s && !s.converted_at && (s.status === "removing" || (s.status === "expired" && s.teardown_after && new Date(s.teardown_after) <= new Date(now)));
          if (ok) overlay.set(String(id), { status: "removing" });
          return ok ? { ...s, status: "removing" } : null;
        };
      }
      if (writes.has(prop)) return async () => undefined;
      return target[prop];
    },
  });
}

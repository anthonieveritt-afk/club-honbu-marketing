import { subscribeUrl } from "./billing.js";
// Approved sign-up -> running club instance. Idempotent and resumable:
// every step records what it created in job.state and checks for existing resources
// (by deterministic names) before creating anything, so re-running a job — after a crash,
// a partial failure or a manual retry — never creates a second service, database or record.
import { deriveSecret } from "./secrets.js";
import { isValidSlug, clubTypeFor } from "./slug.js";
import { tenantDatabaseUrl } from "./tenant-db.js";
import { pollUntil } from "./http.js";
import { welcomeEmail } from "./email.js";

/** The locked page / banner "Upgrade" link: this club's signed /subscribe page, else TRIAL_UPGRADE_URL. */
export function clubUpgradeUrl(config, signupId) {
  return (config.billing && subscribeUrl(config.billing, signupId)) || config.trialUpgradeUrl || "";
}

export class PermanentError extends Error {
  constructor(message) { super(message); this.name = "PermanentError"; this.retryable = false; }
}

export const STEPS = ["prepare", "database", "service", "configure", "domains", "dns", "deploy", "health", "finalize"];
const DEPLOY_OK = new Set(["SUCCESS", "SLEEPING"]);
const DEPLOY_BAD = new Set(["FAILED", "CRASHED", "REMOVED", "REMOVING", "SKIPPED"]);
export const HQ_DNS_COMMENT = "managed by club-honbu-hq";

export function namesFor(slug) {
  const ident = `club_${slug.replace(/-/g, "_")}`;
  return { serviceName: `club-${slug}`, dbName: ident, roleName: `${ident}_app` };
}

export function clubVariables({ signup, state, config }) {
  const fqdn = `${state.slug}.${config.baseDomain}`;
  const dbPassword = deriveSecret(config.workerSecret, `db:${state.dbName}`, 32);
  return {
    NODE_ENV: "production",
    PORT: String(config.railway.appPort),
    CLUB_PROFILE: "neutral",
    DB_BOOTSTRAP: "1",
    DATABASE_URL: tenantDatabaseUrl({ appHost: config.tenantDb.appHost, dbName: state.dbName, roleName: state.roleName, password: dbPassword }),
    CLUB_NAME: signup.club_name,
    CLUB_TYPE: clubTypeFor(signup.sport_type),
    CLUB_CONTACT_EMAIL: signup.email,
    ...(signup.website ? { CLUB_WEBSITE: signup.website } : {}),
    ADMIN_USERNAME: signup.admin_username,
    ADMIN_PASSWORD_HASH: signup.password_hash,
    ADMIN_JWT_SECRET: deriveSecret(config.workerSecret, `admin-jwt:${state.slug}`, 64),
    PORTAL_JWT_SECRET: deriveSecret(config.workerSecret, `portal-jwt:${state.slug}`, 64),
    TRIAL_ENDS_AT: state.trialEndsAt,
    // Display only in the club app ("data kept until ..."); HQ's sweep does the actual deletion.
    ...(config.lifecycle ? { TRIAL_GRACE_DAYS: String(config.lifecycle.graceDays) } : {}),
    ...(config.contactEmail ? { TRIAL_CONTACT_EMAIL: config.contactEmail } : {}),
    SITE_URL: `https://${fqdn}`,
    ...(clubUpgradeUrl(config, signup.id) ? { TRIAL_UPGRADE_URL: clubUpgradeUrl(config, signup.id) } : {}),
  };
}

function desiredDnsRecords({ status, state, config }) {
  const zone = config.baseDomain;
  const out = [];
  const add = (type, name, content) => {
    name = name.replace(/\.$/, "");
    if (!(name === zone || name.endsWith(`.${zone}`))) return; // never touch other zones
    if (!out.find((r) => r.type === type && r.name === name)) out.push({ type, name, content });
  };
  for (const r of status?.dnsRecords || []) {
    const type = String(r.recordType).replace("DNS_RECORD_TYPE_", "");
    if (!["CNAME", "TXT", "A"].includes(type)) continue;
    const name = r.fqdn || (r.hostlabel ? `${r.hostlabel}.${r.zone || zone}` : r.zone);
    add(type, name, r.requiredValue);
  }
  if (status?.verificationToken) {
    // Railway gives verificationDnsHost relative to the registrable zone (e.g. "_railway-verify.slug.staging"
    // in "clubhonbu.co.uk"), which differs from BASE_DOMAIN when that is a subdomain (staging).
    const apex = (status.dnsRecords || []).find((r) => r.zone)?.zone?.replace(/\.$/, "") || zone;
    let host = (status.verificationDnsHost || `_railway-verify.${state.fqdn}`).replace(/\.$/, "");
    if (!(host === zone || host.endsWith(`.${zone}`) || host === apex || host.endsWith(`.${apex}`))) host = `${host}.${apex}`;
    const v = status.verificationToken.startsWith("railway-verify=") ? status.verificationToken : `railway-verify=${status.verificationToken}`;
    add("TXT", host, v);
  }
  return out;
}

const steps = {
  async prepare(ctx) {
    const { signup, state, config, store } = ctx;
    if (signup.status === "rejected") throw new PermanentError("Sign-up was rejected");
    if (!isValidSlug(signup.slug)) throw new PermanentError(`Invalid or reserved slug: ${signup.slug}`);
    if (state.slug && state.slug !== signup.slug) throw new PermanentError(`Slug changed mid-provisioning (${state.slug} -> ${signup.slug})`);
    if (!signup.password_hash && !state.done?.configure) throw new PermanentError("No password hash on the sign-up");
    Object.assign(state, { slug: signup.slug, ...namesFor(signup.slug) });
    state.fqdn = `${signup.slug}.${config.baseDomain}`;
    // Fixed once, so retries never extend the trial.
    state.trialEndsAt ||= new Date(ctx.now() + config.trialDays * 86400000).toISOString();
    await store.markSignupProvisioning(signup.id);
  },

  async database(ctx) {
    const { state, config, deps } = ctx;
    const password = deriveSecret(config.workerSecret, `db:${state.dbName}`, 32);
    const created = await deps.tenantDb.ensureDatabase({ dbName: state.dbName, roleName: state.roleName, password });
    ctx.info(created ? `Created database ${state.dbName}` : `Database ${state.dbName} already existed`);
  },

  async service(ctx) {
    const { state, config, deps } = ctx;
    const { projectId, environmentId } = config.railway;
    const services = await deps.railway.listServices(projectId);
    const existing = services.find((s) => (state.serviceId ? s.id === state.serviceId : s.name === state.serviceName))
      || services.find((s) => s.name === state.serviceName);
    if (existing) {
      state.serviceId = existing.id;
      ctx.info(`Using existing service ${existing.name} (${existing.id})`);
      return;
    }
    const svc = await deps.railway.createService({ projectId, environmentId, name: state.serviceName });
    state.serviceId = svc.id;
    ctx.info(`Created service ${svc.name} (${svc.id})`);
  },

  async configure(ctx) {
    const { state, config, deps, signup } = ctx;
    const { projectId, environmentId, region, sleepApplication } = config.railway;
    await deps.railway.updateServiceInstance({
      serviceId: state.serviceId, environmentId,
      input: { region, sleepApplication, healthcheckPath: "/health", healthcheckTimeout: 300, numReplicas: 1 },
    });
    if (!signup.password_hash) {
      ctx.info("Variables already set earlier (password hash already handed over); not re-sending");
      return;
    }
    await deps.railway.upsertVariables({ projectId, environmentId, serviceId: state.serviceId, variables: clubVariables(ctx) });
    ctx.info(`Configured region ${region}, serverless=${sleepApplication}, variables set (trial ends ${state.trialEndsAt})`);
  },

  async domains(ctx) {
    const { state, config, deps } = ctx;
    const { projectId, environmentId, appPort } = config.railway;
    const doms = await deps.railway.listDomains({ projectId, environmentId, serviceId: state.serviceId });
    let svcDomain = doms.serviceDomains?.[0];
    if (!svcDomain) svcDomain = await deps.railway.createServiceDomain({ environmentId, serviceId: state.serviceId, targetPort: appPort });
    state.serviceDomain = svcDomain.domain;
    let custom = doms.customDomains?.find((d) => d.domain === state.fqdn);
    if (!custom) custom = await deps.railway.createCustomDomain({ projectId, environmentId, serviceId: state.serviceId, domain: state.fqdn, targetPort: appPort });
    state.customDomainId = custom.id;
    const status = (await deps.railway.getCustomDomainStatus({ projectId, id: custom.id }))?.status;
    state.dnsRecords = desiredDnsRecords({ status, state, config });
    if (!state.dnsRecords.length) throw new Error("Railway returned no DNS records for the custom domain yet");
    ctx.info(`Domains: ${state.serviceDomain} + ${state.fqdn} (${state.dnsRecords.length} DNS records needed)`);
  },

  async dns(ctx) {
    const { state, deps, signup } = ctx;
    for (const rec of state.dnsRecords) {
      const existing = await deps.cloudflare.listRecords({ type: rec.type, name: rec.name });
      const same = existing.find((r) => r.content === rec.content || r.content === `"${rec.content}"`);
      if (same) { ctx.info(`DNS ${rec.type} ${rec.name} already correct`); continue; }
      const body = { type: rec.type, name: rec.name, content: rec.content, ttl: 1, proxied: false, comment: `${HQ_DNS_COMMENT} (signup ${signup.id})` };
      if (existing.length) {
        const ours = existing.find((r) => (r.comment || "").startsWith(HQ_DNS_COMMENT));
        if (!ours) throw new PermanentError(`DNS ${rec.type} ${rec.name} already exists and is not managed by HQ; refusing to overwrite`);
        await deps.cloudflare.updateRecord(ours.id, body);
        ctx.info(`Updated DNS ${rec.type} ${rec.name}`);
      } else {
        await deps.cloudflare.createRecord(body);
        ctx.info(`Created DNS ${rec.type} ${rec.name}`);
      }
    }
  },

  async deploy(ctx) {
    const { state, config, deps } = ctx;
    const { projectId, environmentId, sourceRepo, sourceBranch, sourceImage } = config.railway;
    if (state.deploymentId) {
      const d = await deps.railway.getDeployment(state.deploymentId).catch(() => null);
      if (d && !DEPLOY_BAD.has(d.status)) { ctx.info(`Deployment ${d.id} already ${d.status}`); return; }
    }
    if (!state.sourceConnected) {
      await deps.railway.connectSource({ serviceId: state.serviceId, image: sourceImage || undefined, repo: sourceRepo, branch: sourceBranch });
      state.sourceConnected = true;
      await ctx.save("deploy");
      ctx.info(`Connected source ${sourceImage || `${sourceRepo}@${sourceBranch}`}`);
      // Connecting a source normally starts a deployment by itself; give it a moment to appear.
      const d = await pollUntil(() => deps.railway.latestDeployment({ projectId, environmentId, serviceId: state.serviceId }),
        { timeoutMs: 60000, intervalMs: 5000, sleep: deps.sleep, now: ctx.now });
      if (d && !DEPLOY_BAD.has(d.status)) { state.deploymentId = d.id; return; }
    }
    state.deploymentId = await deps.railway.deploy({ serviceId: state.serviceId, environmentId });
    ctx.info(`Triggered deployment ${state.deploymentId}`);
  },

  async health(ctx) {
    const { state, config, deps } = ctx;
    const h = config.health;
    let last = null;
    const ok = await pollUntil(async () => {
      last = await deps.railway.getDeployment(state.deploymentId);
      if (DEPLOY_BAD.has(last?.status)) return "bad";
      return DEPLOY_OK.has(last?.status) ? "ok" : null;
    }, { timeoutMs: h.deployTimeoutMs, intervalMs: h.intervalMs, sleep: deps.sleep, now: ctx.now });
    if (ok !== "ok") {
      state.done.deploy = false; // the retry triggers a fresh deployment
      throw new Error(`Deployment ${state.deploymentId} ${ok === "bad" ? `ended ${last?.status}` : "did not finish in time"}`);
    }
    const railwayHealthy = await pollUntil(async () => (await deps.httpStatus(`https://${state.serviceDomain}/health`)) === 200,
      { timeoutMs: h.healthTimeoutMs, intervalMs: h.intervalMs, sleep: deps.sleep, now: ctx.now });
    if (!railwayHealthy) throw new Error(`https://${state.serviceDomain}/health did not return 200`);
    // The custom domain needs DNS + a TLS certificate; don't fail the job if it's still issuing.
    state.customDomainHealthy = !!(await pollUntil(async () => (await deps.httpStatus(`https://${state.fqdn}/health`)) === 200,
      { timeoutMs: h.customDomainTimeoutMs, intervalMs: h.intervalMs, sleep: deps.sleep, now: ctx.now }));
    ctx.info(`Healthy on https://${state.serviceDomain}; custom domain ${state.customDomainHealthy ? "healthy" : "still issuing TLS"}`);
  },

  async finalize(ctx) {
    const { state, store, signup } = ctx;
    const instanceUrl = `https://${state.fqdn}`;
    await store.finalizeSignup({ signupId: signup.id, instanceUrl, railwayUrl: `https://${state.serviceDomain}`, trialEndsAt: state.trialEndsAt });
    const mail = welcomeEmail({ contactName: signup.contact_name, clubName: signup.club_name, instanceUrl, adminUsername: signup.admin_username, trialEndsAt: state.trialEndsAt });
    await store.queueEmail({ signupId: signup.id, kind: "welcome", to: signup.email, ...mail });
    ctx.info(`Trial active at ${instanceUrl} until ${state.trialEndsAt}; welcome email queued`);
  },
};

/** Runs (or resumes) one provisioning job. Throws on failure; state so far is saved. */
export async function runProvisionJob({ job, store, deps, config, now = () => Date.now() }) {
  const signup = await store.getSignup(job.signup_id);
  if (!signup) throw new PermanentError(`Sign-up ${job.signup_id} not found`);
  const state = structuredClone(job.state || {});
  state.done ||= {};
  if (signup.status === "trial_active" && state.done.finalize) return state; // already finished

  let currentStep = null;
  const ctx = {
    signup, state, config, deps, store, now,
    info: (message) => store.logEvent({ jobId: job.id, signupId: signup.id, step: currentStep, message }),
    save: (step) => store.saveJobProgress(job.id, step, state),
  };
  for (const step of STEPS) {
    if (state.done[step]) continue;
    currentStep = step;
    try {
      await steps[step](ctx);
    } catch (err) {
      await store.saveJobProgress(job.id, step, state);
      await store.logEvent({ jobId: job.id, signupId: signup.id, step, level: "error", message: err.message });
      throw err;
    }
    state.done[step] = true;
    await store.saveJobProgress(job.id, step, state);
  }
  return state;
}

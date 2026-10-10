import { billingConfig } from "./billing.js";

// All configuration comes from env. Nothing here talks to any service.
export function loadConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  return {
    hqDatabaseUrl: env.HQ_DATABASE_URL || env.DATABASE_URL,
    workerId: env.WORKER_ID || `worker-${process.pid}`,
    workerSecret: env.WORKER_SECRET,
    dryRun: env.DRY_RUN === "1",
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 15000),
    trialDays: num(env.TRIAL_DAYS, 7),
    lifecycle: {
      // Trial lifecycle sweep (reminders -> expiry -> grace -> teardown). LIFECYCLE_ENABLED=0 turns it off.
      enabled: env.LIFECYCLE_ENABLED !== "0",
      sweepIntervalMs: num(env.SWEEP_INTERVAL_MS, 5 * 60 * 1000),
      graceDays: num(env.TRIAL_GRACE_DAYS, 7),
      reminderDays: String(env.TRIAL_REMINDER_DAYS ?? "2,1").split(",").map((x) => Number(x.trim())).filter((x) => x > 0).sort((a, b) => b - a),
      // Teardown deletes real resources; it only runs when this is on (default on, DRY_RUN overrides).
      teardownEnabled: env.TEARDOWN_ENABLED !== "0",
    },
    baseDomain: env.BASE_DOMAIN || "clubhonbu.co.uk",
    railway: {
      apiUrl: env.RAILWAY_API_URL || "https://backboard.railway.com/graphql/v2",
      token: env.RAILWAY_API_TOKEN,
      projectId: env.TENANT_PROJECT_ID,
      environmentId: env.TENANT_ENVIRONMENT_ID,
      region: env.TENANT_REGION || "europe-west4-drams3a", // EU West (Amsterdam)
      sleepApplication: env.TENANT_SERVERLESS !== "0",
      sourceRepo: env.CLUB_SOURCE_REPO || "anthonieveritt-afk/club-honbu",
      // No default on purpose: club-honbu main does not have the trial-instance code yet
      // (DB_BOOTSTRAP, ADMIN_PASSWORD_HASH, TRIAL_ENDS_AT). Live mode refuses to start without it.
      sourceBranch: env.CLUB_SOURCE_BRANCH || "",
      sourceImage: env.CLUB_SOURCE_IMAGE || "", // takes precedence over repo when set
      appPort: num(env.CLUB_APP_PORT, 8080),
    },
    tenantDb: {
      adminUrl: env.TENANT_PG_ADMIN_URL,          // superuser URL reachable from the worker
      appHost: env.TENANT_PG_APP_HOST || "postgres.railway.internal:5432", // as seen by club apps
    },
    cloudflare: {
      apiUrl: env.CLOUDFLARE_API_URL || "https://api.cloudflare.com/client/v4",
      token: env.CLOUDFLARE_API_TOKEN,
      zoneId: env.CLOUDFLARE_ZONE_ID,
    },
    health: {
      deployTimeoutMs: num(env.DEPLOY_TIMEOUT_MS, 20 * 60 * 1000),
      healthTimeoutMs: num(env.HEALTH_TIMEOUT_MS, 5 * 60 * 1000),
      customDomainTimeoutMs: num(env.CUSTOM_DOMAIN_TIMEOUT_MS, 60 * 1000),
      intervalMs: num(env.HEALTH_INTERVAL_MS, 10000),
    },
    email: {
      // EMAILS_ENABLED=1 sends every queued email (welcome, reminders, trial ended, removed).
      // WELCOME_EMAIL_ENABLED=1 is the older name and still works.
      enabled: env.EMAILS_ENABLED === "1" || env.WELCOME_EMAIL_ENABLED === "1",
      // Staging without an email provider: EMAIL_LOG_ONLY=1 prints each queued email to the log and
      // marks it 'logged' (never sent later). Ignored when sending is enabled.
      logOnly: env.EMAIL_LOG_ONLY === "1",
      resendApiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM || "Club Honbu <hello@clubhonbu.co.uk>",
      replyTo: env.EMAIL_REPLY_TO || "hello@clubhonbu.co.uk",
    },
    trialUpgradeUrl: env.TRIAL_UPGRADE_URL || "",
    // Stripe Billing: per-club signed /subscribe links need BILLING_TOKEN_SECRET (same value as the site).
    billing: billingConfig(env),
    contactEmail: env.TRIAL_CONTACT_EMAIL || "hello@clubhonbu.co.uk",
  };
}

export function assertLiveConfig(c) {
  const missing = [];
  if (!c.hqDatabaseUrl) missing.push("HQ_DATABASE_URL");
  if (!c.workerSecret || c.workerSecret.length < 32) missing.push("WORKER_SECRET (32+ chars)");
  if (!c.railway.token) missing.push("RAILWAY_API_TOKEN");
  if (!c.railway.projectId) missing.push("TENANT_PROJECT_ID");
  if (!c.railway.environmentId) missing.push("TENANT_ENVIRONMENT_ID");
  if (!c.tenantDb.adminUrl) missing.push("TENANT_PG_ADMIN_URL");
  if (!c.cloudflare.token) missing.push("CLOUDFLARE_API_TOKEN");
  if (!c.cloudflare.zoneId) missing.push("CLOUDFLARE_ZONE_ID");
  if (!c.railway.sourceImage && !c.railway.sourceBranch) missing.push("CLUB_SOURCE_BRANCH (or CLUB_SOURCE_IMAGE)");
  if (!(c.trialDays > 0)) missing.push("TRIAL_DAYS (> 0)");
  if (!(c.lifecycle.graceDays >= 0)) missing.push("TRIAL_GRACE_DAYS (>= 0)");
  if (missing.length) throw new Error(`Missing config: ${missing.join(", ")}`);
}

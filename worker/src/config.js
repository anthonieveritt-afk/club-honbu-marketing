// All configuration comes from env. Nothing here talks to any service.
export function loadConfig(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  return {
    hqDatabaseUrl: env.HQ_DATABASE_URL || env.DATABASE_URL,
    workerId: env.WORKER_ID || `worker-${process.pid}`,
    workerSecret: env.WORKER_SECRET,
    dryRun: env.DRY_RUN === "1",
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 15000),
    trialDays: num(env.TRIAL_DAYS, 14),
    baseDomain: env.BASE_DOMAIN || "clubhonbu.co.uk",
    railway: {
      apiUrl: env.RAILWAY_API_URL || "https://backboard.railway.com/graphql/v2",
      token: env.RAILWAY_API_TOKEN,
      projectId: env.TENANT_PROJECT_ID,
      environmentId: env.TENANT_ENVIRONMENT_ID,
      region: env.TENANT_REGION || "europe-west4-drams3a", // EU West (Amsterdam)
      sleepApplication: env.TENANT_SERVERLESS !== "0",
      sourceRepo: env.CLUB_SOURCE_REPO || "anthonieveritt-afk/club-honbu",
      sourceBranch: env.CLUB_SOURCE_BRANCH || "main",
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
      enabled: env.WELCOME_EMAIL_ENABLED === "1",
      resendApiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM || "Club Honbu <hello@clubhonbu.co.uk>",
      replyTo: env.EMAIL_REPLY_TO || "hello@clubhonbu.co.uk",
    },
    trialUpgradeUrl: env.TRIAL_UPGRADE_URL || "",
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
  if (missing.length) throw new Error(`Missing config: ${missing.join(", ")}`);
}

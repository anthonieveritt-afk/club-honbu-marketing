#!/usr/bin/env node
// Usage:
//   node src/cli.js run                 poll provisioning_jobs forever (live)
//   node src/cli.js once                run at most one job, then exit (live)
//   node src/cli.js dry-run <signupId>  read one sign-up from the HQ DB and print every action the
//                                       job WOULD take, using in-memory fakes. Writes nothing anywhere.
import { loadConfig, assertLiveConfig } from "./config.js";
import { createPgStore, createMemoryStore } from "./store.js";
import { createRailwayClient } from "./railway.js";
import { createCloudflareClient } from "./cloudflare.js";
import { createTenantDb } from "./tenant-db.js";
import { createResendClient } from "./email.js";
import { httpStatus } from "./http.js";
import { runProvisionJob } from "./provision.js";
import { workOnce, runForever } from "./worker.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp } from "./fakes.js";

const [cmd, arg] = process.argv.slice(2);
const config = loadConfig();

if (cmd === "dry-run" || (config.dryRun && cmd !== "help")) {
  const signupId = arg;
  if (!signupId) { console.error("dry-run needs a signup id"); process.exit(2); }
  if (!config.hqDatabaseUrl) { console.error("HQ_DATABASE_URL is required (read-only use)"); process.exit(2); }
  const pg = createPgStore({ connectionString: config.hqDatabaseUrl });
  const signup = await pg.getSignup(signupId);
  await pg.end();
  if (!signup) { console.error(`signup ${signupId} not found`); process.exit(1); }
  const dryConfig = {
    ...config,
    workerSecret: config.workerSecret || "dry-run-secret-dry-run-secret-0000",
    railway: { ...config.railway, projectId: config.railway.projectId || "<TENANT_PROJECT_ID>", environmentId: config.railway.environmentId || "<TENANT_ENVIRONMENT_ID>" },
    health: { ...config.health, intervalMs: 0 },
  };
  const log = (m) => console.log(`  would call: ${m}`);
  const mem = createMemoryStore({ signups: [{ ...signup, status: signup.status === "new" ? "approved" : signup.status }], jobs: [{ id: "dry", signup_id: signup.id }] });
  const deps = {
    railway: createFakeRailway({ log }), cloudflare: createFakeCloudflare({ log }), tenantDb: createFakeTenantDb({ log }),
    httpStatus: createFakeHttp({ log }), sleep: async () => {}, now: () => Date.now(),
  };
  console.log(`DRY RUN for signup ${signup.id} "${signup.club_name}" (slug ${signup.slug || "<none>"}). Nothing is written.`);
  try {
    const job = await mem.claimJob("dry-run");
    const state = await runProvisionJob({ job, store: mem, deps, config: dryConfig });
    for (const e of mem._s.events) console.log(`  [${e.step}] ${e.message}`);
    const vars = deps.railway._s.variables[state.serviceId] || {};
    console.log("\nClub service variables (secrets masked):");
    for (const [k, v] of Object.entries(vars)) console.log(`  ${k}=${/SECRET|HASH|DATABASE_URL/.test(k) ? "***" : v}`);
    console.log(`\nDNS records: ${state.dnsRecords.map((r) => `${r.type} ${r.name}`).join(", ")}`);
    console.log(`Welcome email queued (not sent): ${mem._s.emails.length ? mem._s.emails[0].subject : "no"}`);
  } catch (err) {
    console.error(`Dry run stopped: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === "run" || cmd === "once") {
  assertLiveConfig(config);
  const store = createPgStore({ connectionString: config.hqDatabaseUrl });
  await store.ensureSchema();
  const deps = {
    railway: createRailwayClient(config.railway),
    cloudflare: createCloudflareClient(config.cloudflare),
    tenantDb: createTenantDb({ adminUrl: config.tenantDb.adminUrl }),
    httpStatus, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
  };
  const resend = config.email.enabled && config.email.resendApiKey ? createResendClient({ apiKey: config.email.resendApiKey }) : null;
  if (cmd === "once") {
    console.log(await workOnce({ store, deps, config }));
    await store.end();
  } else {
    const ac = new AbortController();
    process.on("SIGTERM", () => ac.abort());
    await runForever({ store, deps, resend, config, signal: ac.signal });
    await store.end();
  }
} else if (cmd !== "dry-run") {
  console.log("usage: node src/cli.js run | once | dry-run <signupId>");
  process.exit(cmd ? 2 : 0);
}

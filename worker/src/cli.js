#!/usr/bin/env node
// Usage:
//   node src/cli.js run                     poll jobs + lifecycle sweep forever (live; the deployed mode)
//   node src/cli.js once                    run at most one job, then exit (live)
//   node src/cli.js sweep                   run ONE lifecycle sweep (reminders/expiry/queue teardowns), then exit
//   node src/cli.js plan                    print what the lifecycle sweep would do now. Read-only.
//   node src/cli.js dry-run <signupId>      print every call provisioning WOULD make, using in-memory fakes. Writes nothing.
//   node src/cli.js teardown-plan <signupId>  look up the club's REAL Railway service, custom domain, DNS records and
//                                           database (read-only calls) and print exactly what teardown would delete.
//                                           Deletes nothing, writes nothing.
//
// DRY_RUN=1 makes `run`/`once`/`sweep` read-only "observe" mode: they print the lifecycle plan and the
// queued jobs and never claim a job, write to the HQ database or call Railway/Cloudflare/Postgres admin.
import { loadConfig, assertLiveConfig } from "./config.js";
import { createPgStore, createMemoryStore } from "./store.js";
import { createRailwayClient } from "./railway.js";
import { createCloudflareClient } from "./cloudflare.js";
import { createTenantDb } from "./tenant-db.js";
import { createResendClient } from "./email.js";
import { httpStatus } from "./http.js";
import { runProvisionJob } from "./provision.js";
import { workOnce, runForever } from "./worker.js";
import { planLifecycle, runLifecycleSweep, runTeardownJob, dryRunDeps, readOnlyStore } from "./lifecycle.js";
import { createFakeRailway, createFakeCloudflare, createFakeTenantDb, createFakeHttp } from "./fakes.js";

const [cmd, arg] = process.argv.slice(2);
const config = loadConfig();
const need = (cond, msg) => { if (!cond) { console.error(msg); process.exit(2); } };

async function printPlan(store) {
  const now = Date.now();
  const plan = planLifecycle({ signups: await store.listLifecycleCandidates(), now, config });
  console.log(`[plan ${new Date(now).toISOString()}] trial ${config.trialDays}d, grace ${config.lifecycle.graceDays}d, reminders ${config.lifecycle.reminderDays.join("/")}d, teardown ${config.lifecycle.teardownEnabled ? "ON" : "off"}`);
  if (!plan.length) console.log("  nothing due");
  for (const p of plan) {
    const s = p.signup;
    const who = `#${s.id} ${s.club_name} (${s.slug || "no slug"})`;
    if (p.action === "remind") console.log(`  would queue ${p.days}-day reminder to ${s.email} for ${who}, trial ends ${new Date(s.trial_ends_at).toISOString()}`);
    if (p.action === "expire") console.log(`  would mark ${who} expired; teardown after ${p.teardownAfter}`);
    if (p.action === "teardown") console.log(`  would queue teardown for ${who} (grace ended ${new Date(s.teardown_after).toISOString()})`);
  }
  for (const j of await store.listQueuedJobs()) console.log(`  job ${j.id} ${j.kind} ${j.status} for #${j.signup_id} ${j.club_name}`);
}

function liveDeps() {
  return {
    railway: createRailwayClient(config.railway),
    cloudflare: createCloudflareClient(config.cloudflare),
    tenantDb: createTenantDb({ adminUrl: config.tenantDb.adminUrl }),
    httpStatus, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
  };
}

if (cmd === "dry-run") {
  const signupId = arg;
  need(signupId, "dry-run needs a signup id");
  need(config.hqDatabaseUrl, "HQ_DATABASE_URL is required (read-only use)");
  const pg = createPgStore({ connectionString: config.hqDatabaseUrl });
  const signup = await pg.getSignup(signupId);
  await pg.end();
  if (!signup) { console.error(`signup ${signupId} not found`); process.exit(1); }
  const dryConfig = {
    ...config,
    workerSecret: config.workerSecret || "dry-run-secret-dry-run-secret-0000",
    railway: { ...config.railway, projectId: config.railway.projectId || "<TENANT_PROJECT_ID>", environmentId: config.railway.environmentId || "<TENANT_ENVIRONMENT_ID>", sourceBranch: config.railway.sourceBranch || "<CLUB_SOURCE_BRANCH>" },
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
} else if (cmd === "plan" || (config.dryRun && ["run", "once", "sweep"].includes(cmd))) {
  need(config.hqDatabaseUrl, "HQ_DATABASE_URL is required (read-only use)");
  const store = createPgStore({ connectionString: config.hqDatabaseUrl });
  console.log("DRY RUN / observe mode: read-only, no job is claimed and nothing is written or deleted.");
  if (cmd === "run") {
    const ac = new AbortController();
    process.on("SIGTERM", () => ac.abort());
    while (!ac.signal.aborted) {
      await printPlan(store).catch((e) => console.error(`plan failed: ${e.message}`));
      await new Promise((r) => setTimeout(r, config.lifecycle.sweepIntervalMs));
    }
  } else {
    await printPlan(store);
  }
  await store.end();
} else if (cmd === "teardown-plan") {
  need(arg, "teardown-plan needs a signup id");
  assertLiveConfig(config);
  const pg = createPgStore({ connectionString: config.hqDatabaseUrl });
  const signup = await pg.getSignup(arg);
  if (!signup) { console.error(`signup ${arg} not found`); process.exit(1); }
  console.log(`TEARDOWN PLAN for #${signup.id} "${signup.club_name}" (status ${signup.status}, slug ${signup.slug}). Read-only: nothing is deleted.`);
  if (signup.status !== "removing" && !(signup.status === "expired" && signup.teardown_after && new Date(signup.teardown_after) <= new Date())) {
    console.log(`  note: not due for teardown yet (teardown after ${signup.teardown_after ? new Date(signup.teardown_after).toISOString() : "—"}); showing what "Delete now" would remove.`);
  }
  const log = (m) => console.log(`  ${m}`);
  const store = readOnlyStore(pg, log, { simulateRemoving: true });
  const deps = dryRunDeps(liveDeps(), log);
  try {
    await runTeardownJob({ job: { id: null, signup_id: signup.id, state: {} }, store, deps, config: { ...config, dryRun: true } });
  } catch (err) {
    console.log(`  stopped: ${err.message}`);
  }
  await pg.end();
} else if (cmd === "sweep") {
  need(config.hqDatabaseUrl, "HQ_DATABASE_URL is required");
  const store = createPgStore({ connectionString: config.hqDatabaseUrl });
  await store.ensureSchema();
  console.log(JSON.stringify(await runLifecycleSweep({ store, config })));
  await store.end();
} else if (cmd === "run" || cmd === "once") {
  assertLiveConfig(config);
  const store = createPgStore({ connectionString: config.hqDatabaseUrl });
  await store.ensureSchema();
  const deps = liveDeps();
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
} else {
  console.log("usage: node src/cli.js run | once | sweep | plan | dry-run <signupId> | teardown-plan <signupId>   (DRY_RUN=1: read-only)");
  process.exit(cmd ? 2 : 0);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRailwayClient, RailwayError } from "../src/railway.js";
import { createCloudflareClient } from "../src/cloudflare.js";
import { createResendClient } from "../src/email.js";
import { deriveSecret } from "../src/secrets.js";
import { isValidSlug, suggestSlug, clubTypeFor } from "../src/slug.js";

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

test("railway client: bearer auth, GraphQL mutation shapes, errors classified", async () => {
  const f = mockFetch([
    { body: { data: { serviceCreate: { id: "svc_1", name: "club-x" } } } },
    { body: { data: { variableCollectionUpsert: true } } },
    { body: { data: { serviceConnect: { id: "svc_1" } } } },
    { body: { errors: [{ message: "Not Authorized" }] } },
    { status: 503, body: { message: "down" } },
  ]);
  const rw = createRailwayClient({ apiUrl: "https://railway.test/graphql/v2", token: "tok", fetchImpl: f });
  assert.deepEqual(await rw.createService({ projectId: "p", environmentId: "e", name: "club-x" }), { id: "svc_1", name: "club-x" });
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer tok");
  assert.match(f.calls[0].body.query, /serviceCreate\(input: \$input\)/);
  assert.deepEqual(f.calls[0].body.variables.input, { projectId: "p", environmentId: "e", name: "club-x" }, "no source => no deploy on create");
  await rw.upsertVariables({ projectId: "p", environmentId: "e", serviceId: "svc_1", variables: { A: "1" } });
  assert.equal(f.calls[1].body.variables.input.skipDeploys, true);
  await rw.connectSource({ serviceId: "svc_1", repo: "o/r", branch: "b" });
  assert.deepEqual(f.calls[2].body.variables, { id: "svc_1", input: { repo: "o/r", branch: "b" } });
  await assert.rejects(rw.listServices("p"), (e) => e instanceof RailwayError && e.retryable === false && /Not Authorized/.test(e.message));
  await assert.rejects(rw.listServices("p"), (e) => e instanceof RailwayError && e.retryable === true && e.status === 503);
});

test("cloudflare client: zone-scoped endpoints, unproxied records, error surfaced", async () => {
  const f = mockFetch([
    { body: { success: true, result: [] } },
    { body: { success: true, result: { id: "r1" } } },
    { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
  ]);
  const cf = createCloudflareClient({ apiUrl: "https://cf.test/client/v4", token: "cft", zoneId: "z1", fetchImpl: f });
  await cf.listRecords({ type: "CNAME", name: "a.clubhonbu.co.uk" });
  assert.equal(f.calls[0].url, "https://cf.test/client/v4/zones/z1/dns_records?type=CNAME&name=a.clubhonbu.co.uk");
  await cf.createRecord({ type: "CNAME", name: "a.clubhonbu.co.uk", content: "x.up.railway.app", proxied: false, ttl: 1 });
  assert.equal(f.calls[1].init.method, "POST");
  assert.equal(f.calls[1].init.headers.Authorization, "Bearer cft");
  await assert.rejects(cf.listRecords({ type: "TXT", name: "b" }), /10000 Authentication error/);
});

test("resend client sends Idempotency-Key", async () => {
  const f = mockFetch([{ body: { id: "re_1" } }]);
  const r = createResendClient({ apiKey: "re_key", fetchImpl: f });
  assert.equal(await r.send({ from: "a", to: "b@example.com", subject: "s", text: "t", idempotencyKey: "k1" }), "re_1");
  assert.equal(f.calls[0].init.headers["Idempotency-Key"], "k1");
  assert.deepEqual(f.calls[0].body.to, ["b@example.com"]);
});

test("secrets are deterministic per label and need a 32+ char worker secret", () => {
  const s = "x".repeat(32);
  assert.equal(deriveSecret(s, "db:club_a"), deriveSecret(s, "db:club_a"));
  assert.notEqual(deriveSecret(s, "db:club_a"), deriveSecret(s, "db:club_b"));
  assert.throws(() => deriveSecret("short", "x"));
});

test("slugs and club types", () => {
  assert.equal(suggestSlug("St. Mary's Judo & Ju-Jitsu Club!"), "st-mary-s-judo-and-ju-jitsu-cl");
  assert.equal(suggestSlug("Forza Karate"), "forza-karate");
  assert.ok(isValidSlug("forza-karate"));
  for (const bad of ["admin", "www", "a", "-abc", "abc-", "ab--cd", "Abc", "a".repeat(31), "forza", "jhka"]) assert.ok(!isValidSlug(bad), bad);
  assert.equal(clubTypeFor("Martial Arts"), "martial_arts");
  assert.equal(clubTypeFor("Unknown"), "general");
});

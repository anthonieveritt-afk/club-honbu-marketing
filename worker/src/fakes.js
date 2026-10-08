// In-memory stand-ins for Railway, Cloudflare, the tenant Postgres and HTTP health checks.
// Used by the tests and by dry-run mode. They record every call and can inject failures:
//   fail: { methodName: [error | "throw-after-create", ...] }  (consumed one per call)

function makeFailer(fail = {}) {
  return (method) => {
    const queue = fail[method];
    if (!queue?.length) return null;
    return queue.shift();
  };
}
export function transientError(msg = "503 Service Unavailable") {
  const e = new Error(msg); e.retryable = true; return e;
}

export function createFakeRailway({ fail, deployOutcome = ["BUILDING", "DEPLOYING", "SUCCESS"], autoDeployOnConnect = true, log } = {}) {
  const nextFail = makeFailer(fail);
  let n = 0;
  const id = (p) => `${p}_${++n}`;
  const s = { services: [], domains: [], customDomains: [], deployments: [], variables: {}, instance: {}, sources: {}, calls: [] };
  const call = (name, args) => {
    s.calls.push({ name, args });
    log?.(`railway.${name} ${JSON.stringify(args)}`);
    const f = nextFail(name);
    if (f && f !== "throw-after-create") throw f;
    return f;
  };
  const newDeployment = (serviceId) => {
    const d = { id: id("dep"), serviceId, statuses: [...deployOutcome], createdAt: new Date().toISOString() };
    s.deployments.push(d);
    return d;
  };
  const statusOf = (d) => (d.statuses.length > 1 ? d.statuses.shift() : d.statuses[0]);
  return {
    _s: s,
    async listServices(projectId) { call("listServices", { projectId }); return s.services.map(({ id, name }) => ({ id, name })); },
    async createService({ projectId, environmentId, name }) {
      const f = call("createService", { projectId, environmentId, name });
      const svc = { id: id("svc"), name };
      s.services.push(svc);
      if (f === "throw-after-create") throw new Error("socket hang up (service was created)");
      return svc;
    },
    async updateServiceInstance(a) { call("updateServiceInstance", a); s.instance[a.serviceId] = { ...s.instance[a.serviceId], ...a.input }; },
    async upsertVariables(a) {
      call("upsertVariables", { ...a, variables: Object.keys(a.variables) });
      s.variables[a.serviceId] = { ...s.variables[a.serviceId], ...a.variables };
    },
    async listDomains({ serviceId, ...rest }) {
      call("listDomains", { serviceId, ...rest });
      return {
        serviceDomains: s.domains.filter((d) => d.serviceId === serviceId),
        customDomains: s.customDomains.filter((d) => d.serviceId === serviceId),
      };
    },
    async createServiceDomain(a) {
      const f = call("createServiceDomain", a);
      const d = { id: id("sd"), serviceId: a.serviceId, domain: `club-${n}-production.up.railway.app` };
      s.domains.push(d);
      if (f === "throw-after-create") throw new Error("timeout (domain was created)");
      return d;
    },
    async createCustomDomain(a) {
      const f = call("createCustomDomain", a);
      if (s.customDomains.find((d) => d.domain === a.domain)) throw new Error(`Domain ${a.domain} is already in use`);
      const d = { id: id("cd"), serviceId: a.serviceId, domain: a.domain, target: `${id("tgt")}.up.railway.app`, token: "a".repeat(64) };
      s.customDomains.push(d);
      if (f === "throw-after-create") throw new Error("timeout (custom domain was created)");
      return { id: d.id, domain: d.domain };
    },
    async getCustomDomainStatus({ id: cid }) {
      call("getCustomDomainStatus", { id: cid });
      const d = s.customDomains.find((x) => x.id === cid);
      const [host, ...zone] = d.domain.split(".");
      return {
        id: d.id, domain: d.domain,
        status: {
          verified: false, verificationDnsHost: `_railway-verify.${host}`, verificationToken: `railway-verify=${d.token}`,
          dnsRecords: [{ recordType: "DNS_RECORD_TYPE_CNAME", hostlabel: host, fqdn: d.domain, zone: zone.join("."), requiredValue: d.target, purpose: "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE", status: "DNS_RECORD_STATUS_REQUIRES_UPDATE" }],
        },
      };
    },
    async connectSource(a) {
      call("connectSource", a);
      s.sources[a.serviceId] = a;
      if (autoDeployOnConnect) newDeployment(a.serviceId);
    },
    async deploy(a) { call("deploy", a); return newDeployment(a.serviceId).id; },
    async latestDeployment({ serviceId }) {
      call("latestDeployment", { serviceId });
      const d = [...s.deployments].reverse().find((x) => x.serviceId === serviceId);
      return d ? { id: d.id, status: d.statuses[0] } : null;
    },
    async getDeployment(did) {
      call("getDeployment", { id: did });
      const d = s.deployments.find((x) => x.id === did);
      return d ? { id: d.id, status: statusOf(d) } : null;
    },
    async getVariables({ serviceId }) {
      call("getVariables", { serviceId });
      if (!s.services.find((x) => x.id === serviceId)) throw new Error(`Service ${serviceId} not found`);
      return { ...(s.variables[serviceId] || {}) };
    },
    async deleteVariable({ serviceId, name }) {
      call("deleteVariable", { serviceId, name });
      const v = s.variables[serviceId] || {};
      if (!(name in v)) throw new Error(`Variable ${name} not found`);
      delete v[name];
    },
    async redeploy(a) { call("redeploy", a); s.redeploys = (s.redeploys || 0) + 1; },
    async deleteCustomDomain(cid) {
      const f = call("deleteCustomDomain", { id: cid });
      const i = s.customDomains.findIndex((d) => d.id === cid);
      if (i < 0) throw new Error(`Custom domain ${cid} not found`);
      s.customDomains.splice(i, 1);
      if (f === "throw-after-create") throw new Error("timeout (custom domain was deleted)");
    },
    async deleteService({ id: sid, environmentId }) {
      const f = call("deleteService", { id: sid, environmentId });
      const i = s.services.findIndex((x) => x.id === sid);
      if (i < 0) throw new Error(`Service ${sid} not found`);
      s.services.splice(i, 1);
      s.domains = s.domains.filter((d) => d.serviceId !== sid);
      s.customDomains = s.customDomains.filter((d) => d.serviceId !== sid);
      delete s.variables[sid];
      if (f === "throw-after-create") throw new Error("socket hang up (service was deleted)");
    },
  };
}

export function createFakeCloudflare({ fail, existing = [], log } = {}) {
  const nextFail = makeFailer(fail);
  let n = 0;
  const s = { records: existing.map((r) => ({ id: `rec_pre_${++n}`, ...r })), calls: [] };
  const call = (name, args) => {
    s.calls.push({ name, args }); log?.(`cloudflare.${name} ${JSON.stringify(args)}`);
    const f = nextFail(name); if (f && f !== "throw-after-create") throw f; return f;
  };
  return {
    _s: s,
    async listRecords({ type, name }) { call("listRecords", { type, name }); return s.records.filter((r) => r.type === type && r.name === name); },
    async createRecord(rec) {
      const f = call("createRecord", rec);
      const r = { id: `rec_${++n}`, ...rec }; s.records.push(r);
      if (f === "throw-after-create") throw new Error("timeout (record was created)");
      return r;
    },
    async updateRecord(id, rec) { call("updateRecord", { id, ...rec }); Object.assign(s.records.find((r) => r.id === id), rec); },
    async deleteRecord(id) {
      const f = call("deleteRecord", { id });
      const i = s.records.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`81044 Record ${id} does not exist`);
      s.records.splice(i, 1);
      if (f === "throw-after-create") throw new Error("timeout (record was deleted)");
      return { id };
    },
  };
}

export function createFakeTenantDb({ fail, log } = {}) {
  const nextFail = makeFailer(fail);
  const s = { databases: new Map(), calls: [] };
  return {
    _s: s,
    async ensureDatabase({ dbName, roleName, password }) {
      s.calls.push({ name: "ensureDatabase", args: { dbName, roleName } });
      log?.(`tenantDb.ensureDatabase ${dbName} (role ${roleName})`);
      const f = nextFail("ensureDatabase"); if (f) throw f;
      if (s.databases.has(dbName)) return false;
      s.databases.set(dbName, { roleName, password });
      return true;
    },
    async inspect({ dbName }) {
      s.calls.push({ name: "inspect", args: { dbName } });
      return { database: s.databases.has(dbName), role: s.databases.has(dbName) };
    },
    async dropDatabase({ dbName, roleName }) {
      s.calls.push({ name: "dropDatabase", args: { dbName, roleName } });
      log?.(`tenantDb.dropDatabase ${dbName} (role ${roleName})`);
      const f = nextFail("dropDatabase"); if (f) throw f;
      const had = s.databases.delete(dbName);
      return { droppedDb: had, droppedRole: had };
    },
  };
}

/** httpStatus stand-in: returns 200 after `failuresBeforeOk` non-200 answers per URL. */
export function createFakeHttp({ failuresBeforeOk = 0, alwaysDown = [], log } = {}) {
  const seen = new Map();
  const fn = async (url) => {
    log?.(`GET ${url}`);
    if (alwaysDown.some((u) => url.includes(u))) return 0;
    const k = seen.get(url) || 0; seen.set(url, k + 1);
    return k < failuresBeforeOk ? 503 : 200;
  };
  fn.seen = seen;
  return fn;
}

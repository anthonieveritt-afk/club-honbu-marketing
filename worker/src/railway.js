// Minimal Railway public GraphQL API client (https://backboard.railway.com/graphql/v2).
// Field and argument names were checked against the live schema via introspection
// (no token used). Every method is a primitive; the provisioning logic composes them
// idempotently. `fetchImpl` is injectable for tests.

export class RailwayError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.name = "RailwayError";
    this.status = status;
    this.errors = errors;
    // 5xx / 429 / network problems are worth retrying; GraphQL validation errors are not.
    this.retryable = status === undefined || status >= 500 || status === 429;
  }
}

export function createRailwayClient({ apiUrl, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (!token) throw new Error("Railway token missing");

  async function gql(query, variables = {}) {
    let res;
    try {
      res = await fetchImpl(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RailwayError(`Railway request failed: ${err.message}`);
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok) throw new RailwayError(`Railway HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status });
    if (json?.errors?.length) {
      throw new RailwayError(`Railway API error: ${json.errors.map((e) => e.message).join("; ")}`, { status: res.status, errors: json.errors });
    }
    return json.data;
  }

  return {
    gql,

    async listServices(projectId) {
      const d = await gql(
        `query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
        { id: projectId }
      );
      return d.project.services.edges.map((e) => e.node);
    },

    async createService({ projectId, environmentId, name }) {
      // No source on purpose: nothing deploys until variables/region/domains are set.
      const d = await gql(
        `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }`,
        { input: { projectId, environmentId, name } }
      );
      return d.serviceCreate;
    },

    async updateServiceInstance({ serviceId, environmentId, input }) {
      await gql(
        `mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
           serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }`,
        { serviceId, environmentId, input }
      );
    },

    async upsertVariables({ projectId, environmentId, serviceId, variables }) {
      await gql(
        `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
        { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } }
      );
    },

    async listDomains({ projectId, environmentId, serviceId }) {
      const d = await gql(
        `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
           domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
             serviceDomains { id domain }
             customDomains { id domain }
           } }`,
        { projectId, environmentId, serviceId }
      );
      return d.domains;
    },

    async createServiceDomain({ environmentId, serviceId, targetPort }) {
      const d = await gql(
        `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain } }`,
        { input: { environmentId, serviceId, targetPort } }
      );
      return d.serviceDomainCreate;
    },

    async createCustomDomain({ projectId, environmentId, serviceId, domain, targetPort }) {
      const d = await gql(
        `mutation($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id domain } }`,
        { input: { projectId, environmentId, serviceId, domain, targetPort } }
      );
      return d.customDomainCreate;
    },

    /** DNS records Railway wants for a custom domain (routing CNAME + ownership TXT). */
    async getCustomDomainStatus({ projectId, id }) {
      const d = await gql(
        `query($id: String!, $projectId: String!) {
           customDomain(id: $id, projectId: $projectId) {
             id domain
             status {
               verified verificationDnsHost verificationToken certificateStatus
               dnsRecords { recordType hostlabel fqdn zone requiredValue purpose status }
             } } }`,
        { id, projectId }
      );
      return d.customDomain;
    },

    async connectSource({ serviceId, repo, branch, image }) {
      const input = image ? { image } : { repo, branch };
      await gql(
        `mutation($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`,
        { id: serviceId, input }
      );
    },

    async deploy({ serviceId, environmentId }) {
      const d = await gql(
        `mutation($serviceId: String!, $environmentId: String!) {
           serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }`,
        { serviceId, environmentId }
      );
      return d.serviceInstanceDeployV2; // deployment id
    },

    async latestDeployment({ projectId, environmentId, serviceId }) {
      const d = await gql(
        `query($input: DeploymentListInput!) {
           deployments(input: $input, first: 1) { edges { node { id status createdAt } } } }`,
        { input: { projectId, environmentId, serviceId } }
      );
      return d.deployments.edges[0]?.node || null;
    },

    async getDeployment(id) {
      const d = await gql(`query($id: String!) { deployment(id: $id) { id status } }`, { id });
      return d.deployment;
    },
  };
}

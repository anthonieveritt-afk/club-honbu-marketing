// Minimal Cloudflare DNS client (zone-scoped API token with DNS:Edit). Injectable fetch.
export class CloudflareError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.retryable = status === undefined || status >= 500 || status === 429;
  }
}

export function createCloudflareClient({ apiUrl, token, zoneId, fetchImpl = fetch, timeoutMs = 30000 }) {
  if (!token || !zoneId) throw new Error("Cloudflare token/zone missing");
  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${apiUrl}/zones/${zoneId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CloudflareError(`Cloudflare request failed: ${err.message}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      const msg = json?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new CloudflareError(`Cloudflare API error: ${msg}`, { status: res.status });
    }
    return json.result;
  }
  return {
    async listRecords({ type, name }) {
      return call("GET", `/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`);
    },
    async createRecord(record) {
      return call("POST", "/dns_records", record);
    },
    async updateRecord(id, record) {
      return call("PATCH", `/dns_records/${id}`, record);
    },
  };
}

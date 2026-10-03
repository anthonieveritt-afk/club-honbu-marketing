export async function httpStatus(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  try {
    const r = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return r.status;
  } catch {
    return 0;
  }
}

/** Polls until fn() returns a truthy value or the timeout passes. */
export async function pollUntil(fn, { timeoutMs, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

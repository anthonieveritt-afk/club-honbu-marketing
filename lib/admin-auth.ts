// HTTP Basic auth for /admin/*. Edge-safe (used by middleware and re-checked in pages).
// Interim protection until the Club Honbu HQ CRM (per-person logins) replaces it.

export function adminConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12;
}

function safeEqual(a: string, b: string): boolean {
  // Constant-time for equal lengths; length mismatch still walks the longer string.
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function isAdminAuthorized(authorization: string | null | undefined): boolean {
  if (!adminConfigured() || !authorization) return false;
  const [scheme, encoded] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return false;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const okUser = safeEqual(user, expectedUser);
  const okPass = safeEqual(pass, process.env.ADMIN_PASSWORD as string);
  return okUser && okPass;
}

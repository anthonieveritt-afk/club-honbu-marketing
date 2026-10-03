// Mirrors worker/src/slug.js (the worker re-validates; this is for the admin form).
export const RESERVED_SLUGS = new Set([
  "www", "hq", "admin", "api", "app", "mail", "email", "smtp", "ftp", "staging", "test", "dev",
  "status", "help", "support", "docs", "blog", "billing", "login", "signup", "get-started", "static",
  "cdn", "assets", "dashboard", "portal", "forza", "jhka",
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug);
}

export function suggestSlug(clubName: string): string {
  return String(clubName || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 30).replace(/-+$/g, "");
}

export const RESERVED_SLUGS = new Set([
  "www", "hq", "admin", "api", "app", "mail", "email", "smtp", "ftp", "staging", "test", "dev",
  "status", "help", "support", "docs", "blog", "billing", "login", "signup", "get-started", "static",
  "cdn", "assets", "dashboard", "portal", "forza", "jhka",
]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && !slug.includes("--") && !RESERVED_SLUGS.has(slug);
}

export function suggestSlug(clubName) {
  return String(clubName || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 30).replace(/-+$/g, "");
}

const SPORT_TO_CLUB_TYPE = {
  "Martial Arts": "martial_arts", Football: "football", Netball: "netball", Rugby: "rugby",
  Dance: "dance", Gymnastics: "gymnastics", General: "general",
};
export function clubTypeFor(sport) {
  return SPORT_TO_CLUB_TYPE[sport] || "general";
}

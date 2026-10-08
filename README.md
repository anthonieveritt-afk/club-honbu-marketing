# Club Honbu — Marketing Site

One-page marketing site for **Club Honbu** — SaaS for martial-arts clubs.
Domain: [clubhonbu.co.uk](https://clubhonbu.co.uk) (clubhonbu.com 301 → .co.uk).
Tagline: *Built by an instructor, for instructors.*

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Inter (via `next/font`) for the wordmark and body
- No external UI lib — accordion is hand-rolled (kept dependencies minimal)

## Develop

```bash
pnpm install
pnpm dev      # http://localhost:3000
```

## Build

```bash
pnpm build
pnpm start
```

The site is a static marketing page — no server-only features. It will work as a regular Next build, and can be exported statically if needed by adding `output: 'export'` to `next.config.mjs`.

## Structure

```
app/
  layout.tsx          # root layout, font, metadata
  page.tsx            # one-page scroll site (hero → problem → features → story → pricing → faq → cta)
  globals.css         # tailwind + base tokens (warm white #FAF7F2, ink, accent #0066cc)
  privacy/page.tsx    # placeholder
  terms/page.tsx      # placeholder
components/
  Nav.tsx             # sticky nav, wordmark + links + pill CTA
  Footer.tsx
  Accordion.tsx       # FAQ accordion (client)
  Wordmark.tsx        # text wordmark — no logo mark yet
```

## Design tokens

- **Canvas (warm white):** `#FAF7F2`
- **Ink (near-black):** `#0A0A0A`
- **Muted:** `#5C5C5C`
- **Accent:** `#0066cc`
- **Line:** `#E8E2D7`
- **Wordmark font:** Inter, semibold, tight tracking

## Deploy

**Recommended: Vercel.** This is a Next.js marketing site — Vercel is the path of least resistance.

1. Push the repo to GitHub.
2. Import into Vercel, framework auto-detects.
3. Add `clubhonbu.co.uk` as a domain. Add `clubhonbu.com` and set it to permanent (308) redirect to the apex.
4. Env vars for sign-up capture: see "Sign-ups" below. Without them the rest of the site still works.

Railway also works fine if preferred — point at the repo, it'll detect Next and build.

## Content notes

- All copy is in `app/page.tsx`. No CMS yet — edit and redeploy.
- No fake testimonials, no fabricated logos, no made-up stats. Keep it that way.
- Founder note is intentionally light on biographical claims — only "Anthoni & Jade, karate instructors who built it for their own club".

## TODO (not done in this build)

- Real privacy + terms copy.
- OG image / favicon set.
- Real screenshots / product visuals (currently text-only — no fake product mockups shipped).
- Analytics (Plausible / Vercel Analytics).
- Cookie banner if/when analytics or 3rd-party scripts get added.
- Sitemap + robots.txt.

## Sign-ups (`/get-started`)

`app/actions/signup.ts` validates the form, then:

1. **Stores** it in Postgres table `club_signups` (`db/schema.sql`, created automatically on first
   use). The password is stored only as a bcrypt hash (bcryptjs, cost 12, same format the
   club-honbu app's admin login checks), never in plain text, never emailed or logged.
2. **Emails a notification** (no password) to `SIGNUP_NOTIFY_TO` via Resend, if `RESEND_API_KEY` is set.
3. Emails the club a confirmation only when `RESEND_FROM` is set (i.e. clubhonbu.co.uk is verified in Resend).

The form only reports success if the sign-up was stored or the notification was sent; otherwise it
asks the person to try again or email hello@clubhonbu.co.uk.

Abuse protection: hidden honeypot field, a 3-second minimum fill time (both silently dropped), and
rate limits per salted IP hash (5/hour) and per email (3/day) using the `signup_attempts` table.

**`/admin/signups`**: list, newest first, behind HTTP Basic auth. Returns 404 unless
`ADMIN_PASSWORD` (12+ chars) is set. Interim until the Club Honbu HQ CRM replaces it.
Actions (server actions, same Basic auth, re-checked):
* **Approve** (with a subdomain, pre-filled from the club name) → status `approved` + one row in
  `provisioning_jobs` (idempotent: a double click cannot queue a second job).
* **Reject** (optional internal reason) → status `rejected`, stored password hash cleared, a queued
  job is cancelled.
* **Retry provisioning** for a `failed` job.
* **Extend trial** (1–60 days), **Mark converted** (never removed), **Delete now** (type the
  subdomain to confirm), **Retry removal** / **Retry instance update** — see
  [`docs/trial-lifecycle.md`](docs/trial-lifecycle.md).

With `AUTO_APPROVE_SIGNUPS=1` new sign-ups are approved automatically with a unique subdomain from
the club name (`my-dojo`, `my-dojo-2`, …), capped by `AUTO_APPROVE_MAX_PER_DAY` (default 20);
anything unusual falls back to manual Approve. The trial is 7 days, then 7 days read-only, then the
club is removed — the full lifecycle, env vars, a staging end-to-end test and rollback are in
[`docs/trial-lifecycle.md`](docs/trial-lifecycle.md).

The website never calls Railway or Cloudflare. The provisioning worker in [`worker/`](worker/README.md)
polls `provisioning_jobs` and builds the club's trial instance, then sets the sign-up to
`trial_active` with its URL.

| Env var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | yes | Postgres connection string (Neon via Vercel Marketplace, or Railway) |
| `ADMIN_PASSWORD` | yes, for /admin | Basic-auth password (12+ chars) |
| `ADMIN_USERNAME` | no | Basic-auth username, default `admin` |
| `RESEND_API_KEY` | recommended | Notification emails |
| `SIGNUP_NOTIFY_TO` | no | Default `anthonieveritt@gmail.com` |
| `RESEND_FROM` | after domain verification | e.g. `Club Honbu <hello@clubhonbu.co.uk>`; until set, notifications use `onboarding@resend.dev` (only delivers to the Resend account owner's address) and no confirmation goes to clubs |
| `SIGNUP_HASH_SALT` | recommended | Random string used to hash IPs |
| `SITE_URL` | no | Default `https://clubhonbu.co.uk` (link in the notification) |
| `PG_SSL_NO_VERIFY` | no | `1` only if the DB proxy uses a self-signed cert |
| `SIGNUP_LIMIT_PER_IP_HOUR` / `SIGNUP_LIMIT_PER_EMAIL_DAY` | no | Override rate limits (5 / 3) |
| `AUTO_APPROVE_SIGNUPS` | no | `1` = approve sign-ups automatically (default off) |
| `AUTO_APPROVE_MAX_PER_DAY` | no | Daily cap for auto-approval, default 20 |
| `TRIAL_DAYS` / `TRIAL_GRACE_DAYS` / `BASE_DOMAIN` | no | Display on /admin only; keep equal to the worker's (7 / 7 / clubhonbu.co.uk) |

Test (real Postgres + Chrome): see the header of `scripts/test-signup-capture.mjs`, then `pnpm test:signup`.
Approval flow end to end (local DB, worker with fake Railway/Cloudflare): `scripts/test-hq-approval.mjs`.
Trial lifecycle end to end (auto-approve → reminders → expiry → extend/convert → teardown): `scripts/test-trial-lifecycle.mjs`.
Worker unit/integration tests: `cd worker && npm test`.

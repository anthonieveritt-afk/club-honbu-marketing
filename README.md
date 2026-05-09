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
4. No env vars required.

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
- Trial signup flow — currently the CTAs `mailto:` `hello@clubhonbu.co.uk`. Wire to real signup when the app exists.
- Cookie banner if/when analytics or 3rd-party scripts get added.
- Sitemap + robots.txt.

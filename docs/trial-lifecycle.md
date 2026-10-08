# Club Honbu free-trial lifecycle (no payment yet)

What happens to a club from sign-up to removal, what has to be configured where, and how to prove
it works end to end on a throwaway sign-up **before** anything touches production or Stripe is added.

```
/get-started ──▶ club_signups (new)
   │  AUTO_APPROVE_SIGNUPS=1: approved at once with a unique subdomain from the club name
   │  otherwise: Anthoni clicks Approve on /admin/signups (still works with auto-approve on)
   ▼
approved ──worker: provision job──▶ trial_active   (Railway service + tenant DB + DNS; TRIAL_ENDS_AT = now + 7 days)
   │  2 days and 1 day before the end: reminder emails (once each)
   ▼  TRIAL_ENDS_AT passes
expired      the club app locks itself from its own TRIAL_ENDS_AT: "Your trial has ended" screen,
   │         upgrade/contact buttons, data viewable read-only, public pages unavailable
   │         admin: Extend trial (club unlocks), Mark converted (never removed), Delete now
   ▼  TRIAL_ENDS_AT + TRIAL_GRACE_DAYS (7) passes
removing ──worker: teardown job──▶ removed   (DNS records, Railway custom domain, Railway service,
                                              tenant database + role deleted; "removed" email)
converted    never torn down: checked by the sweep, the admin action and before every destructive step
```

Every step is a row in `provisioning_events` (visible as "Last: …" on `/admin/signups`). Every
step is idempotent: deterministic names (`club-<slug>`, `club_<slug>`, `club_<slug>_app`),
look-before-create / look-before-delete, per-step progress in `provisioning_jobs.state`, one job
per (sign-up, kind), emails unique per (sign-up, kind) and sent with a Resend idempotency key.
A failed step retries with backoff; after `max_attempts` the job shows **Retry** on the admin page.

## Pieces and where they run

| Piece | Repo / branch | Runs on | What changed |
|---|---|---|---|
| Marketing site + `/admin/signups` (HQ) | `club-honbu-marketing` `feat/trial-lifecycle` (stacked on `feat/hq-provisioning`) | Vercel | 7-day copy, auto-approve, lifecycle columns, Extend / Mark converted / Delete now / Retry removal |
| HQ worker | same repo, `worker/` | Railway service (not deployed yet) or run by hand | lifecycle sweep, teardown and sync_trial jobs, DRY_RUN, `plan`, `teardown-plan` |
| Club app (each trial club) | `club-honbu` `feat/trial-lifecycle` (contains `feat/club-neutral` + `feat/trial-instance`) | one Railway service per club, created by the worker | enforces `TRIAL_ENDS_AT` + `CLUB_SUSPENDED`, "Your trial has ended" screen |

**Important:** `club-honbu` `main` does **not** contain any trial code (no `TRIAL_ENDS_AT`,
`DB_BOOTSTRAP`, `ADMIN_PASSWORD_HASH`). Trial clubs must be built from `feat/trial-lifecycle`
until that PR is merged, so the worker refuses to run live without `CLUB_SOURCE_BRANCH` (or
`CLUB_SOURCE_IMAGE`). Clubs without `TRIAL_ENDS_AT` (Forza, JHKA, …) behave exactly as before.

## Environment variables

### Vercel (marketing site / HQ)

| Var | Needed | Notes |
|---|---|---|
| `DATABASE_URL` | yes | HQ Postgres (Neon). The new columns/constraints are added automatically on first request (additive, idempotent). **For the test, use a separate database (a Neon branch) on a Preview deployment**, otherwise the preview migrates and writes to production. |
| `ADMIN_PASSWORD` (12+ chars), `ADMIN_USERNAME` | yes | unchanged |
| `AUTO_APPROVE_SIGNUPS` | optional | `1` = approve new sign-ups automatically. Off by default. Any problem (no free slug, DB error, cap reached) falls back to manual approval. |
| `AUTO_APPROVE_MAX_PER_DAY` | optional | default `20`; above this sign-ups wait for manual approval |
| `TRIAL_DAYS`, `TRIAL_GRACE_DAYS`, `BASE_DOMAIN` | optional | display only on `/admin/signups` (the worker decides the real values). Keep them equal to the worker's. |
| `RESEND_API_KEY`, `RESEND_FROM`, `SIGNUP_NOTIFY_TO`, `SIGNUP_HASH_SALT`, `SITE_URL` | as before | unchanged |

### Worker (Railway service built from `worker/Dockerfile`, repo root as context — or run by hand)

| Var | Needed | Notes |
|---|---|---|
| `HQ_DATABASE_URL` | yes | same HQ database the site uses (the preview/Neon-branch DB for the test) |
| `WORKER_SECRET` | yes | 32+ random chars; club DB passwords and session secrets are derived from it — **never change it** once clubs exist |
| `RAILWAY_API_TOKEN` | yes | account or team token (sent as `Bearer`; a project token will not work) |
| `TENANT_PROJECT_ID`, `TENANT_ENVIRONMENT_ID` | yes | a **dedicated** Railway project for trial clubs. Never the Forza/JHKA project: teardown deletes services in this project (only ones named `club-<slug>` whose id matches what HQ recorded, but keep the blast radius zero). |
| `TENANT_PG_ADMIN_URL` | yes | superuser URL of the Postgres that holds club databases, reachable from the worker (Railway TCP proxy URL if the worker runs outside Railway) |
| `TENANT_PG_APP_HOST` | usually | host:port the club apps use, default `postgres.railway.internal:5432` |
| `CLOUDFLARE_API_TOKEN` | yes | scoped token: Zone → DNS → Edit on clubhonbu.co.uk only |
| `CLOUDFLARE_ZONE_ID` | yes | clubhonbu.co.uk zone id (Cloudflare dashboard → Overview) |
| `CLUB_SOURCE_BRANCH` | yes | `feat/trial-lifecycle` until the club-honbu PR is merged, then `main` |
| `CLUB_SOURCE_REPO` | optional | default `anthonieveritt-afk/club-honbu`; Railway's GitHub app must have access to it |
| `BASE_DOMAIN` | optional | default `clubhonbu.co.uk`; use `staging.clubhonbu.co.uk` for the test (records go into the same zone, e.g. `my-dojo.staging.clubhonbu.co.uk`) |
| `TRIAL_DAYS` | optional | default `7` (fractions allowed, e.g. `0.05` ≈ 72 min, for testing) |
| `TRIAL_GRACE_DAYS` | optional | default `7` |
| `TRIAL_REMINDER_DAYS` | optional | default `2,1` |
| `SWEEP_INTERVAL_MS` | optional | default `300000` (5 min) |
| `LIFECYCLE_ENABLED` | optional | `0` = no reminders/expiry/teardown (provisioning only) |
| `TEARDOWN_ENABLED` | optional | `0` = never delete anything (expired clubs stay expired; queued teardowns wait) |
| `DRY_RUN` | optional | `1` = read-only observe mode: prints the plan and queued jobs, never writes or calls Railway/Cloudflare |
| `EMAILS_ENABLED` | optional | `1` to actually send welcome/reminder/ended/removed emails (`WELCOME_EMAIL_ENABLED=1` still works) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | for emails | `EMAIL_FROM` must be on a domain verified in Resend (clubhonbu.co.uk) |
| `TRIAL_UPGRADE_URL` | optional | shown on the "trial ended" screen and in emails; empty = "Upgrade (contact us)" mailto placeholder |
| `TRIAL_CONTACT_EMAIL` | optional | default `hello@clubhonbu.co.uk` |

### Club app (set automatically by the worker on each trial club's Railway service — nothing to do)

`CLUB_PROFILE=neutral`, `CLUB_NAME`, `CLUB_TYPE`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`,
`TRIAL_ENDS_AT`, `TRIAL_GRACE_DAYS`, `TRIAL_CONTACT_EMAIL`, `TRIAL_UPGRADE_URL` (if set),
`SESSION_SECRET`, `JWT_SECRET`, `DATABASE_URL`, `DB_BOOTSTRAP=1`, `SITE_URL`.
`CLUB_SUSPENDED=1` is a manual hard switch (blocks the whole app, not just writes); HQ removes it on
Extend/Convert. Extend pushes the new `TRIAL_ENDS_AT`; Convert removes the trial variables; both
redeploy the club service (`sync_trial` job).

## Accounts and tokens Anthoni needs to provide

1. **Railway**: an account/team API token, and a new empty project for trial clubs (gives
   `TENANT_PROJECT_ID` + `TENANT_ENVIRONMENT_ID`) with a Postgres service in it
   (`TENANT_PG_ADMIN_URL` = its public TCP proxy superuser URL; `TENANT_PG_APP_HOST` = its
   internal host:port). Railway's GitHub app must be allowed to read `anthonieveritt-afk/club-honbu`.
2. **Cloudflare**: API token with Zone:DNS:Edit for clubhonbu.co.uk only, plus the zone id.
3. **HQ database for the test**: a Neon branch of the HQ database (or any throwaway Postgres) URL.
4. **Resend**: clubhonbu.co.uk verified (SPF/DKIM records in Cloudflare) and an API key, if the
   test should send real emails. Without it, emails are only queued in `trial_emails`.
5. A random `WORKER_SECRET` (e.g. `openssl rand -hex 32`) and an `ADMIN_PASSWORD` for the preview.

Paste these into the Vercel **Preview** environment and the worker's environment directly — never
into chat, tickets or the repo.

## Real end-to-end test on a throwaway sign-up (staging subdomain)

Nothing below touches the production site, the production HQ database or existing clubs.

1. **HQ preview.** Open the marketing PR's Vercel *Preview* deployment. In Vercel → Settings →
   Environment Variables, scope to **Preview** only: `DATABASE_URL` = the Neon branch,
   `ADMIN_PASSWORD`, `AUTO_APPROVE_SIGNUPS=1`, `BASE_DOMAIN=staging.clubhonbu.co.uk`,
   `TRIAL_DAYS=0.05`, `TRIAL_GRACE_DAYS=0.02`. Redeploy the preview.
2. **Worker env** (run it from a laptop/box first, deploy later):
   ```bash
   cd worker && npm ci
   export HQ_DATABASE_URL=… WORKER_SECRET=… RAILWAY_API_TOKEN=… TENANT_PROJECT_ID=… \
          TENANT_ENVIRONMENT_ID=… TENANT_PG_ADMIN_URL=… TENANT_PG_APP_HOST=… \
          CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ZONE_ID=… \
          CLUB_SOURCE_BRANCH=feat/trial-lifecycle BASE_DOMAIN=staging.clubhonbu.co.uk \
          TRIAL_DAYS=0.05 TRIAL_GRACE_DAYS=0.02 TRIAL_REMINDER_DAYS=0.03,0.015 SWEEP_INTERVAL_MS=60000
   ```
   (≈72-minute trial, reminders at ≈43 and ≈22 minutes left, removal ≈29 minutes after expiry.
   With fractional days the reminder email says e.g. "0.03 days" — cosmetic, test only.)
3. **Sign up** on the preview's `/get-started` with a throwaway club name (e.g. "Zz Test Dojo")
   and an email you can read. `/admin/signups` should show it `approved` with "auto-approved" and
   subdomain `zz-test-dojo` (club A). Sign up club B ("Zz Test Dojo B") and later club C the same
   way; the worker provisions them one job at a time.
4. **Observe, no writes:** `DRY_RUN=1 node src/cli.js once` → prints the queued provision job.
   `node src/cli.js dry-run <id>` → prints every Railway/Cloudflare/DB call it would make (fakes).
5. **Provision for real:** `node src/cli.js once` (5–15 min: creates service, DB, DNS, deploys,
   waits for `/health`). The admin page shows `trial_active` and the link
   `https://zz-test-dojo.staging.clubhonbu.co.uk`. Log in with the sign-up's username/password;
   the trial banner shows the end time.
6. **Lifecycle:** `node src/cli.js run` (polls jobs + sweeps every minute). At any time
   `node src/cli.js plan` shows what is due. Check:
   - two reminder events (and emails if `EMAILS_ENABLED=1`);
   - at the end time: admin status `expired`; the club shows **"Your trial has ended"** with
     Upgrade/Contact buttons and "View my data (read-only)"; saving anything fails; `/shop`,
     `/join`, `/trial-form` say registration is unavailable;
   - on a **second** throwaway sign-up (club B), after it has expired: **Extend trial** by 1 day →
     `sync_trial` job → club B redeploys and unlocks (~2 min); then **Mark converted** → the trial
     banner disappears after the redeploy. Leave club A alone so it runs the full lifecycle.
7. **Before teardown runs**, stop `run` and check exactly what it would delete:
   `node src/cli.js teardown-plan <id>` (real read-only lookups; deletes nothing). It must list only
   `club-zz-test-dojo`, its custom domain, the two `*.zz-test-dojo.staging…` DNS records and
   `club_zz_test_dojo` / `club_zz_test_dojo_app`.
8. **Teardown:** start `node src/cli.js run` again. After the grace period the admin page shows
   `removing` → `removed` with a timestamp; the Railway service, custom domain, DNS records and
   database are gone; "Last:" says all resources deleted. Running `once`/`sweep` again changes nothing.
9. **Converted club:** club B stays `converted`, with its service
   running, after its grace time has passed. Converted clubs refuse **Delete now** by design, so
   remove that test club by hand afterwards (see the last row of Rollback). Test **Delete now** on a
   third, unconverted throwaway sign-up (type the subdomain to confirm): it goes straight to
   `removing` → `removed`.
10. Remove the Preview env vars / Neon branch when done, or keep them for the next test.

Going live afterwards (separate decision): merge club-honbu `feat/trial-lifecycle` → set
`CLUB_SOURCE_BRANCH=main`; merge the marketing PRs; deploy the worker as a Railway service with the
production env (real 7/7 days, `BASE_DOMAIN=clubhonbu.co.uk`), first with `DRY_RUN=1` for a day,
then `TEARDOWN_ENABLED=0` for a week, then teardown on.

## Rollback

| Situation | Do this |
|---|---|
| Worker misbehaving | Stop/delete the worker's Railway service (or set `DRY_RUN=1`). Nothing else depends on it; sign-ups keep being stored. |
| Don't want anything deleted | `TEARDOWN_ENABLED=0` (expired clubs stay locked, queued teardowns wait) or `LIFECYCLE_ENABLED=0` (no reminders/expiry either). |
| Auto-approve letting too many through | Remove `AUTO_APPROVE_SIGNUPS` in Vercel; sign-ups wait for manual Approve. Lower `AUTO_APPROVE_MAX_PER_DAY`. |
| A club locked by mistake | **Extend trial** or **Mark converted** on `/admin/signups`; or in Railway delete the club's `TRIAL_ENDS_AT` / `CLUB_SUSPENDED` variable and redeploy. |
| A teardown that shouldn't happen | While it is still queued: **Mark converted** or **Extend trial** cancels it (each step also re-checks and stops for converted clubs). Once a step has run, HQ refuses and that resource is gone — the tenant DB is dropped, so restore from a Railway Postgres backup if enabled. Use `TEARDOWN_ENABLED=0` until you trust it. |
| Revert the code | Revert/close the PRs. Vercel: promote the previous production deployment. The new DB columns are additive and harmless to the old code; the widened status/job-kind CHECK constraints accept everything the old code writes. |
| Remove a half-built test club by hand | Railway: delete service `club-<slug>` in the tenant project. Cloudflare: delete the `<slug>.<base>` CNAME and `_railway-verify.<slug>.<base>` TXT (comment "managed by club-honbu-hq"). Postgres: `DROP DATABASE club_<slug> WITH (FORCE); DROP ROLE club_<slug>_app;` |

## Tests

- `cd worker && npm test` — 25 tests: real local Postgres, fake Railway/Cloudflare/HTTP/Resend:
  provisioning, the whole lifecycle with a simulated clock (reminders → expiry → teardown), retries
  after failures mid-teardown, converted clubs never touched, foreign DNS records / renamed services
  left alone, extend, `TEARDOWN_ENABLED=0`, DRY_RUN observe mode, real `DROP DATABASE`.
- `scripts/test-trial-lifecycle.mjs` — browser end to end against a local `next start`
  (`AUTO_APPROVE_SIGNUPS=1`): sign-up → auto-approve (unique `-2` slug) → provision (fakes) →
  reminders → expiry → Extend → Mark converted → teardown → Delete now with typed confirmation →
  failed removal + Retry removal → emails sent once each. See the script header.
- `scripts/test-hq-approval.mjs`, `scripts/test-signup-capture.mjs` — existing, still pass (run with
  `AUTO_APPROVE_SIGNUPS` unset).
- Club app: `club-honbu/tests/regression/test-trial-lifecycle.mjs` (API + UI of the ended/suspended
  screens) and `test-trial-instance.mjs`.

# Club Honbu HQ provisioning worker

Turns an **approved** `club_signups` row into a running trial club:

| step | what it does (find-or-create, safe to repeat) |
|---|---|
| prepare | validate slug, derive names `club-<slug>` / `club_<slug>` / `club_<slug>_app`, trial end = now + `TRIAL_DAYS` |
| database | `CREATE ROLE` + `CREATE DATABASE` on the shared tenant Postgres, `REVOKE CONNECT ... FROM PUBLIC` |
| service | Railway `serviceCreate` (no source, so nothing deploys yet), region + serverless + `/health` healthcheck |
| configure | `variableCollectionUpsert` (skipDeploys): `CLUB_PROFILE=neutral`, `CLUB_NAME`, `CLUB_TYPE`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (the bcrypt hash from the sign-up), `TRIAL_ENDS_AT`, `SESSION_SECRET`/`JWT_SECRET`, `DATABASE_URL`, `DB_BOOTSTRAP=1` |
| domains | Railway service domain (`*.up.railway.app`) + custom domain `<slug>.clubhonbu.co.uk` |
| dns | Cloudflare `CNAME <slug>` → Railway target and `TXT _railway-verify.<slug>`; unproxied; never overwrites a record it didn't create (comment `managed by club-honbu-hq`) |
| deploy | `serviceConnect` (repo/branch or image) then `serviceInstanceDeployV2`; waits for `SUCCESS`/`SLEEPING`; a `FAILED`/`CRASHED` deploy is redeployed on retry |
| health | polls `https://<railway-domain>/health` until 200 (then the custom domain, best-effort: TLS can lag) |
| finalize | sign-up → `trial_active` with `instance_url`, `trial_ends_at`; `password_hash` nulled in HQ; welcome email row queued |

After provisioning, the **lifecycle sweep** (every `SWEEP_INTERVAL_MS`, default 5 min) queues the
2-day and 1-day reminder emails, marks trials `expired` when `TRIAL_ENDS_AT` passes (the club app
locks itself from its own `TRIAL_ENDS_AT`), and after `TRIAL_GRACE_DAYS` queues a **teardown** job:
guard → dns (only records with the HQ comment) → custom_domain → service (only `club-<slug>` with the
recorded id) → database (`DROP DATABASE … WITH (FORCE)` + role, only `club_*`) → finalize
(`removed`, email). Converted clubs are skipped everywhere and every teardown step re-checks.
Extend/Convert on `/admin/signups` queue a **sync_trial** job that updates `TRIAL_ENDS_AT` (or removes
the trial variables) on the club's service and redeploys it. Full details: [`../docs/trial-lifecycle.md`](../docs/trial-lifecycle.md).

Statuses: `approved` → `provisioning` → `trial_active` ; if the job gives up (`max_attempts`, or a permanent error such as a bad slug or a DNS record it doesn't own) the job is `failed` with `last_error`, the sign-up stays `provisioning`, and **Retry** on `/admin/signups` re-queues it from the failed step.

## Guarantees
* **No duplicates.** One job per sign-up (`UNIQUE(signup_id, kind)`); jobs are claimed with `FOR UPDATE SKIP LOCKED` and a lease; every external object has a deterministic name and is looked up before being created; the welcome email is `UNIQUE(signup_id, kind)` and sent with a Resend `Idempotency-Key`.
* **Resumable.** Progress is saved to `provisioning_jobs.state` after each step. A failed job retries with backoff (1/5/15/60 min) from the step that failed; a crashed worker's lease expires and another run picks it up.
* **Secrets** (DB password, session/JWT secrets) are derived with HMAC from `WORKER_SECRET` + slug, so re-runs produce the same values and nothing secret is stored in the HQ DB.
* Emails only go out when `EMAILS_ENABLED=1` (or `WELCOME_EMAIL_ENABLED=1`) **and** `RESEND_API_KEY` is set. The email never contains a password.

## Commands
```
npm test                            # mocked Railway/Cloudflare/HTTP, real local Postgres (see test/helpers.js)
node src/cli.js plan                # what the lifecycle sweep would do now (read-only)
node src/cli.js dry-run <id>        # print every provisioning call it WOULD make, using fakes (read-only)
node src/cli.js teardown-plan <id>  # real read-only lookups: exactly what teardown would delete
node src/cli.js sweep               # live: one lifecycle sweep, then exit
node src/cli.js once                # live: run at most one job
node src/cli.js run                 # live: poll jobs + sweep forever (the deployed mode)
DRY_RUN=1 node src/cli.js run       # observe mode: print plan + queued jobs, never write or call APIs
```
Tests need a throwaway local Postgres: `TEST_PG_ADMIN_URL` (default `postgres://postgres@127.0.0.1:5544/postgres`). They create and drop `hqtest_*` databases. Never point them at production.

## Env
See `src/config.js` and the table in [`../docs/trial-lifecycle.md`](../docs/trial-lifecycle.md). Live mode refuses to start without `HQ_DATABASE_URL`, `WORKER_SECRET` (32+ chars), `RAILWAY_API_TOKEN`, `TENANT_PROJECT_ID`, `TENANT_ENVIRONMENT_ID`, `TENANT_PG_ADMIN_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` and `CLUB_SOURCE_BRANCH` (or `CLUB_SOURCE_IMAGE`) — there is no default branch because club-honbu `main` has no trial code yet; use `feat/trial-lifecycle` until it is merged.
Optional: `CLUB_SOURCE_REPO`, `TENANT_REGION`, `TENANT_SERVERLESS`, `TENANT_PG_APP_HOST`, `BASE_DOMAIN`, `TRIAL_DAYS` (7), `TRIAL_GRACE_DAYS` (7), `TRIAL_REMINDER_DAYS` (`2,1`), `SWEEP_INTERVAL_MS`, `LIFECYCLE_ENABLED`, `TEARDOWN_ENABLED`, `DRY_RUN`, `TRIAL_UPGRADE_URL`, `TRIAL_CONTACT_EMAIL`, `EMAILS_ENABLED` (or `WELCOME_EMAIL_ENABLED`), `RESEND_API_KEY`, `EMAIL_FROM`, timeouts.

## Deploy
Not deployed. Runs as a Railway service built from `worker/Dockerfile` with the repo root as context, in its own project/service — see the step-by-step test and go-live order in [`../docs/trial-lifecycle.md`](../docs/trial-lifecycle.md).

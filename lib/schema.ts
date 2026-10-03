// Keep identical to db/schema.sql (scripts/test-signup-capture.mjs checks this).
export const SCHEMA_SQL = `
-- Club Honbu marketing site: sign-up capture.
-- Applied automatically (idempotent) on first use by lib/signups.ts, or run by hand:
--   psql "$DATABASE_URL" -f db/schema.sql
-- status values match the planned Club Honbu HQ pipeline so the CRM can reuse this table.

CREATE TABLE IF NOT EXISTS club_signups (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  club_name      TEXT NOT NULL,
  sport_type     TEXT NOT NULL,
  contact_name   TEXT NOT NULL,
  email          TEXT NOT NULL,
  website        TEXT,
  admin_username TEXT NOT NULL,
  -- bcrypt (bcryptjs, cost 12): the same format club-honbu's admin login checks
  -- (club_settings.admin_password_hash), so provisioning can copy it verbatim.
  -- The plain password is never stored or logged.
  password_hash  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','contacted','approved','provisioning',
                                   'trial_active','converted','expired','rejected')),
  source         TEXT NOT NULL DEFAULT 'get-started',
  ip_hash        TEXT,          -- salted SHA-256 of the client IP (rate limiting/abuse only)
  user_agent     TEXT,
  notified_at    TIMESTAMPTZ    -- when the notification email to Club Honbu was accepted by Resend
);
CREATE INDEX IF NOT EXISTS club_signups_created_at_idx ON club_signups (created_at DESC);
CREATE INDEX IF NOT EXISTS club_signups_email_idx ON club_signups (lower(email));
CREATE INDEX IF NOT EXISTS club_signups_status_idx ON club_signups (status);

-- Short-lived rate-limit log (rows older than 2 days are pruned automatically).
CREATE TABLE IF NOT EXISTS signup_attempts (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash    TEXT NOT NULL,
  email      TEXT
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip_idx ON signup_attempts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS signup_attempts_email_idx ON signup_attempts (lower(email), created_at);

-- ── Club Honbu HQ: approval → provisioning (worker/ polls provisioning_jobs) ─────────────────
-- Added columns are applied idempotently (checked first, so no lock when already present).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'club_signups' AND column_name = 'password_hash' AND is_nullable = 'NO') THEN
    -- The hash is cleared once the club's instance has it (data minimisation) or on rejection.
    ALTER TABLE club_signups ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'club_signups' AND column_name = 'slug') THEN
    ALTER TABLE club_signups
      ADD COLUMN slug            TEXT,          -- <slug>.clubhonbu.co.uk, chosen at approval
      ADD COLUMN decided_at      TIMESTAMPTZ,   -- approved/rejected at
      ADD COLUMN rejected_reason TEXT,
      ADD COLUMN instance_url    TEXT,          -- https://<slug>.clubhonbu.co.uk
      ADD COLUMN railway_url     TEXT,          -- https://<x>.up.railway.app (fallback)
      ADD COLUMN trial_ends_at   TIMESTAMPTZ,
      ADD COLUMN provisioned_at  TIMESTAMPTZ;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS club_signups_slug_key ON club_signups (slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signup_id    BIGINT NOT NULL REFERENCES club_signups(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'provision' CHECK (kind IN ('provision')),
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_until TIMESTAMPTZ,
  current_step TEXT,
  state        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- resource ids per step (resumable)
  last_error   TEXT,
  finished_at  TIMESTAMPTZ,
  UNIQUE (signup_id, kind)                          -- one job per sign-up: no duplicate instances
);
CREATE INDEX IF NOT EXISTS provisioning_jobs_ready_idx ON provisioning_jobs (status, run_after);

CREATE TABLE IF NOT EXISTS provisioning_events (     -- activity log shown in HQ
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  job_id     BIGINT REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
  signup_id  BIGINT REFERENCES club_signups(id) ON DELETE CASCADE,
  step       TEXT,
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provisioning_events_signup_idx ON provisioning_events (signup_id, created_at);

CREATE TABLE IF NOT EXISTS outbound_emails (          -- outbox; sent by the worker only when enabled
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  signup_id   BIGINT REFERENCES club_signups(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  body_html   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  provider_id TEXT,
  sent_at     TIMESTAMPTZ,
  UNIQUE (signup_id, kind)
);
`;

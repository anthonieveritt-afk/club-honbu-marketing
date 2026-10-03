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

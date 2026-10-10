# Stripe Billing (test mode) for Club Honbu trial clubs

Stacked on `feat/trial-lifecycle`. Nothing here touches production; live Stripe keys are refused unless `STRIPE_ALLOW_LIVE=1`.

## Flow
| where | what |
|---|---|
| reminder emails (2 days, 1 day), "trial ended" email | **Subscribe** button → `https://clubhonbu.co.uk/subscribe?t=<signed club token>` |
| club app banner + locked "trial ended" screen | same link, via the club's `TRIAL_UPGRADE_URL` (set per club at provisioning and by every `sync_trial`) — no club-honbu change needed |
| `/subscribe` | 3 plans (Starter £39, Club £79, Association £159 /mo — copied from clubhonbu.co.uk, placeholders); POST → `/api/billing/checkout` → Stripe Checkout, `mode=subscription`, `client_reference_id` + metadata `signup_id` |
| `/api/billing/webhook` | signature-checked; each event id applied once (`stripe_events`) |
| `checkout.session.completed` (paid) / `async_payment_succeeded` / `invoice.paid` | club → `converted`, `billing_status=active`; queued teardown cancelled; `sync_trial` removes `TRIAL_ENDS_AT` so a locked club unlocks; welcome email with **Manage billing** |
| `invoice.payment_failed` | `billing_status=past_due`, grace until now + `BILLING_GRACE_DAYS` (7); club keeps working; email with "Update payment details" (portal) |
| worker sweep, grace over and still unpaid / `customer.subscription.deleted` | club → `expired`, locked now, data kept `TRIAL_GRACE_DAYS`, then the normal teardown; "Subscribe again" email. Paying again before teardown revives it |
| `/api/billing/portal?t=…` | Stripe Customer Portal (card, invoices, plan change, cancel) |

Safety: clubs converted by hand (no Stripe subscription) are never lapsed by billing. A payment for a club that is already `removing`/`removed` is recorded and logged as an error for a manual refund/restore; a started teardown is never stopped automatically.

## Env
Site (`hq`): `STRIPE_SECRET_KEY` (restricted `rk_test_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `BILLING_TOKEN_SECRET` (32+ chars, **same value on the worker**), `BILLING_SITE_URL` (default `SITE_URL`), optional `STRIPE_PRICE_{STARTER,CLUB,ASSOCIATION}_{MONTHLY,ANNUAL}` (price ids; otherwise prices are looked up by lookup key `clubhonbu_<plan>_<monthly|annual>`), `BILLING_ANNUAL_ENABLED=1`, `STRIPE_AUTOMATIC_TAX=1`, `BILLING_GRACE_DAYS`.
Worker: `BILLING_TOKEN_SECRET`, `BILLING_SITE_URL`, `BILLING_GRACE_DAYS`.
Without `STRIPE_SECRET_KEY`: `/subscribe` shows the plans with "online payment isn't switched on yet, reply to any email"; checkout redirects back; webhook answers 503. Without `BILLING_TOKEN_SECRET`: emails/locked page keep the old "reply to upgrade" text.

## Stripe setup (test mode, Club Honbu's own Stripe account)
1. Products Starter / Club / Association, monthly GBP prices with lookup keys `clubhonbu_starter_monthly`, `clubhonbu_club_monthly`, `clubhonbu_association_monthly` (+ `_annual` if wanted).
2. Restricted key: Checkout Sessions **Write**, Customer portal **Write**, Prices **Read**, Products **Read**, Subscriptions **Read**, Customers **Write** (Checkout creates/updates them), Invoices **Read**; everything else None.
3. Webhook endpoint `https://<site>/api/billing/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`.
4. Customer portal: enable in Settings → Billing → Customer portal (payment methods, invoices, cancel; optionally plan switching between the three prices).

## Tests
`cd worker && npm test` (mocked Stripe + Railway, real local Postgres) and `scripts/test-billing.mjs` (HTTP routes on a local build, locally signed webhooks).

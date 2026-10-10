import "server-only";
import { getPool } from "@/lib/db";
import { ensureSchema } from "@/lib/signups";
// Shared with the worker (plain ESM, tested in worker/test/billing.test.js).
import * as core from "../worker/src/billing.js";

export const PLANS: { id: string; name: string; monthlyGbp: number; blurb: string; highlight?: boolean }[] = core.PLANS;

export function cfg() {
  return core.billingConfig(process.env);
}

/** Billing works only with a TEST key (live refused unless STRIPE_ALLOW_LIVE=1) and the link secret. */
export function billingReady(): boolean {
  const c = cfg();
  return core.usableStripe(c) && Boolean(c.tokenSecret) && Boolean(getPool());
}

export function stripe() {
  return core.createStripeClient({ secretKey: cfg().secretKey });
}

export async function db() {
  const pool = getPool();
  if (!pool) throw Object.assign(new Error("DATABASE_URL is not set"), { status: 503 });
  await ensureSchema();
  return pool;
}

export function signupFromToken(token: string | null | undefined): string | null {
  return core.verifyBillingToken(cfg().tokenSecret, String(token || ""));
}

export type Club = {
  id: string; club_name: string; contact_name: string; email: string; status: string; slug: string | null;
  instance_url: string | null; trial_ends_at: Date | null; teardown_after: Date | null; converted_at: Date | null;
  billing_status: string | null; billing_plan: string | null; billing_interval: string | null;
  stripe_customer_id: string | null; stripe_subscription_id: string | null; payment_grace_until: Date | null; current_period_end: Date | null;
};

export async function clubForToken(token: string | null | undefined): Promise<Club | null> {
  const id = signupFromToken(token);
  if (!id) return null;
  return core.getClub(await db(), id);
}

export const checkoutBlocker: (c: Club | null) => string | null = core.checkoutBlocker;
export const createCheckout = core.createCheckout;
export const createPortal = core.createPortal;
export const handleStripeEvent = core.handleStripeEvent;
export const verifyStripeSignature = core.verifyStripeSignature;

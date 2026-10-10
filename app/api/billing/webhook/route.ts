import { NextResponse } from "next/server";
import { cfg, db, handleStripeEvent, stripe, verifyStripeSignature } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Stripe -> POST /api/billing/webhook. Events: checkout.session.completed, checkout.session.async_payment_succeeded,
// invoice.paid, invoice.payment_failed, customer.subscription.deleted. Raw body is needed for the signature.
export async function POST(req: Request) {
  const c = cfg();
  if (!c.webhookSecret || !c.enabled) return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  const payload = await req.text();
  let event: any;
  try {
    event = verifyStripeSignature({ payload, header: req.headers.get("stripe-signature"), secret: c.webhookSecret });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Bad signature" }, { status: err?.status || 400 });
  }
  if (event.livemode && !c.allowLive) return NextResponse.json({ error: "Live events refused (test mode only)" }, { status: 400 });
  try {
    const outcome = await handleStripeEvent({ db: await db(), event, cfg: c, stripe: stripe() });
    return NextResponse.json({ received: true, outcome });
  } catch (err: any) {
    console.error("[billing] webhook failed:", event?.id, err?.message);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 }); // Stripe retries
  }
}

import { NextResponse } from "next/server";
import { billingReady, cfg, createPortal, db, signupFromToken, stripe } from "@/lib/billing";

export const dynamic = "force-dynamic";

// GET /api/billing/portal?t=<signed club token> -> Stripe Customer Portal (card, invoices, plan, cancel).
export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get("t") || "";
  const id = signupFromToken(t);
  if (!id) return NextResponse.json({ error: "Invalid link" }, { status: 400 });
  const back = (q: string) => NextResponse.redirect(new URL(`/subscribe?t=${encodeURIComponent(t)}&${q}`, cfg().siteUrl), 303);
  if (!billingReady()) return back("error=unavailable");
  try {
    return NextResponse.redirect(await createPortal({ db: await db(), stripe: stripe(), cfg: cfg(), signupId: id }), 303);
  } catch (err: any) {
    console.error("[billing] portal failed:", err?.message);
    return back("error=portal");
  }
}

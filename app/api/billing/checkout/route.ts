import { NextResponse } from "next/server";
import { billingReady, cfg, createCheckout, db, signupFromToken, stripe } from "@/lib/billing";

export const dynamic = "force-dynamic";

// POST (form from /subscribe): t=<signed club token>, plan, interval -> 303 to Stripe Checkout.
export async function POST(req: Request) {
  const form = await req.formData();
  const t = String(form.get("t") || "");
  const back = (q: string) => NextResponse.redirect(new URL(`/subscribe?t=${encodeURIComponent(t)}&${q}`, cfg().siteUrl), 303);
  if (!billingReady()) return back("error=unavailable");
  const id = signupFromToken(t);
  if (!id) return NextResponse.json({ error: "Invalid link" }, { status: 400 });
  try {
    const url = await createCheckout({
      db: await db(), stripe: stripe(), cfg: cfg(), signupId: id,
      plan: String(form.get("plan") || ""), interval: String(form.get("interval") || "month"),
    });
    return NextResponse.redirect(url, 303);
  } catch (err: any) {
    console.error("[billing] checkout failed:", err?.message);
    if (err?.message === "already_subscribed") return back("subscribed=1");
    return back(`error=${err?.status === 409 ? "blocked" : "checkout"}`);
  }
}

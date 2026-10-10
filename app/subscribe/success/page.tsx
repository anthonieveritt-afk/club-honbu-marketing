import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { clubForToken } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Thanks for subscribing · Club Honbu", robots: { index: false, follow: false } };

// Stripe sends people here after Checkout. The webhook (not this page) marks the club paid.
export default async function SuccessPage({ searchParams }: { searchParams: { t?: string } }) {
  let club = null;
  try { club = await clubForToken(searchParams.t); } catch { /* shown generically */ }
  const done = club?.status === "converted" && club?.billing_status === "active";
  return (
    <><Nav />
      <main className="max-w-xl mx-auto px-6 py-20 text-center" data-testid="subscribe-success">
        <h1 className="text-3xl font-semibold tracking-tight mb-3">Thank you{club ? `, ${club.club_name}` : ""}!</h1>
        <p className="text-muted mb-6">{done
          ? "Your subscription is active. The trial limits are gone and your club is safe."
          : "Your payment is being confirmed. This usually takes a few seconds; you'll get an email when it's done."}</p>
        {club?.instance_url && <a className="inline-block rounded-lg bg-ink text-canvas px-5 py-3 font-semibold" href={`${club.instance_url}/admin/login`}>Go to your club</a>}
      </main>
      <Footer /></>
  );
}

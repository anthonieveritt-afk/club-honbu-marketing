import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { PLANS, billingReady, cfg, checkoutBlocker, clubForToken, type Club } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Subscribe · Club Honbu", robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  unavailable: "Online payment isn't switched on yet. Reply to any Club Honbu email and we'll set up your subscription by hand.",
  checkout: "We couldn't open the payment page. Please try again, or reply to any Club Honbu email.",
  blocked: "This club can't be subscribed from here. Reply to any Club Honbu email and we'll sort it out.",
  portal: "We couldn't open billing management. Please try again shortly.",
};
const ukDate = (d: Date | string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });

function Shell({ children }: { children: React.ReactNode }) {
  return (<><Nav /><main className="max-w-5xl mx-auto px-6 py-16">{children}</main><Footer /></>);
}

function Status({ club, t }: { club: Club; t: string }) {
  const paying = club.stripe_subscription_id && ["active", "past_due"].includes(club.billing_status || "");
  if (paying) {
    return (
      <div data-testid="billing-active" className="rounded-2xl border border-line bg-white/60 p-8 text-center mb-10">
        <h2 className="text-xl font-semibold mb-2">{club.club_name} is subscribed{club.billing_plan ? ` (${club.billing_plan})` : ""}</h2>
        {club.billing_status === "past_due" && club.payment_grace_until && (
          <p className="text-red-700 mb-2">Your last payment failed. Please update your card by {ukDate(club.payment_grace_until)} to keep the club running.</p>
        )}
        <a href={`/api/billing/portal?t=${encodeURIComponent(t)}`} className="inline-block rounded-lg bg-ink text-canvas px-5 py-3 font-semibold">Manage billing</a>
      </div>
    );
  }
  const ends = club.trial_ends_at ? new Date(club.trial_ends_at) : null;
  return (
    <p className="text-muted text-center mb-10">
      {club.status === "expired"
        ? <>The trial for <strong>{club.club_name}</strong> has ended and the club is read-only.{club.teardown_after ? <> Subscribe before {ukDate(club.teardown_after)} to keep your data.</> : null}</>
        : <>Free trial for <strong>{club.club_name}</strong>{ends ? <> ends {ukDate(ends)}</> : null}. Subscribe to keep everything.</>}
    </p>
  );
}

export default async function SubscribePage({ searchParams }: { searchParams: { t?: string; error?: string; cancelled?: string; subscribed?: string } }) {
  const t = String(searchParams.t || "");
  let club: Club | null = null;
  try { club = await clubForToken(t); } catch (err) { console.error("[subscribe] lookup failed:", err); }
  if (!club) {
    return (<Shell><div data-testid="subscribe-invalid" className="text-center"><h1 className="text-3xl font-semibold mb-3">This link isn&apos;t valid</h1>
      <p className="text-muted">Use the Subscribe button in your Club Honbu email or on your club&apos;s page, or write to hello@clubhonbu.co.uk.</p></div></Shell>);
  }
  const ready = billingReady();
  const blocker = checkoutBlocker(club);
  const annual = cfg().annualEnabled;
  const err = searchParams.error ? ERRORS[searchParams.error] : !ready ? ERRORS.unavailable : null;
  return (
    <Shell>
      <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-center mb-3">Choose your Club Honbu plan</h1>
      <Status club={club} t={t} />
      {searchParams.cancelled && <p className="text-center text-muted mb-6">Payment cancelled. Nothing was charged.</p>}
      {err && <p data-testid="subscribe-error" className="text-center text-red-700 mb-6">{err}</p>}
      {blocker && blocker !== "already_subscribed" && <p data-testid="subscribe-blocked" className="text-center text-red-700 mb-6">{blocker}</p>}
      {!blocker && (
        <div className="grid md:grid-cols-3 gap-6">
          {PLANS.map((p) => (
            <form key={p.id} method="post" action="/api/billing/checkout" data-testid={`plan-${p.id}`}
              className={`rounded-2xl border p-8 flex flex-col ${p.highlight ? "border-ink bg-ink text-canvas" : "border-line bg-white/60"}`}>
              <input type="hidden" name="t" value={t} />
              <input type="hidden" name="plan" value={p.id} />
              <h2 className="text-xl font-semibold">{p.name}</h2>
              <p className="my-4"><span className="text-5xl font-semibold tracking-tight">£{p.monthlyGbp}</span><span className="opacity-60">/mo</span></p>
              <p className="opacity-70 mb-6 flex-1">{p.blurb}</p>
              {annual && (
                <select name="interval" className="mb-4 rounded-lg border border-line px-3 py-2 text-ink" defaultValue="month">
                  <option value="month">Monthly</option><option value="year">Yearly</option>
                </select>
              )}
              <button type="submit" disabled={!ready}
                className={`rounded-lg px-5 py-3 font-semibold disabled:opacity-40 ${p.highlight ? "bg-canvas text-ink" : "bg-ink text-canvas"}`}>
                Subscribe
              </button>
            </form>
          ))}
        </div>
      )}
      <p className="text-center text-xs text-muted mt-8">Secure payment by Stripe. Cancel any time from &quot;Manage billing&quot;.</p>
    </Shell>
  );
}

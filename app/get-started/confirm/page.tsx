import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { lookupConfirmToken } from "@/lib/signups";
import { confirmEmailAction } from "@/app/actions/confirm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm your email · Club Honbu", robots: { index: false, follow: false } };

const BUILDING = new Set(["approved", "provisioning", "trial_active"]);

function Card({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="rounded-2xl border border-line bg-white/60 px-8 py-12 md:px-10 text-center">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">{title}</h1>
      <div className="text-muted leading-relaxed max-w-sm mx-auto space-y-3">{children}</div>
    </div>
  );
}

const Contact = () => (
  <p className="text-sm">
    Need a hand? <a href="mailto:hello@clubhonbu.co.uk" className="text-accent underline-offset-2 hover:underline">hello@clubhonbu.co.uk</a>
  </p>
);

export default async function ConfirmPage({ searchParams }: { searchParams: { t?: string; r?: string } }) {
  const token = String(searchParams.t || "");
  let view: React.ReactNode;
  let found: Awaited<ReturnType<typeof lookupConfirmToken>> = { check: "invalid" };
  try {
    found = await lookupConfirmToken(token);
  } catch (err) {
    console.error("[confirm] lookup failed:", err);
  }
  const s = found.signup;

  if (found.check === "used" && s) {
    const building = BUILDING.has(s.status);
    view = (
      <Card testId="confirm-done" title="Email confirmed">
        <p>
          Thanks{s.contact_name ? `, ${s.contact_name}` : ""}. <strong className="text-ink">{s.club_name}</strong>{" "}
          {building
            ? "is being set up now. We'll email your login link as soon as it's ready (usually within 15 minutes). Your 7-day trial starts then."
            : "is confirmed. We'll be in touch shortly with your login details."}
        </p>
        <Contact />
      </Card>
    );
  } else if (found.check === "ok" && s) {
    view = (
      <Card testId="confirm-ready" title="Confirm your email">
        <p>
          One click and we'll start building <strong className="text-ink">{s.club_name}</strong> for your 7-day trial.
        </p>
        <form action={confirmEmailAction} className="pt-4">
          <input type="hidden" name="t" value={token} />
          <button type="submit" data-testid="confirm-button" className="rounded-full bg-ink text-white px-6 py-3 font-semibold hover:opacity-90">
            Confirm my email
          </button>
        </form>
        {searchParams.r === "error" && <p className="text-sm text-red-600">Something went wrong. Please try again.</p>}
      </Card>
    );
  } else if (found.check === "expired") {
    view = (
      <Card testId="confirm-expired" title="This link has expired">
        <p>For your security, confirmation links only work for a limited time. Please sign up again and use the new link.</p>
        <p><a href="/get-started" className="text-accent underline-offset-2 hover:underline">Sign up again</a></p>
        <Contact />
      </Card>
    );
  } else {
    view = (
      <Card testId="confirm-invalid" title="This link isn't valid">
        <p>Please use the most recent link from your email exactly as it was sent, or sign up again.</p>
        <p><a href="/get-started" className="text-accent underline-offset-2 hover:underline">Go to sign-up</a></p>
        <Contact />
      </Card>
    );
  }

  return (
    <>
      <Nav />
      <main>
        <section className="container-page pt-20 pb-32 md:pt-28 md:pb-40">
          <div className="max-w-lg mx-auto">{view}</div>
        </section>
      </main>
      <Footer />
    </>
  );
}

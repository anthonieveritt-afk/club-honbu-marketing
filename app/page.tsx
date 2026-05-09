import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { Accordion } from "@/components/Accordion";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        {/* HERO */}
        <section className="container-page pt-20 pb-24 md:pt-32 md:pb-36">
          <p className="text-sm text-accent font-medium tracking-wide mb-6">
            Built by instructors, for clubs.
          </p>
          <h1 className="text-5xl md:text-7xl lg:text-[5.5rem] font-semibold tracking-tight leading-[1.02] max-w-5xl">
            Run your club like the&nbsp;rest of your life depends on it.
          </h1>
          <p className="mt-8 text-xl md:text-2xl text-muted max-w-2xl leading-relaxed">
            Members, attendance, progression, and payments — in one place. Whether you run a dojo, a football squad, or anything in between, your evenings go back to coaching, not chasing spreadsheets.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-5">
            <a href="#pricing" className="btn-accent px-7 py-3.5 text-base">
              Start your 14-day free trial
            </a>
            <a href="#features" className="text-base text-ink/80 hover:text-ink underline-offset-4 hover:underline">
              See how it works →
            </a>
          </div>
          <p className="mt-8 text-sm text-muted">
            14-day free trial · No card required · Cancel anytime
          </p>
        </section>

        {/* PROBLEM */}
        <section className="border-y border-line bg-black/[0.02]">
          <div className="container-page py-24 md:py-32">
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight">
              You didn't start a club to&nbsp;become an admin.
            </h2>
            <p className="mt-8 text-lg md:text-xl text-muted max-w-2xl leading-relaxed">
              But here you are. Tracking gradings, squad lists, or attendance on a clipboard. Chasing standing orders. Squinting at a spreadsheet that breaks every time someone moves up a belt or changes age group. The owner-operator trap is real — and it's eating the hours you should be on the mat or the pitch.
            </p>
          </div>
        </section>

        {/* FEATURES */}
        <section id="features" className="container-page py-24 md:py-32">
          <p className="text-sm text-accent font-medium tracking-wide mb-4">Features</p>
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight">
            Everything a club needs. Nothing it doesn't.
          </h2>
          <div className="mt-16 grid md:grid-cols-3 gap-12 md:gap-10">
            {[
              {
                icon: (
                  <path d="M3 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
                ),
                title: "Members & progression",
                body: "Track every member's journey — belts, age groups, attendance, syllabus or training progress. From sign-up to senior, the record is yours forever.",
              },
              {
                icon: (
                  <path d="M3 7h18M3 12h18M3 17h12M19 17h2" />
                ),
                title: "Payments & billing",
                body: "Recurring monthly fees, one-off course payments, grading or kit fees. Auto-charged, reconciled, and chased for you. No more awkward conversations.",
              },
              {
                icon: (
                  <path d="M3 3v18h18M7 14l4-4 4 4 5-7" />
                ),
                title: "Insights",
                body: "See at a glance which members are slipping in attendance — and reach out before they quietly drop off the books.",
              },
            ].map((f, i) => (
              <div key={i}>
                <div className="w-12 h-12 rounded-2xl bg-ink text-canvas flex items-center justify-center mb-6">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    {f.icon}
                  </svg>
                </div>
                <h3 className="text-xl md:text-2xl font-semibold tracking-tight mb-3">{f.title}</h3>
                <p className="text-muted leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* INSTRUCTOR STORY */}
        <section className="border-y border-line bg-black/[0.02]">
          <div className="container-page py-24 md:py-32">
            <div className="max-w-3xl">
              <p className="text-sm text-accent font-medium tracking-wide mb-6">A note from the founders</p>
              <blockquote className="text-2xl md:text-3xl font-medium tracking-tight leading-snug">
                "We built Club Honbu because we needed it. We run a karate club, and every Sunday night we'd sit at the kitchen table sorting payment receipts and pencilling in grading dates on a printed register. The software out there was either built for big-box gyms or felt like a hobby project. So we made the thing we wished existed — first for our dojo, then for the football coach down the road, and now for any club that teaches."
              </blockquote>
              <p className="mt-8 text-muted">
                — Anthoni & Jade, founders of Club Honbu
              </p>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section id="pricing" className="container-page py-24 md:py-32">
          <p className="text-sm text-accent font-medium tracking-wide mb-4">Pricing</p>
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight">
            Simple pricing. Same trial for everyone.
          </h2>
          <p className="mt-6 text-lg text-muted max-w-xl">
            14 days free. No card required. Pick a plan when (and if) you're ready.
          </p>

          <div className="mt-14 grid md:grid-cols-3 gap-6">
            {[
              {
                name: "Starter",
                price: "£39",
                blurb: "For a single coach or instructor running one group or a small club.",
                bullets: ["Up to 50 active members", "Single instructor account", "Recurring & one-off payments", "Attendance tracking"],
                cta: "Start free trial",
                highlight: false,
              },
              {
                name: "Club",
                price: "£79",
                blurb: "For most clubs. Multiple coaches, full progression workflow, reporting.",
                bullets: ["Up to 250 active members", "Multiple coaches & instructors", "Gradings, squads & progression history", "Reports & member insights", "Email reminders & invoices"],
                cta: "Start free trial",
                highlight: true,
              },
              {
                name: "Association",
                price: "£159",
                blurb: "For multi-club associations and federations running several sites.",
                bullets: ["Unlimited members", "Multi-club / multi-site", "White-label branding", "Priority support", "Custom reporting", "Onboarding session"],
                cta: "Start free trial",
                highlight: false,
              },
            ].map((tier) => (
              <div
                key={tier.name}
                className={`rounded-3xl p-8 flex flex-col ${
                  tier.highlight
                    ? "bg-ink text-canvas ring-1 ring-ink shadow-xl shadow-black/10"
                    : "bg-white/60 border border-line"
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold tracking-tight">{tier.name}</h3>
                  {tier.highlight && (
                    <span className="text-xs font-medium uppercase tracking-wider px-2.5 py-1 rounded-full bg-accent text-white">
                      Most popular
                    </span>
                  )}
                </div>
                <div className="mt-6 flex items-baseline gap-1">
                  <span className="text-5xl font-semibold tracking-tight">{tier.price}</span>
                  <span className={`text-base ${tier.highlight ? "text-canvas/60" : "text-muted"}`}>/mo</span>
                </div>
                <p className={`mt-4 text-sm leading-relaxed ${tier.highlight ? "text-canvas/75" : "text-muted"}`}>
                  {tier.blurb}
                </p>
                <ul className="mt-8 space-y-3 text-sm">
                  {tier.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="mt-0.5 flex-shrink-0">
                        <path
                          d="M5 12.5l4.5 4.5L19 7"
                          stroke={tier.highlight ? "#FAF7F2" : "#0066cc"}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="mailto:hello@clubhonbu.co.uk?subject=Club%20Honbu%20trial"
                  className={`mt-8 btn-pill text-sm ${
                    tier.highlight
                      ? "bg-canvas text-ink hover:bg-white"
                      : "bg-ink text-white hover:bg-black/85"
                  }`}
                >
                  {tier.cta}
                </a>
                <p className={`mt-3 text-xs ${tier.highlight ? "text-canvas/55" : "text-muted"}`}>
                  14-day free trial · No card required
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="container-page py-24 md:py-32">
          <p className="text-sm text-accent font-medium tracking-wide mb-4">FAQ</p>
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight mb-12">
            Questions, answered.
          </h2>
          <Accordion
            items={[
              {
                q: "What kinds of clubs is it for?",
                a: "Club Honbu works for martial arts (karate, BJJ, MMA, boxing, kickboxing, judo, taekwondo) and general sports clubs (football, netball, rugby, dance, gymnastics). If you teach in groups, track progression, and bill members, it'll fit. You pick your club type at setup and the labels follow — belts and gradings for martial arts, squads and matches for sport.",
              },
              {
                q: "Do I need to be technical to set this up?",
                a: "No. If you can use email and a spreadsheet, you can run Club Honbu. Setup takes about 20 minutes — pick your club type, add your groups, import your members, and you're live.",
              },
              {
                q: "Can I migrate from spreadsheets?",
                a: "Yes. Drop in a CSV of your existing members and we'll map the columns for you. On the Association plan we'll do the import for you on a 1:1 onboarding call.",
              },
              {
                q: "What payment processors do you support?",
                a: "Stripe and GoCardless out of the box — covering card payments and Direct Debit for recurring fees. More processors coming based on what clubs ask for.",
              },
              {
                q: "Is there a contract / can I cancel?",
                a: "No contract. Monthly billing, cancel any time from your account. Your data is yours — export it as CSV whenever you want.",
              },
              {
                q: "Is my data secure / GDPR-compliant?",
                a: "Yes. Data is hosted in the UK/EU, encrypted at rest and in transit. We're built GDPR-first — clear consent, data export, and the right to erasure are baked in.",
              },
            ]}
          />
        </section>

        {/* FINAL CTA */}
        <section className="container-page py-24 md:py-32">
          <div className="rounded-[2rem] bg-ink text-canvas px-8 md:px-16 py-20 md:py-28 text-center">
            <h2 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-3xl mx-auto">
              Get your evenings back.
            </h2>
            <p className="mt-6 text-lg md:text-xl text-canvas/70 max-w-xl mx-auto">
              Try Club Honbu free for 14 days. No card. No commitment. Just your club — dojo, pitch or otherwise — finally on rails.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-5">
              <a
                href="mailto:hello@clubhonbu.co.uk?subject=Club%20Honbu%20trial"
                className="btn-pill bg-accent text-white hover:bg-accent/90 px-7 py-3.5 text-base"
              >
                Start your 14-day free trial
              </a>
              <a
                href="mailto:hello@clubhonbu.co.uk"
                className="text-base text-canvas/80 hover:text-canvas underline-offset-4 hover:underline"
              >
                Email us →
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

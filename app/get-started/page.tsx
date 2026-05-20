"use client";

import { useState, useTransition } from "react";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { submitSignup, type SignupState } from "@/app/actions/signup";

const SPORT_OPTIONS = [
  "Martial Arts",
  "Football",
  "Netball",
  "Rugby",
  "Dance",
  "Gymnastics",
  "General",
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1.5 text-sm text-red-500">{message}</p>
  );
}

export default function GetStartedPage() {
  const [state, setState] = useState<SignupState>({ status: "idle" });
  const [isPending, startTransition] = useTransition();

  const [form, setForm] = useState({
    clubName: "",
    sportType: "",
    contactName: "",
    email: "",
    website: "",
    adminUsername: "",
    password: "",
    confirmPassword: "",
  });

  const fieldErrors =
    state.status === "error" && state.fieldErrors ? state.fieldErrors : {};

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await submitSignup(form);
      setState(result);
      if (result.status === "success") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  return (
    <>
      <Nav />
      <main>
        <section className="container-page pt-20 pb-32 md:pt-28 md:pb-40">
          {/* Hero */}
          <div className="text-center max-w-2xl mx-auto mb-14">
            <p className="text-sm text-accent font-medium tracking-wide mb-5">
              Free 14-day trial · No card required
            </p>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.05]">
              Get started with Club&nbsp;Honbu
            </h1>
            <p className="mt-5 text-lg md:text-xl text-muted max-w-lg mx-auto leading-relaxed">
              Tell us about your club and we'll have your account ready within 24 hours.
            </p>
          </div>

          {/* Card */}
          <div className="max-w-lg mx-auto">
            {state.status === "success" ? (
              <SuccessCard clubName={state.clubName} />
            ) : (
              <div className="rounded-2xl border border-line bg-white/60 px-8 py-10 md:px-10">
                <form onSubmit={handleSubmit} noValidate className="space-y-6">
                  {/* Global error */}
                  {state.status === "error" && !Object.keys(fieldErrors).length && (
                    <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                      Something went wrong — please email{" "}
                      <a
                        href="mailto:hello@clubhonbu.co.uk"
                        className="underline underline-offset-2"
                      >
                        hello@clubhonbu.co.uk
                      </a>
                    </div>
                  )}

                  {/* Club Name */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="clubName">
                      Club Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="clubName"
                      name="clubName"
                      type="text"
                      autoComplete="organization"
                      required
                      value={form.clubName}
                      onChange={handleChange}
                      placeholder="e.g. Shotokan Karate Club"
                      className={inputClass(!!fieldErrors.clubName)}
                    />
                    <FieldError message={fieldErrors.clubName} />
                  </div>

                  {/* Sport Type */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="sportType">
                      Sport Type <span className="text-red-500">*</span>
                    </label>
                    <select
                      id="sportType"
                      name="sportType"
                      required
                      value={form.sportType}
                      onChange={handleChange}
                      className={selectClass(!!fieldErrors.sportType)}
                    >
                      <option value="" disabled>Select a sport type…</option>
                      {SPORT_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    <FieldError message={fieldErrors.sportType} />
                  </div>

                  {/* Contact Name */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="contactName">
                      Your Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="contactName"
                      name="contactName"
                      type="text"
                      autoComplete="name"
                      required
                      value={form.contactName}
                      onChange={handleChange}
                      placeholder="e.g. Alex Johnson"
                      className={inputClass(!!fieldErrors.contactName)}
                    />
                    <FieldError message={fieldErrors.contactName} />
                  </div>

                  {/* Email */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="email">
                      Email Address <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={form.email}
                      onChange={handleChange}
                      placeholder="you@yourclub.com"
                      className={inputClass(!!fieldErrors.email)}
                    />
                    <FieldError message={fieldErrors.email} />
                  </div>

                  {/* Club Website */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="website">
                      Club Website{" "}
                      <span className="text-muted font-normal">(optional)</span>
                    </label>
                    <input
                      id="website"
                      name="website"
                      type="url"
                      autoComplete="url"
                      value={form.website}
                      onChange={handleChange}
                      placeholder="https://yourclub.com"
                      className={inputClass(false)}
                    />
                  </div>

                  {/* Admin Username */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="adminUsername">
                      Preferred Admin Username <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="adminUsername"
                      name="adminUsername"
                      type="text"
                      autoComplete="username"
                      required
                      value={form.adminUsername}
                      onChange={handleChange}
                      placeholder="e.g. coach_alex"
                      className={inputClass(!!fieldErrors.adminUsername)}
                    />
                    <FieldError message={fieldErrors.adminUsername} />
                    <p className="mt-1.5 text-sm text-muted">
                      You'll use this to log in to your dashboard.
                    </p>
                  </div>

                  {/* Password */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="password">
                      Password <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={form.password}
                      onChange={handleChange}
                      placeholder="Minimum 8 characters"
                      className={inputClass(!!fieldErrors.password)}
                    />
                    <FieldError message={fieldErrors.password} />
                  </div>

                  {/* Confirm Password */}
                  <div>
                    <label className="block text-sm font-medium text-ink mb-1.5" htmlFor="confirmPassword">
                      Confirm Password <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="confirmPassword"
                      name="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      value={form.confirmPassword}
                      onChange={handleChange}
                      placeholder="Repeat your password"
                      className={inputClass(!!fieldErrors.confirmPassword)}
                    />
                    <FieldError message={fieldErrors.confirmPassword} />
                  </div>

                  {/* Submit */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={isPending}
                      className="w-full btn-accent px-6 py-3.5 text-base disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isPending ? "Submitting…" : "Create my account →"}
                    </button>
                    <p className="mt-3 text-center text-sm text-muted">
                      14-day free trial · No card required · Cancel anytime
                    </p>
                  </div>
                </form>
              </div>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

function SuccessCard({ clubName }: { clubName: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white/60 px-8 py-12 md:px-10 text-center">
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-green-50 border border-green-200">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          className="text-green-600"
        >
          <path
            d="M5 12.5l4.5 4.5L19 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="text-2xl md:text-3xl font-semibold tracking-tight mb-3">
        You're on the list!
      </h2>
      <p className="text-muted leading-relaxed max-w-sm mx-auto">
        We're setting up{" "}
        <strong className="text-ink">{clubName}</strong>'s account. Check your inbox — you'll hear from us within 24 hours.
      </p>
      <div className="mt-8 pt-6 border-t border-line">
        <p className="text-sm text-muted">
          Questions in the meantime?{" "}
          <a
            href="mailto:hello@clubhonbu.co.uk"
            className="text-accent underline-offset-2 hover:underline"
          >
            hello@clubhonbu.co.uk
          </a>
        </p>
      </div>
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return [
    "w-full rounded-xl border px-4 py-3 text-sm text-ink bg-white",
    "placeholder:text-muted/60",
    "outline-none transition-all duration-150",
    "focus:ring-2 focus:ring-accent/30 focus:border-accent",
    hasError
      ? "border-red-400 focus:ring-red-300/30 focus:border-red-400"
      : "border-line hover:border-ink/25",
  ].join(" ");
}

function selectClass(hasError: boolean): string {
  return [
    "w-full rounded-xl border px-4 py-3 text-sm text-ink bg-white",
    "outline-none transition-all duration-150 appearance-none",
    "focus:ring-2 focus:ring-accent/30 focus:border-accent",
    "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235C5C5C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")] bg-no-repeat bg-[right_12px_center]",
    hasError
      ? "border-red-400 focus:ring-red-300/30 focus:border-red-400"
      : "border-line hover:border-ink/25",
  ].join(" ");
}

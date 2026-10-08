import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { listSignups, autoApproveEnabled, type SignupRow } from "@/lib/signups";
import { suggestSlug } from "@/lib/slug";
import { approveAction, rejectAction, retryAction, extendAction, convertAction, deleteNowAction } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Sign-ups · Club Honbu admin",
  robots: { index: false, follow: false },
};

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "short",
});

const BASE_DOMAIN = process.env.BASE_DOMAIN || "clubhonbu.co.uk";
// Display only; the worker's TRIAL_DAYS / TRIAL_GRACE_DAYS are what count. Keep them in step.
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7);
const GRACE_DAYS = Number(process.env.TRIAL_GRACE_DAYS || 7);

const btn = "rounded-lg px-3 py-1.5 text-xs font-medium";

function Provisioning({ r }: { r: SignupRow }) {
  if (r.instance_url) {
    const gone = r.status === "removed";
    return (
      <div className="space-y-1">
        {gone ? (
          <span className="font-mono text-xs text-muted line-through" data-testid="instance-url">{r.instance_url.replace(/^https?:\/\//, "")}</span>
        ) : (
          <a className="text-accent hover:underline" href={r.instance_url} target="_blank" rel="noopener noreferrer" data-testid="instance-url">
            {r.instance_url.replace(/^https?:\/\//, "")}
          </a>
        )}
        <Lifecycle r={r} />
      </div>
    );
  }
  if (!r.job_status) return <span className="text-muted">—</span>;
  return (
    <div className="space-y-1" data-testid="job">
      <div>
        job <span className="font-medium">{r.job_status}</span>
        {r.job_step ? ` · ${r.job_step}` : ""}
        {r.job_attempts ? ` · attempt ${r.job_attempts}` : ""}
      </div>
      {r.slug && <div className="font-mono text-xs text-muted">{r.slug}.{BASE_DOMAIN}</div>}
      {r.job_error && <div className="max-w-xs break-words text-xs text-red-700">{r.job_error}</div>}
      {r.auto_approved && <div className="text-xs text-muted">auto-approved</div>}
    </div>
  );
}

function Lifecycle({ r }: { r: SignupRow }) {
  const d = (v: Date | null) => (v ? fmt.format(new Date(v)) : "");
  return (
    <div className="space-y-0.5 text-xs text-muted" data-testid="lifecycle">
      {r.status === "trial_active" && r.trial_ends_at && <div>Trial ends {d(r.trial_ends_at)}</div>}
      {r.status === "expired" && <div className="text-amber-700">Expired {d(r.expired_at)} · deleted after {d(r.teardown_after)}</div>}
      {r.status === "converted" && <div className="text-emerald-700">Converted {d(r.converted_at)} · never removed automatically</div>}
      {r.status === "removing" && (
        <div className="text-red-700">
          Removing (requested {d(r.removal_requested_at)}) · teardown {r.teardown_status || "pending"}{r.teardown_step ? ` · ${r.teardown_step}` : ""}
        </div>
      )}
      {r.status === "removed" && <div>Removed {d(r.removed_at)}</div>}
      {r.trial_extended_days > 0 && <div>Extended by {r.trial_extended_days} day(s) in total</div>}
      {r.auto_approved && <div>auto-approved</div>}
      {r.sync_status && r.sync_status !== "succeeded" && r.sync_status !== "cancelled" && <div>Instance update: {r.sync_status}</div>}
      {r.teardown_error && r.teardown_status === "failed" && <div className="max-w-xs break-words text-red-700">{r.teardown_error}</div>}
      {r.sync_error && r.sync_status === "failed" && <div className="max-w-xs break-words text-red-700">{r.sync_error}</div>}
      {r.last_event && (
        <div className={`max-w-xs break-words ${r.last_event_level === "error" ? "text-red-700" : r.last_event_level === "warn" ? "text-amber-700" : ""}`} data-testid="last-event">
          Last: {r.last_event}
        </div>
      )}
    </div>
  );
}

function Actions({ r }: { r: SignupRow }) {
  const canDecide = r.status === "new" || r.status === "contacted";
  const canReject = canDecide || (r.status === "approved" && (r.job_status === "queued" || !r.job_status));
  // Extend/convert can still stop a removal that hasn't started a single step yet.
  const teardownPending = r.status === "removing" && !r.teardown_step && (!r.teardown_status || r.teardown_status === "queued" || r.teardown_status === "cancelled");
  const canExtend = r.status === "trial_active" || r.status === "expired" || teardownPending;
  const canConvert = canExtend;
  const canDelete = r.status === "trial_active" || r.status === "expired" || (r.status === "provisioning" && r.job_status === "failed");
  return (
    <div className="flex min-w-[16rem] flex-col gap-2">
      {canDecide && (
        <form action={approveAction} className="flex items-center gap-1" data-testid="approve-form">
          <input type="hidden" name="id" value={r.id} />
          <input
            name="slug"
            defaultValue={suggestSlug(r.club_name)}
            required
            pattern="[a-z0-9][a-z0-9\-]{1,28}[a-z0-9]"
            title="3–30 characters: a–z, 0–9 and hyphens"
            aria-label="Subdomain"
            className="w-36 rounded-lg border border-line px-2 py-1 font-mono text-xs"
          />
          <span className="text-xs text-muted">.{BASE_DOMAIN}</span>
          <button type="submit" className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Approve</button>
        </form>
      )}
      {canReject && (
        <form action={rejectAction} className="flex items-center gap-1" data-testid="reject-form">
          <input type="hidden" name="id" value={r.id} />
          <input name="reason" placeholder="Reason (internal)" maxLength={500} aria-label="Reject reason"
            className="w-36 rounded-lg border border-line px-2 py-1 text-xs" />
          <button type="submit" className={`${btn} border border-red-300 text-red-700 hover:bg-red-50`}>Reject</button>
        </form>
      )}
      {r.job_status === "failed" && (
        <form action={retryAction} data-testid="retry-form">
          <input type="hidden" name="id" value={r.id} />
          <button type="submit" className={`${btn} border border-line hover:bg-black/5`}>Retry provisioning</button>
        </form>
      )}
      {canExtend && (
        <form action={extendAction} className="flex items-center gap-1" data-testid="extend-form">
          <input type="hidden" name="id" value={r.id} />
          <input name="days" type="number" min={1} max={60} defaultValue={7} required aria-label="Days to extend"
            className="w-16 rounded-lg border border-line px-2 py-1 text-xs" />
          <span className="text-xs text-muted">days</span>
          <button type="submit" className={`${btn} border border-line hover:bg-black/5`}>Extend trial</button>
        </form>
      )}
      {canConvert && (
        <form action={convertAction} data-testid="convert-form">
          <input type="hidden" name="id" value={r.id} />
          <button type="submit" className={`${btn} bg-emerald-600 text-white hover:bg-emerald-700`}>Mark converted</button>
        </form>
      )}
      {canDelete && r.slug && (
        <form action={deleteNowAction} className="flex items-center gap-1" data-testid="delete-form">
          <input type="hidden" name="id" value={r.id} />
          <input name="confirm" placeholder={`type ${r.slug}`} aria-label="Type the subdomain to confirm" autoComplete="off"
            className="w-36 rounded-lg border border-line px-2 py-1 font-mono text-xs" />
          <button type="submit" className={`${btn} border border-red-300 text-red-700 hover:bg-red-50`}>Delete now</button>
        </form>
      )}
      {r.teardown_status === "failed" && (
        <form action={retryAction} data-testid="retry-teardown-form">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="kind" value="teardown" />
          <button type="submit" className={`${btn} border border-line hover:bg-black/5`}>Retry removal</button>
        </form>
      )}
      {r.sync_status === "failed" && (
        <form action={retryAction} data-testid="retry-sync-form">
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="kind" value="sync_trial" />
          <button type="submit" className={`${btn} border border-line hover:bg-black/5`}>Retry instance update</button>
        </form>
      )}
      {r.status === "rejected" && r.rejected_reason && <span className="text-xs text-muted">{r.rejected_reason}</span>}
    </div>
  );
}

export default async function AdminSignupsPage({
  searchParams,
}: {
  searchParams?: { ok?: string; err?: string };
}) {
  // Defence in depth: middleware already enforces this.
  if (!isAdminAuthorized(headers().get("authorization"))) notFound();

  let rows: Awaited<ReturnType<typeof listSignups>> = [];
  let error: string | null = null;
  try {
    rows = await listSignups();
  } catch (err) {
    console.error("[admin/signups] query failed:", err);
    error = "Could not load sign-ups (database unavailable or DATABASE_URL not set).";
  }

  return (
    <main className="mx-auto w-full max-w-[110rem] px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Club sign-ups</h1>
      <p className="mt-2 text-sm text-muted">
        Newest first · {rows.length} shown · times are UK time. Passwords are stored only as
        bcrypt hashes and are never shown.
      </p>
      {searchParams?.ok && (
        <p className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" data-testid="flash-ok">
          {searchParams.ok}
        </p>
      )}
      {searchParams?.err && (
        <p className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" data-testid="flash-err">
          {searchParams.err}
        </p>
      )}
      <p className="mt-2 text-sm text-muted">
        Approve queues a provisioning job; the HQ worker picks it up and builds the club&apos;s trial
        instance (nothing is created from this website directly).
        {autoApproveEnabled() ? " Auto-approve is ON: new sign-ups are approved with a subdomain from the club name." : ""}
        {" "}Trials last {TRIAL_DAYS} days, then the club is read-only for {GRACE_DAYS} days and deleted unless it is
        extended or marked converted.
      </p>
      {error && (
        <p className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {!error && rows.length === 0 && <p className="mt-8 text-muted">No sign-ups yet.</p>}
      {rows.length > 0 && (
        <div className="mt-8 overflow-x-auto rounded-2xl border border-line bg-white/60">
          <table className="w-full text-left text-sm" data-testid="signups-table">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">#</th>
                <th className="px-4 py-3 font-medium">Received</th>
                <th className="px-4 py-3 font-medium">Club</th>
                <th className="px-4 py-3 font-medium">Sport</th>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Website</th>
                <th className="px-4 py-3 font-medium">Admin username</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Emailed</th>
                <th className="px-4 py-3 font-medium">Trial instance</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 align-top" data-signup-id={r.id}>
                  <td className="px-4 py-3 text-muted">{r.id}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmt.format(new Date(r.created_at))}</td>
                  <td className="px-4 py-3 font-medium">{r.club_name}</td>
                  <td className="px-4 py-3">{r.sport_type}</td>
                  <td className="px-4 py-3">{r.contact_name}</td>
                  <td className="px-4 py-3">
                    <a className="text-accent hover:underline" href={`mailto:${r.email}`}>
                      {r.email}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    {r.website ? (
                      <a
                        className="text-accent hover:underline"
                        href={/^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`}
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                      >
                        {r.website}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{r.admin_username}</td>
                  <td className="px-4 py-3" data-testid="status">{r.status}</td>
                  <td className="px-4 py-3">{r.notified_at ? "yes" : "no"}</td>
                  <td className="px-4 py-3"><Provisioning r={r} /></td>
                  <td className="px-4 py-3"><Actions r={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

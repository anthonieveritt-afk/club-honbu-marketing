import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isAdminAuthorized } from "@/lib/admin-auth";
import { listSignups } from "@/lib/signups";

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

export default async function AdminSignupsPage() {
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
    <main className="container-page py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Club sign-ups</h1>
      <p className="mt-2 text-sm text-muted">
        Newest first · {rows.length} shown · times are UK time. Passwords are stored only as
        bcrypt hashes and are never shown.
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
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 align-top">
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
                  <td className="px-4 py-3">{r.status}</td>
                  <td className="px-4 py-3">{r.notified_at ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

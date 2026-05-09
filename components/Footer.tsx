import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Footer() {
  return (
    <footer className="border-t border-line mt-24">
      <div className="container-page py-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Wordmark />
          <p className="text-sm text-muted">© 2026 Club Honbu. All rights reserved.</p>
        </div>
        <div className="flex items-center gap-6 text-sm text-muted">
          <Link href="/privacy" className="hover:text-ink">Privacy</Link>
          <Link href="/terms" className="hover:text-ink">Terms</Link>
          <a href="mailto:hello@clubhonbu.co.uk" className="hover:text-ink">hello@clubhonbu.co.uk</a>
        </div>
      </div>
    </footer>
  );
}

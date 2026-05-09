import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Nav() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-canvas/80 border-b border-line/60">
      <div className="container-page flex items-center justify-between h-16">
        <Link href="/" className="flex items-center">
          <Wordmark />
        </Link>
        <nav className="hidden md:flex items-center gap-8 text-sm text-ink/80">
          <a href="#features" className="hover:text-ink transition-colors">Features</a>
          <a href="#pricing" className="hover:text-ink transition-colors">Pricing</a>
          <a href="#faq" className="hover:text-ink transition-colors">FAQ</a>
        </nav>
        <a href="#pricing" className="btn-primary text-sm px-5 py-2.5">
          Start free trial
        </a>
      </div>
    </header>
  );
}

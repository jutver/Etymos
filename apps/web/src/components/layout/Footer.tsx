import { Link } from "react-router-dom";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="editorial-footer border-t border-navy-700/60 bg-navy-900 text-white/70">
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-16 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo variant="light" /><p className="footer-statement">Thoughtful writing.<br /><em>Original by you.</em></p>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/55">
            Vietnamese-first plagiarism detection, built to be affordable for every student and
            researcher.
          </p>
          <a
            href="mailto:hello@etymos.vn"
            aria-label="Email Etymos support"
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-white/70 hover:text-white"
          >
            <EnvelopeSimple size={16} />
            hello@etymos.vn
          </a>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/40">Product</p>
          <ul className="mt-4 space-y-3 text-sm">
            <li>
              <Link to="/#features" className="hover:text-white">
                Features
              </Link>
            </li>
            <li>
              <Link to="/#how-it-works" className="hover:text-white">
                How it works
              </Link>
            </li>
            <li>
              <Link to="/pricing" className="hover:text-white">
                Pricing
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-white/40">Get started</p>
          <ul className="mt-4 space-y-3 text-sm">
            <li>
              <Link to="/upload" className="hover:text-white">
                Check a document
              </Link>
            </li>
            <li>
              <Link to="/history" className="hover:text-white">
                My history
              </Link>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col-reverse items-center gap-3 px-5 py-6 text-xs text-white/40 sm:flex-row sm:justify-between sm:px-8">
          <p>© 2026 Etymos. Made for Vietnamese students and researchers.</p>
          <p>Prices shown in VND</p>
        </div>
      </div>
    </footer>
  );
}

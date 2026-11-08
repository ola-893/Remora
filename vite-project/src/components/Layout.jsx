import { useEffect, useRef } from "react";
import { Outlet, useLocation, Link } from "react-router-dom";
import Header from "./Header";
import { ErrorBoundary } from "./ui";

export default function Layout() {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    const heading = document.querySelector("main h1")?.textContent;
    document.title = heading
      ? `${heading} · agentStreams`
      : "agentStreams — Deterministic payment guardrails";
    if (previous.current !== pathname) {
      window.scrollTo({ top: 0, behavior: "instant" });
      document.getElementById("main-content")?.focus({ preventScroll: true });
      previous.current = pathname;
    }
  }, [pathname]);
  return (
    <div className="min-h-screen">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main id="main-content" tabIndex={-1} className="app-main">
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      {pathname !== "/" && (
        <footer className="app-footer mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pt-8 text-xs text-slate-400 sm:px-6 lg:px-8">
          <p>
            agentStreams · NEAR · Testnet tokens have no monetary value.
          </p>
          <Link
            to="/docs"
            className="min-h-11 inline-flex items-center text-slate-300 hover:text-white"
          >
            Workflow & trust boundaries ↗
          </Link>
        </footer>
      )}
    </div>
  );
}

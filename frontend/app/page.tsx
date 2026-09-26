"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import DashboardSkeleton from "@/components/DashboardSkeleton";
import LandingHero from "@/components/LandingHero";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Length of the "Lens Dive" lightning handoff in milliseconds. Must match the
 * `lens-dive-lightning` and `dashboard-snap` animations in globals.css.
 */
const LENS_DIVE_MS = 550;

/**
 * When the dashboard's entrance is considered settled. Must stay past the
 * `dashboard-snap` 650 ms animation: at this point the shell releases its
 * compositor layer (.is-settled) and re-enables the static glass blur, so the
 * unfreeze is one recalc after motion instead of continuous work during it.
 */
const DASHBOARD_SETTLE_MS = 700;

/**
 * Single loader instance, deliberately shared.
 *
 * `dynamic()` and the preload hint must reference the *same* import specifier
 * so the bundler hands back one module record. Preloading a second, textually
 * different import would download the chunk twice and warm nothing.
 */
const loadNexusDashboard = () => import("@/components/NexusDashboard");

/**
 * The NEXUS console is code-split because it drags in React Flow — ~176 KB of
 * the previous initial payload — and a visitor who never presses ENTER
 * EXPERIENCE should not pay for it. Splitting it also lets the landing page
 * hydrate and paint on its own, with no third-party graph library in the
 * critical path.
 *
 * `ssr: false` is correct here: the console is a client-only interactive
 * canvas that opens a WebSocket on mount, so there is nothing meaningful to
 * server-render and prerendering it would only ship markup that is immediately
 * discarded.
 */
const NexusDashboard = dynamic(loadNexusDashboard, {
  ssr: false,
  loading: () => <DashboardSkeleton />,
});

/**
 * App shell.
 *
 * "ENTER EXPERIENCE" starts a lightning-strike handoff, staged across frames
 * so the animation never competes with heavy work on the click tick:
 *
 *   tick 0 — flip `isEntering`. This is a class change on an already-layered
 *     landing shell, so the Lens Dive (transform + opacity only) starts
 *     compositing on the very next frame with nothing else queued.
 *   frame ~2 — mount the dashboard shell underneath. Its WebSocket starts
 *     connecting while the strike plays, but the React Flow canvas itself
 *     stays deferred one more beat inside NexusDashboard, so the graph's
 *     measure/layout pass cannot steal the animation's frames either.
 *   550 ms — the landing unmounts so no off-screen layer keeps painting.
 *   700 ms — the entrance is settled: the dashboard releases its compositor
 *     layer and re-enables the static glass blur (one recalc, post-motion).
 *
 * The obsidian-carbon backdrop is painted once, at this level, so it persists
 * across the transition instead of being recreated by each screen.
 */
export default function Home() {
  const [isEntering, setIsEntering] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);
  const [glassActive, setGlassActive] = useState(false);
  const frameIds = useRef<number[]>([]);
  const timerIds = useRef<number[]>([]);
  const preloadStarted = useRef(false);

  // Hygiene: cancel staged work if the shell ever unmounts mid-handoff.
  useEffect(
    () => () => {
      for (const id of frameIds.current) cancelAnimationFrame(id);
      for (const id of timerIds.current) window.clearTimeout(id);
    },
    [],
  );

  const enter = () => {
    if (isEntering) return;
    setIsEntering(true);
    // Double rAF: let the browser paint the first dive frame(s) before the
    // dashboard shell (and its socket/effects) is even constructed.
    const first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => setShowDashboard(true));
      frameIds.current.push(second);
    });
    frameIds.current.push(first);
    timerIds.current.push(window.setTimeout(() => setHasEntered(true), LENS_DIVE_MS));
    timerIds.current.push(
      window.setTimeout(() => setGlassActive(true), DASHBOARD_SETTLE_MS),
    );
  };

  /**
   * Warm the console chunk while the pointer is still approaching the CTA.
   * Fired from mouse, touch and keyboard intent paths; the module record is
   * shared with the `dynamic()` loader below, so the first hover pays the
   * network cost and the click itself resolves from cache. Repeat calls are
   * free (idempotent guard + bundler dedupe), and any rejection is swallowed,
   * because a failed prefetch must never surface as an unhandled rejection or
   * block the real (retryable) load on click.
   */
  const preloadDashboard = useCallback(() => {
    if (preloadStarted.current) return;
    preloadStarted.current = true;
    void loadNexusDashboard().catch(() => {
      preloadStarted.current = false;
    });
  }, []);

  return (
    <div className="relative min-h-screen">
      <div aria-hidden className="abyss-backdrop" />
      <div aria-hidden className="grid-overlay" />
      <div aria-hidden className="vignette-overlay" />

      {/* Mounted two frames into the dive, so it lands already streaming. */}
      {showDashboard && (
        <div
          className={`dashboard-land relative z-10${glassActive ? " is-settled" : ""}`}
        >
          <ErrorBoundary label="NEXUS dashboard">
            <NexusDashboard glassActive={glassActive} />
          </ErrorBoundary>
        </div>
      )}

      {/* The landing stays on top (z-30) while it dives, then unmounts. */}
      {!hasEntered && (
        <ErrorBoundary label="Landing">
          <LandingHero
            onEnter={enter}
            isEntering={isEntering}
            onIntent={preloadDashboard}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

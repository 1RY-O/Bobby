"use client";

import { useState } from "react";

import LandingHero from "@/components/LandingHero";
import NexusDashboard from "@/components/NexusDashboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Length of the "Lens Dive" lightning handoff in milliseconds. Must match the
 * `lens-dive-lightning` and `dashboard-snap` animations in globals.css.
 */
const LENS_DIVE_MS = 550;

/**
 * App shell.
 *
 * "ENTER EXPERIENCE" starts a lightning-strike handoff: the dashboard is
 * mounted *underneath* the landing page first, then the landing is struck
 * through the lens (blinding Monster-white flash, scale 1 -> 3.2, snapping
 * out) while the console snaps into place with a bouncy spring
 * (scale 1.06 -> 1, flashing from white-hot to frozen). Because the console
 * mounts at the start of the animation, its socket is already connecting
 * while the strike plays — the readout is live by the time the user lands.
 *
 * The landing unmounts once the animation ends so no off-screen layer keeps
 * painting. Both animations are pure CSS: the only JS here is one state flip
 * plus one timeout. The obsidian-carbon backdrop is painted once, at this
 * level, so it persists across the transition instead of being recreated by
 * each screen.
 */
export default function Home() {
  const [isEntering, setIsEntering] = useState(false);
  const [hasEntered, setHasEntered] = useState(false);

  const enter = () => {
    if (isEntering) return;
    setIsEntering(true);
    window.setTimeout(() => setHasEntered(true), LENS_DIVE_MS);
  };

  return (
    <div className="relative min-h-screen">
      <div aria-hidden className="abyss-backdrop" />
      <div aria-hidden className="grid-overlay" />
      <div aria-hidden className="vignette-overlay" />

      {/* Mounted the instant the dive starts, so it lands already streaming. */}
      {isEntering && (
        <div className="dashboard-land relative z-10">
          <ErrorBoundary label="NEXUS dashboard">
            <NexusDashboard />
          </ErrorBoundary>
        </div>
      )}

      {/* The landing stays on top (z-30) while it dives, then unmounts. */}
      {!hasEntered && (
        <ErrorBoundary label="Landing">
          <LandingHero onEnter={enter} isEntering={isEntering} />
        </ErrorBoundary>
      )}
    </div>
  );
}

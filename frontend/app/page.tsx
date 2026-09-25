"use client";

import { useState } from "react";

import LandingHero from "@/components/LandingHero";
import NexusDashboard from "@/components/NexusDashboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * How long the landing keeps fading while the dashboard mounts underneath.
 * Mirrors the `.landing-leaving` / `.view-fade` transition in globals.css.
 */
const HANDOFF_MS = 260;

/**
 * App shell.
 *
 * The landing page renders first and the dashboard is only mounted once the
 * visitor enters, so the WebSocket stream and the React Flow canvas never run
 * behind the intro. The deep-space backdrop is painted once here (fixed +
 * pointer-transparent) so it persists across the handoff instead of being
 * recreated by each screen.
 */
export default function Home() {
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const enter = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => setEntered(true), HANDOFF_MS);
  };

  return (
    <div className="relative min-h-screen">
      <div aria-hidden className="abyss-backdrop" />
      <div aria-hidden className="grid-overlay" />
      <div aria-hidden className="vignette-overlay" />

      {entered ? (
        <div className="view-fade relative z-10">
          <ErrorBoundary label="NEXUS dashboard">
            <NexusDashboard />
          </ErrorBoundary>
        </div>
      ) : (
        <ErrorBoundary label="Landing">
          <LandingHero onEnter={enter} leaving={leaving} />
        </ErrorBoundary>
      )}
    </div>
  );
}

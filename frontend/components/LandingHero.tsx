"use client";

import Image from "next/image";

export interface LandingHeroProps {
  /** Hands off to the NEXUS console (POST /api/start-workflow + ws stream). */
  onEnter: () => void;
  /** True while the cinematic "Lens Dive" out of the hero is in flight. */
  isEntering: boolean;
}

const FOOTER_TAGS = ["AI-POWERED", "AGENTIC PIPELINE", "IBM BOB 2.0"] as const;

/**
 * Fully static landing page.
 *
 * The artwork is a single preloaded PNG (`public/P2.png`) painted by
 * `next/image`; every highlight on top of it is a CSS gradient. There is no
 * canvas, no WebGL, no animation library and no client-side measure pass, so
 * the server HTML and the first client render are byte-identical.
 */
export default function LandingHero({ onEnter, isEntering }: LandingHeroProps) {
  return (
    <section
      aria-label="IBM BOB 2.0 Hackathon — enter the NEXUS console"
      className={`landing-shell ${isEntering ? "landing-diving" : ""}`}
    >
      <Image
        src="/P2.png"
        alt=""
        fill
        preload
        sizes="100vw"
        className="landing-art"
      />
      <div aria-hidden className="landing-veil" />
      <div aria-hidden className="landing-grid" />

      <div className="landing-inner">
        <header className="flex items-center justify-between gap-4">
          <span className="brand-ibm">
            <span aria-hidden className="text-slate-300">
              ◆
            </span>
            IBM
          </span>
          <span className="chip">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-emerald-200/90"
            />
            system online — v0.1
          </span>
        </header>

        <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-6 sm:items-center sm:text-center">
          <h1 className="title-metallic display-tight text-5xl font-extrabold sm:text-7xl lg:text-8xl">
            IBM BOB 2.0
            <br />
            HACKATHON
          </h1>

          <p className="font-mono text-[10px] font-medium tracking-[0.46em] text-slate-400/90 uppercase">
            by 1RY
          </p>

          <p className="body-luxe max-w-xl text-[15px] font-light text-slate-400 sm:text-base">
            AI-powered developer agent pipeline. Orchestrate investigation and
            autonomous remediation from a single glass console.
          </p>

          <button
            type="button"
            onClick={onEnter}
            disabled={isEntering}
            aria-label="Enter the NEXUS console"
            className="btn-enter mt-2"
          >
            Enter experience
            <span aria-hidden className="btn-enter-arrow">
              →
            </span>
          </button>

          <p className="font-mono text-[9px] font-medium tracking-[0.38em] text-slate-500 uppercase">
            orchestrate — investigate — remediate
          </p>
        </div>

        <footer className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {FOOTER_TAGS.map((tag) => (
              <span key={tag} className="chip">
                {tag}
              </span>
            ))}
          </div>
          <span className="font-mono text-[10px] font-light tracking-[0.32em] text-slate-600 uppercase">
            1RY © 2026
          </span>
        </footer>
      </div>
    </section>
  );
}

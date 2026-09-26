"use client";

export interface LandingHeroProps {
  /** Hands off to the NEXUS console (POST /api/start-workflow + ws stream). */
  onEnter: () => void;
  /** True while the cinematic "Lens Dive" out of the hero is in flight. */
  isEntering: boolean;
  /**
   * Fired on pointer-enter / focus of the CTA. The NEXUS console is a lazily
   * loaded chunk, so warming it while the user is still deciding means the
   * Lens Dive has something real to reveal instead of a skeleton.
   */
  onIntent?: () => void;
}

const FOOTER_TAGS = ["⚡ AI-POWERED", "ORCHESTRATE", "IBM BOB 2.0"] as const;

/**
 * Fully static landing page.
 *
 * Bespoke pure-CSS "Obsidian Carbon" backdrop — no image, no canvas, no
 * WebGL, no animation library and no client-side measure pass, so the
 * server HTML and the first client render are byte-identical.
 */
export default function LandingHero({
  onEnter,
  isEntering,
  onIntent,
}: LandingHeroProps) {
  return (
    <section
      aria-label="IBM BOB 2.0 Hackathon — enter the NEXUS console"
      className={`landing-shell ${isEntering ? "landing-diving" : ""}`}
    >
      <div aria-hidden className="landing-obsidian" />
      <div aria-hidden className="landing-veil" />
      <div aria-hidden className="landing-grid" />
      <div aria-hidden className="landing-iso" />
      <div aria-hidden className="landing-pulse">
        <span aria-hidden className="landing-pulse-ring landing-pulse-ring-1" />
        <span aria-hidden className="landing-pulse-ring landing-pulse-ring-2" />
        <span aria-hidden className="landing-pulse-ring landing-pulse-ring-3" />
      </div>
      <div aria-hidden className="landing-beams" />
      {isEntering && <div aria-hidden className="lens-flash" />}

      <div className="landing-inner">
        <header className="flex items-center justify-between gap-4">
          <span className="brand-ibm">
            <span aria-hidden className="text-[#39ff14]">
              ◆
            </span>
            IBM {"//"} OVERDRIVE
          </span>
          <span className="chip">
            <span
              aria-hidden
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#39ff14] shadow-[0_0_8px_rgba(57,255,20,0.9)]"
            />
            v2.0 — live
          </span>
        </header>

        <div className="pop-in mx-auto flex w-full max-w-4xl flex-col items-start gap-6 sm:items-center sm:text-center">
          <p className="landing-eyebrow font-mono text-[10px] font-bold tracking-[0.5em] text-[#00f0ff] uppercase drop-shadow-[0_0_10px_rgba(0,240,255,0.6)]">
            <span aria-hidden className="landing-eyebrow-rule" />
            AI-powered developer pipeline
            <span aria-hidden className="landing-eyebrow-rule" />
          </p>
          <h1 className="title-metallic title-landing display-tight text-5xl font-black tracking-tight italic sm:text-7xl lg:text-8xl">
            IBM BOB 2.0
            <br />
            HACKATHON
          </h1>

          <p className="font-mono text-[11px] font-bold tracking-[0.46em] text-[#e2e8f0]/90 uppercase">
            BY 1RY
          </p>

          <p className="body-luxe max-w-xl text-[15px] font-light text-[#e2e8f0]/70 sm:text-base">
            AI-powered developer agent pipeline. Orchestrate investigation and
            autonomous remediation from a single high-performance console.
          </p>

          <button
            type="button"
            onClick={onEnter}
            onPointerEnter={onIntent}
            onFocus={onIntent}
            disabled={isEntering}
            aria-label="Enter the NEXUS console"
            className="btn-enter btn-reactor frost-sheen mt-2"
          >
            <span aria-hidden className="btn-reactor-core" />
            <span className="relative z-10 flex items-center gap-3">
              ENTER EXPERIENCE
              <span aria-hidden className="btn-enter-arrow">
                →
              </span>
            </span>
          </button>

          <p className="font-mono text-[9px] font-bold tracking-[0.38em] text-[#e2e8f0]/60 uppercase">
            orchestrate <span className="text-[#39ff14]">—</span> investigate{" "}
            <span className="text-[#00f0ff]">—</span> remediate
          </p>
        </div>

        <footer className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {FOOTER_TAGS.map((tag) => (
              <span key={tag} className="chip frost-sheen">
                {tag}
              </span>
            ))}
          </div>
          <span className="font-mono text-[10px] font-bold tracking-[0.32em] text-[#e2e8f0]/50 uppercase">
            1RY © 2026
          </span>
        </footer>
      </div>
    </section>
  );
}

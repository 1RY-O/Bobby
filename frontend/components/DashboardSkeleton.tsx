/**
 * Boot skeleton for the code-split NexusDashboard.
 *
 * The dashboard pulls in React Flow (~176 KB of the initial bundle), so it is
 * loaded on demand via `next/dynamic` the moment the user commits to entering.
 * Until that chunk resolves there is nothing to show, and a blank frame during
 * a 550 ms Lens Dive reads as a broken transition.
 *
 * This mirrors the real console's structure — title bar, node canvas, chip row
 * — using the same glass/neon tokens, so the swap to the live dashboard reads
 * as the console powering up. It is presentational and static, so it carries no
 * client-side cost of its own.
 *
 * Announced politely: assistive tech should hear "loading", not nothing.
 */
export default function DashboardSkeleton() {
  return (
    <div
      className="boot-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading the NEXUS console…</span>

      <div className="boot-skeleton__bar" aria-hidden>
        <span className="boot-skeleton__dot" />
        <span className="boot-skeleton__line" style={{ width: "34%" }} />
        <span className="boot-skeleton__line" style={{ width: "18%" }} />
      </div>

      <div className="boot-skeleton__canvas" aria-hidden>
        <div className="boot-skeleton__node" style={{ left: "6%", top: "16%" }} />
        <div
          className="boot-skeleton__node"
          style={{ left: "38%", top: "52%", opacity: 0.75 }}
        />
        <div
          className="boot-skeleton__node"
          style={{ left: "70%", top: "22%", opacity: 0.5 }}
        />
      </div>

      <div className="boot-skeleton__row" aria-hidden>
        <span className="boot-skeleton__chip" />
        <span className="boot-skeleton__chip" />
        <span className="boot-skeleton__chip" />
      </div>
    </div>
  );
}

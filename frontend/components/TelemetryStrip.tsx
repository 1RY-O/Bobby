"use client";

import type { ConnectionStatus } from "@/lib/agentStream";

export interface TelemetryStripProps {
  /** Log frames currently retained in the client buffer. */
  frames: number;
  /** Hard cap on that buffer (see LOG_BUFFER_LIMIT). */
  bufferLimit: number;
  /** Live transport state, straight from the socket. */
  status: ConnectionStatus;
  /** True when the transport reported an error. */
  degraded: boolean;
  /** Pipeline stage currently processing, if any. */
  activeNodeId: string | null;
}

/** Mocked baseline counters. TOKENS.PROC grows with observed frames. */
const TOKEN_BASE = 1_400_000;
const TOKENS_PER_FRAME = 4_200;
const UPTIME_PERCENT = 99.9;
const PROTOCOL_SEGMENTS = 8;

/**
 * Deterministic sparkline silhouette. A fixed shape (rather than Math.random)
 * keeps the markup stable across re-renders while the CSS keyframes animate
 * each bar with a staggered delay, so the graph still reads as live data.
 */
const SPARK_SHAPE = [
  22, 38, 30, 54, 44, 68, 52, 76, 61, 88, 70, 92, 78, 96, 84, 100,
];

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

/**
 * System telemetry readout.
 *
 * UPTIME and the token baseline are mock values; SEC.PROTOCOLS, the token
 * throughput delta, the buffer saturation and the active stage are derived
 * from real dashboard state, so the strip visibly reacts to the live stream.
 * Everything animates from CSS keyframes — no timers, no requestAnimationFrame.
 */
export default function TelemetryStrip({
  frames,
  bufferLimit,
  status,
  degraded,
  activeNodeId,
}: TelemetryStripProps) {
  const tokens = TOKEN_BASE + frames * TOKENS_PER_FRAME;
  const bufferUsage = Math.min(
    100,
    Math.round((frames / Math.max(1, bufferLimit)) * 100),
  );

  const protocols = degraded
    ? { label: "⚠ DEGRADED", tone: "alert", lit: 3, valueClass: "text-[#ff0800]" }
    : status === "open"
      ? {
          label: "⚡ NOMINAL",
          tone: "ok",
          lit: PROTOCOL_SEGMENTS,
          valueClass: "text-[#39ff14]",
        }
      : status === "connecting"
        ? {
            label: "❄ SYNCING",
            tone: "warn",
            lit: 5,
            valueClass: "text-[#00f0ff]",
          }
        : {
            label: "✕ OFFLINE",
            tone: "alert",
            lit: 2,
            valueClass: "text-[#ff0800]",
          };

  return (
    <section aria-label="System telemetry" className="hud-strip">
      {/* SYS.UPTIME — mocked 24h availability readout. */}
      <div className="hud-tile frost-sheen">
        <p className="hud-tile-label">⚡ sys.uptime</p>
        <p className="hud-tile-value text-[#e2e8f0]">
          {UPTIME_PERCENT.toFixed(1)}%
        </p>
        <div aria-hidden className="hud-meter">
          <div
            className="hud-meter-fill"
            style={{ width: `${UPTIME_PERCENT}%` }}
          />
        </div>
        <p className="font-mono text-[9px] font-bold tracking-[0.22em] text-[#e2e8f0]/40 uppercase">
          24h {"//"} overdrive
        </p>
      </div>

      {/* TOKENS.PROC — mock baseline plus a live per-frame increment. */}
      <div className="hud-tile frost-sheen">
        <p className="hud-tile-label">❄ tokens.proc</p>
        <p className="hud-tile-value text-[#39ff14]">{formatTokens(tokens)}</p>
        <div aria-hidden className="hud-spark">
          {SPARK_SHAPE.map((height, index) => (
            <span
              key={height + index}
              style={{
                height: `${height}%`,
                animationDelay: `${index * 110}ms`,
              }}
            />
          ))}
        </div>
        <p className="font-mono text-[9px] font-bold tracking-[0.22em] text-[#e2e8f0]/40 uppercase">
          {frames} frames {"//"} processed
        </p>
      </div>

      {/* SEC.PROTOCOLS — wording and bar driven by the socket state. */}
      <div className="hud-tile frost-sheen">
        <p className="hud-tile-label">⚡ sec.protocols</p>
        <p className={`hud-tile-value ${protocols.valueClass}`}>
          {protocols.label}
        </p>
        <div aria-hidden className="hud-seg" data-tone={protocols.tone}>
          {Array.from({ length: PROTOCOL_SEGMENTS }, (_, index) => (
            <i
              key={index}
              data-on={index < protocols.lit ? "true" : "false"}
            />
          ))}
        </div>
        <p className="font-mono text-[9px] font-bold tracking-[0.22em] text-[#e2e8f0]/40 uppercase">
          wss <span className="text-[#39ff14]">{"//"}</span> secure-channel
        </p>
      </div>

      {/* BUFFER.SAT — real buffer saturation + the active pipeline stage. */}
      <div className="hud-tile frost-sheen">
        <p className="hud-tile-label">❄ buffer.sat</p>
        <p className="hud-tile-value text-[#00f0ff]">{bufferUsage}%</p>
        <div aria-hidden className="hud-meter">
          <div className="hud-meter-fill" style={{ width: `${bufferUsage}%` }} />
        </div>
        <p className="font-mono text-[9px] font-bold tracking-[0.22em] text-[#e2e8f0]/40 uppercase">
          stage <span className="text-[#39ff14]">{activeNodeId ?? "idle"}</span>
        </p>
      </div>
    </section>
  );
}

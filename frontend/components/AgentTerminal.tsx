"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CONNECTION_STATUS_META,
  normalizeAgentId,
  type AgentLog,
  type ConnectionStatus,
} from "@/lib/agentStream";

export interface AgentTerminalProps {
  logs: AgentLog[];
  status: ConnectionStatus;
  /** Agent name most recently reported as active, straight from the socket. */
  activeAgent: string | null;
  error: string | null;
  onClear: () => void;
  /** Scroll area height; defaults to a compact console strip. */
  heightClass?: string;
  /** When true, new lines render instantly (no CSS entrance animation). */
  reduceMotion?: boolean;
}

/**
 * Semantic tone of a log line.
 *
 * The backend reports statuses in several shapes ("active", "done",
 * "investigator_complete", "remediation_failed"), so classification works on
 * substrings of the normalised status key, with `level` as the fallback.
 */
type Tone = "idle" | "active" | "error";

const ERROR_MARKERS = [
  "error",
  "err",
  "fail",
  "critical",
  "fatal",
  "exception",
  "timeout",
  "rejected",
  "denied",
];

const ACTIVE_MARKERS = [
  "active",
  "running",
  "start",
  "process",
  "working",
  "busy",
  "done",
  "complete",
  "finish",
  "success",
  "verified",
  "pass",
  "ok",
];

function resolveTone(entry: AgentLog): Tone {
  const status = normalizeAgentId(entry.status);
  const matches = (markers: string[]) =>
    markers.some((marker) => status.includes(marker));

  if (matches(ERROR_MARKERS) || entry.level === "error") return "error";
  if (matches(ACTIVE_MARKERS) || entry.level === "success") return "active";
  return "idle";
}

/** Directive palette: monster silver → axe green → angry-birds rage red. */
const TONE_TEXT: Record<Tone, string> = {
  idle: "text-[#e2e8f0]/45",
  active: "text-white",
  error: "text-[#ff0800] font-semibold drop-shadow-[0_0_8px_rgba(255,8,0,0.5)]",
};

const TONE_TAG: Record<Tone, string> = {
  idle: "text-[#e2e8f0]/40",
  active: "text-[#00f0ff] drop-shadow-[0_0_6px_rgba(0,240,255,0.5)]",
  error: "text-[#ff0800]",
};

const TONE_RAIL: Record<Tone, string> = {
  idle: "border-l-white/40",
  active: "border-l-[#39ff14]",
  error: "border-l-[#ff0800]",
};

const TONE_CHIP: Record<Tone, string> = {
  idle: "border-white/40 bg-white/[0.04] text-[#e2e8f0]/60",
  active: "border-[#39ff14]/60 bg-[#39ff14]/[0.1] text-[#39ff14]",
  error: "border-[#ff0800]/60 bg-[#ff0800]/[0.12] text-[#ff0800]",
};

/** Clipboard affordance icons (inline SVG — no icon dependency). */
function CopyGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Pixels from the bottom still treated as "user is following the tail". */
const PINNED_THRESHOLD = 32;

/**
 * Glassmorphic console that renders the live agent log feed.
 *
 * Lines are colour-coded by semantic status (silver / cyan / magenta), fade +
 * slide in over 150ms, and only failure lines trigger the CRT glitch shake.
 * Every effect is a CSS class, so a burst of frames never starts a JS
 * animation. The view stays pinned to the tail until the user scrolls up.
 */
export default function AgentTerminal({
  logs,
  status,
  activeAgent,
  error,
  onClear,
  heightClass = "h-[200px]",
  reduceMotion = false,
}: AgentTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  /** Id of the line whose copy button just fired, for the tick feedback. */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /**
   * Copies one log line as plain text — useful for pasting a failure into an
   * issue. Clipboard access is permission/secure-context gated, so a refusal
   * is swallowed rather than surfaced as an error in the console.
   */
  const copyLine = useCallback(async (entry: AgentLog) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;

    const text = [
      TIME_FORMATTER.format(entry.receivedAt),
      entry.level,
      entry.agent,
      entry.status,
      entry.action,
    ]
      .filter(Boolean)
      .join(" ");

    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(entry.id);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1400);
    } catch {
      // Blocked clipboard (insecure origin, denied permission) — no-op.
    }
  }, []);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinned.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <
      PINNED_THRESHOLD;
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinned.current) return;
    element.scrollTop = element.scrollHeight;
  }, [logs]);

  const statusMeta = CONNECTION_STATUS_META[status];

  return (
    <section
      aria-label="Live agent log stream"
      className="terminal-console frost-sheen relative border-t border-white/40 bg-black/50 backdrop-blur-2xl"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#39ff14] to-transparent shadow-[0_0_12px_rgba(57,255,20,0.6)]" />

      {/* Terminal title bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 sm:px-7">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#ff0800]/90 shadow-[0_0_8px_rgba(255,8,0,0.8)]" />
          <span className="h-2 w-2 rounded-full bg-[#e2e8f0]/70" />
          <span className="h-2 w-2 rounded-full bg-[#39ff14]/90 shadow-[0_0_8px_rgba(57,255,20,0.8)]" />
          <span className="ml-3 font-mono text-[10px] font-black tracking-[0.28em] text-[#e2e8f0]/80 uppercase">
            ⚡ agent-stream.log <span className="text-[#00f0ff]">❄</span>
          </span>
          <span
            className={`ml-2 inline-flex items-center gap-2 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.2em] uppercase ${statusMeta.chipClass}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
            {statusMeta.label}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] font-medium tracking-[0.2em] uppercase">
          <span className="chip">
            {activeAgent ? `● ${activeAgent}` : "○ idle"}
          </span>
          <span className="chip">{logs.length} lines</span>
          <button
            type="button"
            onClick={onClear}
            className="chip hover:border-white/20 hover:text-slate-100"
          >
            clear
          </button>
        </div>
      </div>

      {error && (
        <p className="px-5 pb-2 font-mono text-[11px] font-bold tracking-[0.03em] text-[#ff0800] drop-shadow-[0_0_8px_rgba(255,8,0,0.5)] sm:px-7">
          ⚠ {error}
        </p>
      )}

      {/* Scrollback */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`terminal-scroll ${heightClass} overflow-y-auto px-4 pb-5 font-mono text-[12.5px] leading-[1.8] tracking-[0.01em]`}
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2.5 text-center text-[10px] font-bold tracking-[0.3em] text-[#e2e8f0]/40 uppercase">
            <span className="font-medium">❄ awaiting thunder telemetry</span>
            <span className="caret-blink">▍</span>
          </div>
        ) : (
          logs.map((entry, index) => {
            const tone = resolveTone(entry);
            const isError = tone === "error";
            const isNewest = index === logs.length - 1;

            return (
              <div
                key={entry.id}
                className={[
                  "terminal-line group flex items-start gap-3 rounded-md border-l-[3px] px-2.5 py-1",
                  TONE_RAIL[tone],
                  isError
                    ? "bg-[#ff0800]/[0.09] shadow-[0_0_16px_rgba(255,8,0,0.2)] hover:bg-[#ff0800]/[0.14]"
                    : "hover:bg-[#39ff14]/[0.05]",
                  // Failures violently shake; newest healthy line springs in.
                  isError && !reduceMotion && "terminal-line-glitch",
                  !isError && isNewest && !reduceMotion && "terminal-line-new",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <span className="shrink-0 font-light text-[#e2e8f0]/40">
                  {TIME_FORMATTER.format(entry.receivedAt)}
                </span>
                <span className={`w-[64px] shrink-0 font-black uppercase ${TONE_TAG[tone]}`}>
                  {entry.level}
                </span>
                <span className="shrink-0 font-bold text-[#e2e8f0]/70">
                  {entry.agent}
                </span>
                {entry.status && (
                  <span
                    className={`shrink-0 rounded border px-1.5 py-px text-[10px] font-black ${TONE_CHIP[tone]}`}
                  >
                    {entry.status}
                  </span>
                )}
                <span className={`min-w-0 font-medium break-words ${TONE_TEXT[tone]}`}>
                  {isError ? `⚠ ${entry.action}` : entry.action}
                </span>

                {/* Copy affordance: revealed on hover, and left faintly visible
                    on failures so an error is one click from the clipboard. */}
                <button
                  type="button"
                  onClick={() => void copyLine(entry)}
                  aria-label={
                    copiedId === entry.id
                      ? "Log line copied"
                      : `Copy log line from ${entry.agent}`
                  }
                  className={[
                    "mt-0.5 ml-auto shrink-0 self-start rounded border border-white/40 bg-white/[0.05] p-1 text-[#e2e8f0]/60 transition-all duration-200 hover:border-[#39ff14] hover:text-[#39ff14] hover:scale-110 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#39ff14]/50 focus-visible:outline-none",
                    copiedId === entry.id
                      ? "border-[#39ff14] text-[#39ff14] opacity-100"
                      : isError
                        ? "opacity-60 group-hover:opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                  ].join(" ")}
                >
                  {copiedId === entry.id ? <CheckGlyph /> : <CopyGlyph />}
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

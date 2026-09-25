"use client";

import { useEffect, useRef } from "react";

import {
  CONNECTION_STATUS_META,
  type AgentLog,
  type ConnectionStatus,
  type LogLevel,
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

const LEVEL_STYLES: Record<LogLevel, { tag: string; text: string }> = {
  debug: { tag: "text-slate-500", text: "text-slate-400" },
  info: { tag: "text-cyan-400", text: "text-slate-200" },
  success: { tag: "text-emerald-400", text: "text-emerald-100" },
  warn: { tag: "text-amber-400", text: "text-amber-100" },
  error: { tag: "text-rose-400", text: "text-rose-200" },
};

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
 * The view keeps itself pinned to the newest line unless the user has scrolled
 * up to read history. Line entrances are pure CSS, so a burst of frames stays
 * cheap (no per-line JS animation).
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
      className="terminal-console relative border-t border-white/10 bg-black/45 backdrop-blur-xl"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />

      {/* Terminal title bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/80" />
          <span className="ml-3 font-mono text-xs tracking-[0.2em] text-slate-400 uppercase">
            agent-stream.log
          </span>
          <span
            className={`ml-2 inline-flex items-center gap-2 rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-[0.18em] uppercase ${statusMeta.chipClass}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`} />
            {statusMeta.label}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] uppercase">
          <span className="chip border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-200">
            {activeAgent ? `▶ ${activeAgent}` : "◇ idle"}
          </span>
          <span className="chip">{logs.length} lines</span>
          <button
            type="button"
            onClick={onClear}
            className="chip hover:border-cyan-400/40 hover:text-cyan-200"
          >
            clear
          </button>
        </div>
      </div>

      {error && (
        <p className="px-6 pb-2 font-mono text-[11px] text-rose-300">
          ⚠ {error}
        </p>
      )}

      {/* Scrollback */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`terminal-scroll ${heightClass} overflow-y-auto px-4 pb-4 font-mono text-[12px] leading-6`}
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-center text-[11px] tracking-[0.18em] text-slate-500 uppercase">
            <span>awaiting telemetry</span>
            <span className="caret-blink text-cyan-300">▍</span>
          </div>
        ) : (
          logs.map((entry, index) => {
            const level = LEVEL_STYLES[entry.level] ?? LEVEL_STYLES.info;
            // Micro-interaction: only the newest line flashes.
            const isNewest = index === logs.length - 1;
            return (
              <div
                key={entry.id}
                className={`terminal-line flex items-start gap-3 rounded border-l-2 border-transparent px-2 py-0.5 hover:bg-white/[0.05] ${
                  isNewest && !reduceMotion ? "terminal-line-new" : ""
                }`}
              >
                <span className="shrink-0 text-slate-500">
                  {TIME_FORMATTER.format(entry.receivedAt)}
                </span>
                <span className={`w-[64px] shrink-0 uppercase ${level.tag}`}>
                  {entry.level}
                </span>
                <span className="shrink-0 text-violet-300/90">
                  {entry.agent}
                </span>
                {entry.status && (
                  <span className="shrink-0 rounded border border-white/10 bg-white/5 px-1 text-[10px] text-slate-400">
                    {entry.status}
                  </span>
                )}
                <span className={`min-w-0 break-words ${level.text}`}>
                  {entry.action}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

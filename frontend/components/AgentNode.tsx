"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";

import type { AgentAccent } from "@/lib/agentStream";

export interface AgentNodeData {
  label: string;
  accent: AgentAccent;
  /** Set by the dashboard while this agent is the one currently processing. */
  active: boolean;
}

interface AccentSpec {
  /** "r,g,b" triple reused to build rgba() glows. */
  rgb: string;
  dot: string;
  labelClass: string;
  surface: string;
}

const ACCENTS: Record<AgentAccent, AccentSpec> = {
  cyan: {
    rgb: "8,182,249",
    dot: "var(--accent-cyan)",
    labelClass: "text-cyan-100",
    surface:
      "linear-gradient(135deg, rgba(8,182,249,0.16), rgba(8,182,249,0.03))",
  },
  violet: {
    rgb: "139,92,246",
    dot: "var(--accent-violet)",
    labelClass: "text-violet-100",
    surface:
      "linear-gradient(135deg, rgba(139,92,246,0.2), rgba(217,70,239,0.05))",
  },
  emerald: {
    rgb: "45,212,191",
    dot: "var(--accent-mint)",
    labelClass: "text-emerald-100",
    surface:
      "linear-gradient(135deg, rgba(45,212,191,0.16), rgba(8,182,249,0.04))",
  },
};

/**
 * React Flow node for one agent in the pipeline.
 *
 * Drawn entirely from CSS: a glass card tinted with the agent's accent plus a
 * static state swap (standby -> processing) driven by `data.active`. Nothing
 * here animates the layout, so an idle canvas costs nothing.
 */
function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const accent = ACCENTS[data.accent] ?? ACCENTS.cyan;
  const { rgb } = accent;
  const active = Boolean(data.active);

  const shadow = active
    ? `0 0 0 1px rgba(${rgb},0.9), 0 0 34px -6px rgba(${rgb},0.85), 0 0 90px -40px rgba(${rgb},0.9), inset 0 1px 0 rgba(255,255,255,0.2)`
    : `0 0 0 1px rgba(${rgb},0.32), 0 0 24px -12px rgba(${rgb},0.7), inset 0 1px 0 rgba(255,255,255,0.08)`;

  const handleStyle = {
    width: 7,
    height: 7,
    background: accent.dot,
    border: "1px solid rgba(255,255,255,0.45)",
    boxShadow: `0 0 10px rgba(${rgb},0.9)`,
  };

  return (
    <div className="relative w-[190px]">
      <span className="pointer-events-none absolute -top-2 right-3 z-10 rounded-full border border-white/10 bg-[#05001a]/85 px-1.5 py-px font-mono text-[8px] tracking-[0.2em] text-white/60 uppercase">
        agent
      </span>

      <div
        className="node-surface relative border px-4 py-3"
        style={{ backgroundImage: accent.surface, boxShadow: shadow }}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-[13px] font-bold tracking-[0.08em] uppercase ${accent.labelClass}`}
          >
            {data.label}
          </span>
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full transition-all duration-300 ${
              active ? "scale-125 opacity-100" : "scale-100 opacity-45"
            }`}
            style={{
              background: accent.dot,
              boxShadow: active ? `0 0 12px rgba(${rgb},1)` : "none",
            }}
          />
        </div>

        <div className="mt-2 font-mono text-[10px] tracking-[0.18em] uppercase">
          <span
            className={`transition-colors duration-300 ${
              active ? "text-white" : "text-slate-400"
            }`}
          >
            {active ? "processing" : "standby"}
          </span>
        </div>

        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
      </div>
    </div>
  );
}

export default memo(AgentNode);

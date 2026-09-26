"use client";

import { memo, type CSSProperties } from "react";
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
    rgb: "125,211,252",
    dot: "#bae6fd",
    labelClass: "text-slate-100",
    surface:
      "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012) 55%, rgba(125,211,252,0.05))",
  },
  violet: {
    rgb: "167,139,250",
    dot: "#ddd6fe",
    labelClass: "text-slate-100",
    surface:
      "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012) 55%, rgba(167,139,250,0.06))",
  },
  emerald: {
    rgb: "94,234,212",
    dot: "#99f6e4",
    labelClass: "text-slate-100",
    surface:
      "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012) 55%, rgba(94,234,212,0.05))",
  },
  magenta: {
    rgb: "240,171,252",
    dot: "#f5d0fe",
    labelClass: "text-slate-100",
    surface:
      "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.012) 55%, rgba(240,171,252,0.06))",
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
    ? `0 0 0 1px rgba(${rgb},0.4), 0 14px 36px -22px rgba(0,0,0,0.9), 0 0 22px -12px rgba(${rgb},0.35), inset 0 1px 0 rgba(255,255,255,0.15)`
    : `0 0 0 1px rgba(255,255,255,0.07), 0 14px 32px -24px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.1)`;

  const handleStyle = {
    width: 7,
    height: 7,
    background: accent.dot,
    border: "1px solid rgba(255,255,255,0.35)",
    boxShadow: `0 0 6px rgba(${rgb},0.45)`,
  };

  // `--accent-rgb` is the single hook the HUD CSS reads: the internal pulse,
  // the halo brackets and the armed border all inherit it from this wrapper.
  const hudVars = { "--accent-rgb": rgb } as CSSProperties;

  const railStyle = {
    background: `linear-gradient(90deg, transparent, rgba(${rgb},0.5), transparent)`,
  };

  return (
    <div className="relative w-[196px]" style={hudVars}>
      <span className="pointer-events-none absolute -top-2 right-3 z-10 rounded-full border border-white/10 bg-[#05001a]/90 px-1.5 py-px font-mono text-[8px] font-medium tracking-[0.24em] text-white/40 uppercase">
        agent
      </span>

      {/* HUD halo brackets: drawn from --accent-rgb, no extra JS. */}
      <span aria-hidden className="hud-bracket hud-bracket-tl" />
      <span aria-hidden className="hud-bracket hud-bracket-br" />

      <div
        className={`node-surface relative border px-4 py-3 ${
          active ? "node-surface-active" : ""
        }`}
        style={{ backgroundImage: accent.surface, boxShadow: shadow }}
      >
        {/* Instrument rail along the top edge of the card. */}
        <span
          aria-hidden
          className="absolute inset-x-4 top-0 h-px opacity-40"
          style={railStyle}
        />
        <div className="flex items-center justify-between gap-2">
          <span
            className={`text-[13px] font-semibold tracking-[0.02em] ${accent.labelClass}`}
          >
            {data.label}
          </span>
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-300 ${
              active ? "scale-110 opacity-100" : "scale-100 opacity-35"
            }`}
            style={{
              background: accent.dot,
              boxShadow: active ? `0 0 8px rgba(${rgb},0.6)` : "none",
            }}
          />
        </div>

        <div className="mt-2 font-mono text-[9px] font-medium tracking-[0.24em] uppercase">
          <span
            className={`transition-colors duration-300 ${
              active ? "text-white/90" : "text-slate-500"
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

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
    rgb: "0,240,255",
    dot: "#00f0ff",
    labelClass: "text-[#e2e8f0]",
    surface:
      "linear-gradient(180deg, rgba(226,232,240,0.14), rgba(226,232,240,0.03) 55%, rgba(0,240,255,0.12))",
  },
  violet: {
    rgb: "57,255,20",
    dot: "#39ff14",
    labelClass: "text-[#e2e8f0]",
    surface:
      "linear-gradient(180deg, rgba(226,232,240,0.14), rgba(226,232,240,0.03) 55%, rgba(57,255,20,0.12))",
  },
  emerald: {
    rgb: "226,232,240",
    dot: "#e2e8f0",
    labelClass: "text-[#e2e8f0]",
    surface:
      "linear-gradient(180deg, rgba(255,255,255,0.18), rgba(226,232,240,0.05) 55%, rgba(226,232,240,0.1))",
  },
  magenta: {
    rgb: "0,240,255",
    dot: "#c8f7ff",
    labelClass: "text-[#e2e8f0]",
    surface:
      "linear-gradient(180deg, rgba(226,232,240,0.14), rgba(226,232,240,0.03) 55%, rgba(0,240,255,0.1))",
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
    ? `0 0 0 1px rgba(${rgb},0.65), 0 14px 36px -18px rgba(0,0,0,0.9), 0 0 26px -6px rgba(${rgb},0.65), 0 0 56px -12px rgba(${rgb},0.4), inset 0 1px 0 rgba(255,255,255,0.65), inset 0 0 24px rgba(${rgb},0.12)`
    : `0 0 0 1px rgba(255,255,255,0.4), 0 14px 32px -22px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.55)`;

  const handleStyle = {
    width: 9,
    height: 9,
    background: accent.dot,
    border: "1px solid rgba(255,255,255,0.65)",
    boxShadow: `0 0 10px rgba(${rgb},0.8)`,
  };

  // `--accent-rgb` is the single hook the HUD CSS reads: the internal pulse,
  // the halo brackets and the armed border all inherit it from this wrapper.
  const hudVars = { "--accent-rgb": rgb } as CSSProperties;

  const railStyle = {
    background: `linear-gradient(90deg, transparent, rgba(${rgb},0.5), transparent)`,
  };

  return (
    <div className="relative w-[196px]" style={hudVars}>
      <span className="pointer-events-none absolute -top-2 right-3 z-10 rounded border border-white/40 bg-[#0a0b0d]/95 px-1.5 py-px font-mono text-[8px] font-black tracking-[0.24em] text-[#39ff14] uppercase shadow-[0_0_10px_rgba(57,255,20,0.4)]">
        ⚡ agent
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
            className={`text-[13px] font-black tracking-[0.04em] uppercase italic ${accent.labelClass}`}
          >
            {data.label}
          </span>
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full transition-all duration-300 ${
              active ? "scale-125 opacity-100" : "scale-100 opacity-40"
            }`}
            style={{
              background: accent.dot,
              boxShadow: active ? `0 0 12px rgba(${rgb},0.9)` : "none",
            }}
          />
        </div>

        <div className="mt-2 font-mono text-[9px] font-black tracking-[0.24em] uppercase">
          <span
            className={`transition-colors duration-300 ${
              active ? "text-white drop-shadow-[0_0_6px_rgba(57,255,20,0.8)]" : "text-[#e2e8f0]/50"
            }`}
          >
            {active ? "⚡ processing" : "❄ standby"}
          </span>
        </div>

        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
      </div>
    </div>
  );
}

export default memo(AgentNode);

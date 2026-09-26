"use client";

import { useCallback, useEffect, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";

import AgentNode, { type AgentNodeData } from "@/components/AgentNode";
import AgentTerminal from "@/components/AgentTerminal";
import TelemetryStrip from "@/components/TelemetryStrip";
import {
  AGENT_STREAM_ERROR_MESSAGE,
  AGENT_STREAM_URL,
  CONNECTION_STATUS_META,
  LOG_BUFFER_LIMIT,
  WORKFLOW_REQUEST_TIMEOUT_MS,
  WORKFLOW_START_URL,
  isActiveStatus,
  isAgentStreamUnconfigured,
  isAgentStreamUrlAllowed,
  isFinishedStatus,
  matchAgentToNode,
  normalizeAgentId,
  normalizeAgentLog,
  resolveAgentStreamUrl,
  type AgentLog,
  type AgentNodeId,
  type ConnectionStatus,
  type WorkflowStatus,
} from "@/lib/agentStream";

/** Registered outside the component so React Flow keeps a stable type map. */
const nodeTypes = { agent: AgentNode };

/**
 * Ambient-motion kill-switch: idle edges stay static + dim so the canvas feels
 * calm. Only the path feeding the active agent animates.
 */
function edgePresentation(activeNodeId: AgentNodeId | null, edge: Edge): Edge {
  const active =
    activeNodeId !== null &&
    (edge.source === activeNodeId || edge.target === activeNodeId);
  return {
    ...edge,
    animated: active,
    style: {
      ...(edge.style as Record<string, string | number> | undefined),
      opacity: activeNodeId === null || active ? 1 : 0.35,
    },
  };
}

const initialNodes: Node<AgentNodeData>[] = [
  {
    id: "orchestrator",
    type: "agent",
    position: { x: 50, y: 150 },
    data: { label: "Orchestrator", accent: "cyan", active: false },
  },
  {
    id: "investigator",
    type: "agent",
    position: { x: 350, y: 150 },
    data: { label: "Investigator", accent: "violet", active: false },
  },
  {
    id: "remediation",
    type: "agent",
    position: { x: 650, y: 150 },
    data: { label: "Remediation", accent: "emerald", active: false },
  },
  {
    id: "validator",
    type: "agent",
    position: { x: 950, y: 150 },
    data: { label: "Validator", accent: "magenta", active: false },
  },
];

/** Dotted connectors — neon electric rails. */
const initialEdges: Edge[] = [
  {
    id: "e-orchestrator-investigator",
    source: "orchestrator",
    target: "investigator",
    animated: false,
    style: {
      stroke: "rgba(57,255,20,0.7)",
      strokeWidth: 2,
      strokeDasharray: "4 6",
    },
  },
  {
    id: "e-investigator-remediation",
    source: "investigator",
    target: "remediation",
    animated: false,
    style: {
      stroke: "rgba(0,240,255,0.7)",
      strokeWidth: 2,
      strokeDasharray: "4 6",
    },
  },
  {
    id: "e-remediation-validator",
    source: "remediation",
    target: "validator",
    animated: false,
    style: {
      stroke: "rgba(226,232,240,0.65)",
      strokeWidth: 2,
      strokeDasharray: "4 6",
    },
  },
];

/** Legend strip under the canvas; also reflects which agent is processing. */
const agentLegend: {
  id: AgentNodeId;
  title: string;
  desc: string;
  dot: string;
}[] = [
  {
    id: "orchestrator",
    title: "Orchestrator",
    desc: "Plans tasks & routes context",
    dot: "bg-[#39ff14] shadow-[0_0_8px_rgba(57,255,20,0.9)]",
  },
  {
    id: "investigator",
    title: "Investigator",
    desc: "Scans code & gathers evidence",
    dot: "bg-[#00f0ff] shadow-[0_0_8px_rgba(0,240,255,0.9)]",
  },
  {
    id: "remediation",
    title: "Remediation",
    desc: "Proposes & applies fixes",
    dot: "bg-[#e2e8f0] shadow-[0_0_8px_rgba(226,232,240,0.9)]",
  },
  {
    id: "validator",
    title: "Validator",
    desc: "Re-runs checks & confirms the fix",
    dot: "bg-[#ff0800] shadow-[0_0_8px_rgba(255,8,0,0.9)]",
  },
];

/** Backoff schedule for re-establishing the WebSocket after an unexpected close. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/** Client-side shape gates (the server Pydantic model is the source of truth). */
const REPO_URL_MAX_LENGTH = 2048;
const ISSUE_DESCRIPTION_MAX_LENGTH = 4000;
const REPO_URL_PATTERN = new RegExp(
  "^https://github\\.com/[^/\\s]+/[^/\\s]+/?$",
  "i",
);

/** An issue description shorter than this is flagged as too vague to act on. */
const ISSUE_DESCRIPTION_MIN_LENGTH = 10;

/**
 * Field chrome per validation state.
 *
 * The whole utility string is swapped rather than layered, so a magenta error
 * state never has to out-specify a cyan utility for the same declaration
 * (both would just sit in the same cascade layer and fight).
 */
const FIELD_TONE = {
  valid:
    "focus:border-[#39ff14] focus:ring-[#39ff14]/30 focus:shadow-[0_0_0_3px_rgba(57,255,20,0.22),0_0_24px_rgba(57,255,20,0.25)]",
  invalid:
    "border-[#ff0800]/50 focus:border-[#ff0800] focus:ring-[#ff0800]/30 focus:shadow-[0_0_0_3px_rgba(255,8,0,0.25),0_0_24px_rgba(255,8,0,0.35)]",
} as const;

/** Floating-label colour: icy silver, neon green on focus, rage red on error. */
const LABEL_TONE = {
  valid: "text-[#e2e8f0]/50 peer-focus:text-[#39ff14] peer-valid:text-[#00f0ff]/80",
  invalid: "text-[#ff0800] peer-focus:text-[#ff0800]",
} as const;

const WORKFLOW_BUTTON_LABEL: Record<WorkflowStatus, string> = {
  idle: "Start Workflow",
  starting: "Starting…",
  started: "Workflow Running",
  error: "Retry Workflow",
};

/**
 * The NEXUS agent workflow dashboard.
 *
 * Mounted only after the visitor leaves the landing page, so the WebSocket
 * stream and the React Flow canvas are never started while they are still
 * looking at the intro. Every visual state is a CSS class — no animation
 * runtime is involved.
 */
export default function NexusDashboard() {
  const [nodes, setNodes, onNodesChange] =
    useNodesState<AgentNodeData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);

  const [workflowStatus, setWorkflowStatus] = useState<WorkflowStatus>("idle");
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string>("");
  const [issueDescription, setIssueDescription] = useState<string>("");
  const [ctaFlash, setCtaFlash] = useState<"success" | "error" | null>(null);
  // Mobile pipeline starts collapsed (CTA + terminal first); the desktop CSS
  // (`sm:block`) keeps the graph visible regardless of this flag.
  // Initialised to `false` on purpose: reading `matchMedia` during render
  // would make the server markup and the first client render disagree.
  const [isPipelineOpen, setIsPipelineOpen] = useState(false);

  // Native WebSocket straight to the LangGraph workflow stream: connect on
  // mount, reconnect with backoff when the socket drops, close on unmount.
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let sequence = 0;

    const connect = () => {
      if (disposed) return;

      const streamUrl = resolveAgentStreamUrl(AGENT_STREAM_URL);
      if (isAgentStreamUnconfigured(streamUrl)) {
        setConnectionStatus("closed");
        setStreamError(
          "agent stream is not configured (E_CONFIG) — set NEXT_PUBLIC_AGENT_STREAM_URL",
        );
        return;
      }
      if (!isAgentStreamUrlAllowed(streamUrl)) {
        setConnectionStatus("closed");
        setStreamError(
          "blocked insecure agent stream on a secure page (E_TLS) — use wss://",
        );
        return;
      }

      setConnectionStatus("connecting");
      try {
        socket = new WebSocket(streamUrl);
      } catch {
        setConnectionStatus("closed");
        setStreamError(AGENT_STREAM_ERROR_MESSAGE);
        return;
      }

      socket.onopen = () => {
        if (disposed) return;
        attempt = 0;
        setStreamError(null);
        setConnectionStatus("open");
      };

      socket.onmessage = (message: MessageEvent) => {
        if (disposed || typeof message.data !== "string") return;

        sequence += 1;
        const entry = normalizeAgentLog(message.data, `log-${sequence}`);
        if (!entry) return;

        setLogs((previous) => {
          const next = [...previous, entry];
          return next.length > LOG_BUFFER_LIMIT
            ? next.slice(-LOG_BUFFER_LIMIT)
            : next;
        });

        // {"agent": "investigator", "action": "...", "status": "active"}
        // -> glow that agent's node; a finished status drops the glow again.
        if (isActiveStatus(entry.status)) {
          setActiveAgent(entry.agent);
        } else if (isFinishedStatus(entry.status)) {
          setActiveAgent((current) =>
            current &&
            normalizeAgentId(current) === normalizeAgentId(entry.agent)
              ? null
              : current,
          );
        }
      };

      socket.onerror = () => {
        if (!disposed) setStreamError(AGENT_STREAM_ERROR_MESSAGE);
      };

      socket.onclose = () => {
        if (disposed) return;

        setConnectionStatus("closed");
        attempt += 1;
        const delay = Math.min(
          RECONNECT_BASE_MS * 2 ** (attempt - 1),
          RECONNECT_MAX_MS,
        );
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const startWorkflow = useCallback(async () => {
    setWorkflowStatus("starting");
    setWorkflowMessage(null);
    setCtaFlash(null);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      WORKFLOW_REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(WORKFLOW_START_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_url: repoUrl.trim(),
          issue_description: issueDescription.trim(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `backend responded ${response.status} ${response.statusText}`.trim(),
        );
      }

      setWorkflowStatus("started");
      setWorkflowMessage("workflow started — waiting for agent events");
      setCtaFlash("success");
      window.setTimeout(() => setCtaFlash(null), 1200);
    } catch (error) {
      setWorkflowStatus("error");
      setCtaFlash("error");
      window.setTimeout(() => setCtaFlash(null), 600);

      if (error instanceof DOMException && error.name === "AbortError") {
        setWorkflowMessage(
          `no response within ${WORKFLOW_REQUEST_TIMEOUT_MS / 1000}s`,
        );
      } else if (error instanceof TypeError) {
        // Generic on purpose: the full backend origin is never echoed into UI.
        setWorkflowMessage(
          "could not reach the workflow service (E_CONN) — is the backend up?",
        );
      } else {
        setWorkflowMessage(
          error instanceof Error ? error.message : "request failed",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }, [repoUrl, issueDescription]);

  /** Canvas node matching the agent reported as active, if any. */
  const activeNodeId = activeAgent ? matchAgentToNode(activeAgent) : null;
  const statusMeta = CONNECTION_STATUS_META[connectionStatus];
  const isStarting = workflowStatus === "starting";
  const repoUrlHintId = "repo-url-hint";
  const issueHintId = "issue-description-hint";
  const trimmedRepoUrl = repoUrl.trim();
  const trimmedIssueDescription = issueDescription.trim();
  // Basic shape gate: GitHub owner/repo URLs only (the server still validates).
  const isRepoUrlShapeValid =
    trimmedRepoUrl.length > 0 && REPO_URL_PATTERN.test(trimmedRepoUrl);
  const hasWorkflowInput = Boolean(
    isRepoUrlShapeValid && trimmedIssueDescription,
  );
  const isWorkflowDisabled = isStarting || !hasWorkflowInput;

  // Live validation states, rendered in magenta (cyan stays for valid/active):
  // - a non-empty repo URL that is not a GitHub owner/repo, or
  // - an issue description too short to be actionable.
  const isRepoUrlInvalid = trimmedRepoUrl.length > 0 && !isRepoUrlShapeValid;
  const isIssueInvalid =
    trimmedIssueDescription.length > 0 &&
    trimmedIssueDescription.length < ISSUE_DESCRIPTION_MIN_LENGTH;

  // Mirror the active agent onto the React Flow nodes. Nodes already in the
  // right state are returned by reference so the graph is not re-rendered on
  // every incoming log line.
  // Ambient budget: edges idle static + dim; only the active path animates.
  useEffect(() => {
    setEdges((current) =>
      current.map((edge) => edgePresentation(activeNodeId, edge)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNodeId]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const active = node.id === activeNodeId;
        return node.data.active === active
          ? node
          : { ...node, data: { ...node.data, active } };
      }),
    );
  }, [activeNodeId, setNodes]);

  const onConnect = useCallback(() => {
    // Placeholder: keep the static demo topology for now
  }, []);

  return (
    <div className="relative min-h-screen text-[#e2e8f0]">
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-5 py-10 sm:px-8 sm:py-14">
        {/* Mobile sticky CTA: the workflow action stays thumb-reachable. */}
        <div className="sticky top-3 z-20 lg:hidden">
          <div className="glass-panel frost-sheen flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={startWorkflow}
              disabled={isWorkflowDisabled}
              aria-label="Start workflow"
              className={[
                "btn-primary btn-pill inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.16em] uppercase",
                isStarting && "is-starting",
                ctaFlash === "error" && "btn-error-shake",
                workflowStatus === "error"
                  ? "border-[#ff0800]/60 text-[#ff0800]"
                  : workflowStatus === "started" || ctaFlash === "success"
                    ? "border-[#39ff14]/60 text-[#0a0b0d]"
                    : "text-[#0a0b0d]",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {WORKFLOW_BUTTON_LABEL[workflowStatus]}
            </button>
            <span className={`chip shrink-0 ${statusMeta.chipClass}`}>
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`}
              />
              {statusMeta.label}
            </span>
          </div>
        </div>

        {/* Header — console identity strip. */}
        <header className="pop-in flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="eyebrow mb-4 inline-flex items-center gap-2.5 rounded-md border border-white/40 bg-white/[0.04] px-3.5 py-1.5 backdrop-blur-2xl">
              <span className="h-1.5 w-1.5 rounded-full bg-[#39ff14] shadow-[0_0_10px_rgba(57,255,20,1)]" />
              <span className="text-[#e2e8f0]">IBM BOB 2.0</span>
              <span className="text-[#39ff14]">—</span>
              <span className="text-[#00f0ff]">NEXUS OVERDRIVE</span>
            </div>
            <h1 className="display-tight text-5xl font-black tracking-tight italic sm:text-6xl">
              <span className="title-metallic">NEXUS</span>{" "}
              <span className="display-sub text-[#00f0ff] drop-shadow-[0_0_12px_rgba(0,240,255,0.5)]">Workflow</span>
            </h1>
            <p className="body-luxe mt-4 max-w-xl text-[14px] text-[#e2e8f0]/60">
              AI-powered developer agent pipeline. Orchestrate investigation
              and autonomous remediation from a single high-performance
              console.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {["⚡ Orchestrator", "❄ Investigator", "⚡ Remediation", "❄ Validator"].map(
              (label) => (
              <span key={label} className="chip frost-sheen">
                {label}
              </span>
            ))}
          </div>
        </header>

        {/* Immersive glass container — toolbar, telemetry, form, canvas, log.
            `hud-scanlines` paints a drifting CRT raster above the glass, and
            the vignette + corner brackets frame it like a tactical screen.
            Every overlay is `pointer-events: none`, so nothing blocks clicks. */}
        <main className="glass-panel-immersive hud-scanlines relative mt-4 overflow-hidden">
          <div aria-hidden className="hud-vignette" />
          <span aria-hidden className="hud-frame hud-frame-tl" />
          <span aria-hidden className="hud-frame hud-frame-tr" />
          <span aria-hidden className="hud-frame hud-frame-bl" />
          <span aria-hidden className="hud-frame hud-frame-br" />

          {/* Console toolbar */}
          <div className="flex items-center justify-between gap-4 border-b border-white/20 px-5 py-4 sm:px-7">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff0800]/90 shadow-[0_0_8px_rgba(255,8,0,0.7)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#e2e8f0]/80" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#39ff14]/90 shadow-[0_0_8px_rgba(57,255,20,0.7)]" />
              <span className="ml-4 font-mono text-[10px] font-bold tracking-[0.28em] text-[#e2e8f0]/70 uppercase">
                agent-pipeline <span className="text-[#39ff14]">{"//"}</span>{" "}
                secure-sandbox
              </span>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <span className="chip">{nodes.length} nodes</span>
              <span className="chip">{edges.length} edges</span>
              <span className={`chip ${statusMeta.chipClass}`}>
                <span
                  className={`h-1.5 w-1.5 rounded-full ${statusMeta.dotClass}`}
                />
                {statusMeta.label}
              </span>
            </div>
          </div>

          {/* System telemetry — mocked baselines + values derived from the
              live stream, animated entirely with CSS keyframes. */}
          <TelemetryStrip
            frames={logs.length}
            bufferLimit={LOG_BUFFER_LIMIT}
            status={connectionStatus}
            degraded={Boolean(streamError) || connectionStatus === "closed"}
            activeNodeId={activeNodeId}
          />

          {/* Workflow console card: POST /api/start-workflow. */}
          <div className="border-b border-white/20 px-5 py-7 sm:px-7">
            <div className="lg:ml-auto lg:max-w-xl">
              <p className="mb-4 font-mono text-[10px] font-bold tracking-[0.3em] text-[#00f0ff] uppercase">
                ⚡ {"//"} inject mission parameters
              </p>
              <div className="grid gap-5 sm:grid-cols-2">
                <label
                  htmlFor="repo-url"
                  className="group relative block sm:col-span-2"
                >
                  <input
                    id="repo-url"
                    name="repo_url"
                    type="url"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    placeholder=" "
                    autoComplete="url"
                    maxLength={REPO_URL_MAX_LENGTH}
                    pattern="https://github.com/[^/\s]+/[^/\s]+/?"
                    title="Use a GitHub repository URL like https://github.com/owner/repo"
                    aria-describedby={repoUrlHintId}
                    aria-invalid={isRepoUrlInvalid}
                    className={`glass-input peer min-h-[52px] px-4 py-4 text-[14px] focus:ring-2 ${
                      FIELD_TONE[isRepoUrlInvalid ? "invalid" : "valid"]
                    }`}
                  />
                  <span
                    className={`pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-mono text-sm font-light tracking-[0.08em] transition-all duration-200 peer-focus:top-2 peer-focus:-translate-y-full peer-focus:text-[10px] peer-valid:top-2 peer-valid:-translate-y-full peer-valid:text-[10px] peer-placeholder-shown:top-1/2 peer-placeholder-shown:text-sm ${
                      LABEL_TONE[isRepoUrlInvalid ? "invalid" : "valid"]
                    }`}
                  >
                    Repository URL
                  </span>
                  <span
                    id={repoUrlHintId}
                    className={`mt-2 block font-mono text-[10px] font-bold tracking-[0.18em] uppercase ${
                      isRepoUrlInvalid ? "text-[#ff0800]" : "text-[#e2e8f0]/40"
                    }`}
                  >
                    {isRepoUrlInvalid
                      ? "⚠ GitHub URL required: https://github.com/owner/repo"
                      : `${repoUrl.length}/${REPO_URL_MAX_LENGTH}`}
                  </span>
                </label>

                <label
                  htmlFor="issue-description"
                  className="group relative block sm:col-span-2"
                >
                  <textarea
                    id="issue-description"
                    name="issue_description"
                    value={issueDescription}
                    onChange={(event) => setIssueDescription(event.target.value)}
                    placeholder=" "
                    rows={4}
                    maxLength={ISSUE_DESCRIPTION_MAX_LENGTH}
                    aria-describedby={issueHintId}
                    aria-invalid={isIssueInvalid}
                    className={`glass-input peer min-h-32 resize-y px-4 py-4 text-[14px] leading-[1.75] focus:ring-2 ${
                      FIELD_TONE[isIssueInvalid ? "invalid" : "valid"]
                    }`}
                  />
                  <span
                    className={`pointer-events-none absolute top-3 left-4 font-mono text-sm font-light tracking-[0.08em] transition-all duration-200 peer-focus:top-2 peer-focus:-translate-y-1 peer-focus:text-[10px] peer-valid:top-2 peer-valid:-translate-y-1 peer-valid:text-[10px] peer-placeholder-shown:top-3 peer-placeholder-shown:text-sm ${
                      LABEL_TONE[isIssueInvalid ? "invalid" : "valid"]
                    }`}
                  >
                    Bug / Issue Description
                  </span>
                  <span
                    id={issueHintId}
                    className={`mt-2 block text-right font-mono text-[10px] font-bold tracking-[0.18em] uppercase ${
                      isIssueInvalid ? "text-[#ff0800]" : "text-[#e2e8f0]/40"
                    }`}
                  >
                    {isIssueInvalid
                      ? `⚠ Add detail (${ISSUE_DESCRIPTION_MIN_LENGTH}+ chars)`
                      : `${issueDescription.length}/${ISSUE_DESCRIPTION_MAX_LENGTH}`}
                  </span>
                </label>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
                <span className="chip hidden sm:inline-flex">
                  {nodes.length} nodes / {edges.length} edges
                </span>
                {/* Fires POST /api/start-workflow; results stream over the socket */}
                <button
                  type="button"
                  onClick={startWorkflow}
                  disabled={isWorkflowDisabled}
                  className={[
                    "btn-workflow frost-sheen inline-flex min-h-[48px] shrink-0 items-center gap-2 px-5 py-2.5 font-mono text-[11px] font-black tracking-[0.16em] uppercase",
                    isStarting && "is-starting",
                    ctaFlash === "error" && "btn-error-shake",
                    workflowStatus === "started" && "active",
                    workflowStatus === "error"
                      ? "border-[#ff0800]/60 text-[#ff0800]"
                      : "text-[#0a0b0d]",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${
                      isStarting ? "animate-pulse" : ""
                    } ${
                      workflowStatus === "error"
                        ? "bg-[#ff0800]"
                        : workflowStatus === "started"
                          ? "bg-[#39ff14] shadow-[0_0_8px_rgba(57,255,20,1)]"
                          : "bg-[#0a0b0d]"
                    }`}
                  />
                  {WORKFLOW_BUTTON_LABEL[workflowStatus]}
                </button>
              </div>
            </div>
          </div>

          {workflowMessage && (
            <p
              aria-live="polite"
              className={[
                "border-b border-white/20 px-7 py-2.5 font-mono text-[11px] font-bold tracking-[0.04em] leading-relaxed",
                workflowStatus === "error"
                  ? "bg-[#ff0800]/[0.1] text-[#ff0800]"
                  : "bg-[#39ff14]/[0.08] text-[#39ff14]",
              ].join(" ")}
            >
              {workflowStatus === "error" ? "⚠ " : "⚡ "}
              {workflowMessage}
            </p>
          )}

          {/* React Flow canvas — single mounted instance: the mobile <details>
              only toggles visibility of this same graph, so typing + streaming
              never pay for two canvases. */}
          <details
            className="pipeline-details w-full bg-black/40 sm:hidden"
            open={isPipelineOpen}
            onToggle={(event) => setIsPipelineOpen(event.currentTarget.open)}
          >
            <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between px-5 py-3 font-mono text-[10px] font-bold tracking-[0.26em] text-[#e2e8f0]/80 uppercase">
              <span>⚡ Agent pipeline</span>
              <span className="chip">{activeNodeId ?? "standby"}</span>
            </summary>
          </details>
          <div
            className={`${
              isPipelineOpen ? "block" : "hidden"
            } w-full bg-black/40 sm:block`}
          >
            <div className="h-[320px] w-full sm:h-[400px] lg:h-[440px]">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                fitView
                fitViewOptions={{ padding: 0.28 }}
                minZoom={0.4}
                maxZoom={1.75}
                proOptions={{ hideAttribution: false }}
                className="!bg-transparent"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={26}
                  size={1.4}
                  color="rgba(57,255,20,0.22)"
                />
                <Controls position="bottom-right" showInteractive={false} />
                <MiniMap
                  position="top-right"
                  pannable
                  zoomable
                  style={{ width: 140, height: 96 }}
                  maskColor="rgba(1,0,10,0.75)"
                  className="hidden sm:block"
                />
              </ReactFlow>
            </div>
          </div>

          {/* Live agent log stream */}
          <AgentTerminal
            logs={logs}
            status={connectionStatus}
            activeAgent={activeAgent}
            error={streamError}
            onClear={clearLogs}
          />

          {/* Footer strip — one status card per agent. */}
          <div className="legend-carousel grid grid-cols-1 gap-3 border-t border-white/20 bg-white/[0.015] px-5 py-5 sm:grid-cols-2 sm:px-7 lg:grid-cols-4">
            {agentLegend.map((item) => {
              const isActive = item.id === activeNodeId;
              return (
                <div
                  key={item.title}
                  className={`frost-sheen flex items-center gap-3.5 rounded-lg border px-4 py-3.5 backdrop-blur-2xl transition-all duration-300 ${
                    isActive
                      ? "border-[#39ff14] bg-[#39ff14]/[0.08] shadow-[0_0_20px_rgba(57,255,20,0.35)] scale-[1.03]"
                      : "border-white/40 bg-white/[0.03] hover:border-[#00f0ff] hover:bg-white/[0.06] hover:scale-[1.04] hover:-rotate-[0.5deg]"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${item.dot} ${
                      isActive ? "" : "opacity-45"
                    }`}
                  />
                  <div>
                    <p className="text-[13px] font-black tracking-[0.04em] text-[#e2e8f0] uppercase">
                      {isActive ? `⚡ ${item.title}` : item.title}
                    </p>
                    <p className={`mt-0.5 text-xs font-medium leading-relaxed ${isActive ? "text-[#39ff14]" : "text-[#e2e8f0]/50"}`}>
                      {isActive ? "⚡ processing — streaming logs" : item.desc}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        <p className="mt-2 hidden text-center font-mono text-[10px] font-bold tracking-[0.32em] text-[#e2e8f0]/50 uppercase sm:block">
          ⚡ Drag nodes — Scroll to zoom — high-performance console
        </p>
        <p className="mt-2 text-center font-mono text-[10px] font-bold tracking-[0.32em] text-[#e2e8f0]/50 uppercase sm:hidden">
          Tap nodes — Pinch to zoom
        </p>
      </div>
    </div>
  );
}


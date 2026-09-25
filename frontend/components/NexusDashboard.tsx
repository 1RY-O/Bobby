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
];

/** Dotted connectors sampled from public/P1.png (cyan -> violet). */
const initialEdges: Edge[] = [
  {
    id: "e-orchestrator-investigator",
    source: "orchestrator",
    target: "investigator",
    animated: false,
    style: {
      stroke: "#08b6f9",
      strokeWidth: 1.6,
      strokeDasharray: "5 7",
      filter: "drop-shadow(0 0 4px rgba(8,182,249,0.55))",
    },
  },
  {
    id: "e-investigator-remediation",
    source: "investigator",
    target: "remediation",
    animated: false,
    style: {
      stroke: "#a855f7",
      strokeWidth: 1.6,
      strokeDasharray: "5 7",
      filter: "drop-shadow(0 0 4px rgba(168,85,247,0.55))",
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
    dot: "bg-cyan-300 shadow-[0_0_10px_rgba(34,211,238,1)]",
  },
  {
    id: "investigator",
    title: "Investigator",
    desc: "Scans code & gathers evidence",
    dot: "bg-violet-400 shadow-[0_0_10px_rgba(168,85,247,1)]",
  },
  {
    id: "remediation",
    title: "Remediation",
    desc: "Proposes & applies fixes",
    dot: "bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,1)]",
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
    <div className="relative min-h-screen text-slate-100">
      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
        {/* Mobile sticky CTA: the workflow action stays thumb-reachable. */}
        <div className="sticky top-3 z-20 lg:hidden">
          <div className="glass-panel flex items-center gap-3 px-4 py-3">
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
                  ? "border-rose-400/50 text-rose-100"
                  : workflowStatus === "started" || ctaFlash === "success"
                    ? "border-emerald-400/50 text-emerald-100"
                    : "text-cyan-50",
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
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-[11px] font-semibold tracking-[0.22em] text-cyan-200 uppercase backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,1)]" />
              IBM BOB 2.0 // NEXUS CONSOLE
            </div>
            <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
              <span className="bg-gradient-to-r from-cyan-300 via-sky-200 to-fuchsia-300 bg-clip-text text-transparent drop-shadow-[0_0_25px_rgba(8,182,249,0.35)]">
                NEXUS
              </span>{" "}
              <span className="text-white/90">Workflow</span>
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
              AI-powered developer agent pipeline. Orchestrate investigation and
              autonomous remediation from a single glass console.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {["Orchestrator", "Investigator", "Remediation"].map((label) => (
              <span key={label} className="chip">
                {label}
              </span>
            ))}
          </div>
        </header>

        {/* Immersive glass container — toolbar, form, canvas and log feed. */}
        <main className="glass-panel-immersive relative mt-2 overflow-hidden">
          {/* Console toolbar */}
          <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-4 sm:px-6">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[0_0_10px_rgba(255,95,87,0.8)]" />
              <span className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[0_0_10px_rgba(254,188,46,0.8)]" />
              <span className="h-3 w-3 rounded-full bg-[#28c840] shadow-[0_0_10px_rgba(40,200,64,0.8)]" />
              <span className="ml-4 font-mono text-xs tracking-[0.2em] text-slate-400 uppercase">
                agent-pipeline — sandbox
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

          {/* Workflow console card: POST /api/start-workflow. */}
          <div className="border-b border-white/10 px-4 py-5 sm:px-6">
            <div className="lg:ml-auto lg:max-w-xl">
              <div className="grid gap-3 sm:grid-cols-2">
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
                    className="glass-input peer min-h-[48px] px-4 py-4 text-sm"
                  />
                  <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 font-mono text-sm tracking-[0.15em] text-slate-400 transition-all duration-200 peer-focus:top-2 peer-focus:-translate-y-full peer-focus:text-[10px] peer-focus:text-cyan-300 peer-valid:top-2 peer-valid:-translate-y-full peer-valid:text-[10px] peer-valid:text-cyan-300 peer-placeholder-shown:top-1/2 peer-placeholder-shown:text-sm">
                    Repository URL
                  </span>
                  <span
                    id={repoUrlHintId}
                    className="mt-1.5 block font-mono text-[10px] tracking-[0.14em] text-slate-500 uppercase"
                  >
                    {trimmedRepoUrl.length > 0 && !isRepoUrlShapeValid
                      ? "Use https://github.com/owner/repo"
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
                    className="glass-input peer min-h-28 resize-y px-4 py-4 text-sm leading-6"
                  />
                  <span className="pointer-events-none absolute top-3 left-4 font-mono text-sm tracking-[0.15em] text-slate-400 transition-all duration-200 peer-focus:top-2 peer-focus:-translate-y-1 peer-focus:text-[10px] peer-focus:text-cyan-300 peer-valid:top-2 peer-valid:-translate-y-1 peer-valid:text-[10px] peer-valid:text-cyan-300 peer-placeholder-shown:top-3 peer-placeholder-shown:text-sm">
                    Bug / Issue Description
                  </span>
                  <span
                    id={issueHintId}
                    className="mt-1.5 block text-right font-mono text-[10px] tracking-[0.14em] text-slate-500 uppercase"
                  >
                    {issueDescription.length}/{ISSUE_DESCRIPTION_MAX_LENGTH}
                  </span>
                </label>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                <span className="chip hidden sm:inline-flex">
                  {nodes.length} nodes / {edges.length} edges
                </span>
                {/* Fires POST /api/start-workflow; results stream over the socket */}
                <button
                  type="button"
                  onClick={startWorkflow}
                  disabled={isWorkflowDisabled}
                  className={[
                    "btn-workflow inline-flex min-h-[48px] shrink-0 items-center gap-2 px-5 py-2.5 font-mono text-[11px] font-semibold tracking-[0.16em] uppercase",
                    isStarting && "is-starting",
                    ctaFlash === "error" && "btn-error-shake",
                    workflowStatus === "started" && "active",
                    workflowStatus === "error"
                      ? "border-rose-400/60 text-rose-100"
                      : "text-white",
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
                        ? "bg-rose-300"
                        : workflowStatus === "started"
                          ? "bg-emerald-300"
                          : "bg-cyan-200"
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
                "border-b px-6 py-2 font-mono text-[11px]",
                workflowStatus === "error"
                  ? "border-rose-400/20 bg-rose-500/10 text-rose-200"
                  : "border-emerald-400/20 bg-emerald-500/10 text-emerald-200",
              ].join(" ")}
            >
              {workflowStatus === "error" ? "⚠ " : "✓ "}
              {workflowMessage}
            </p>
          )}

          {/* React Flow canvas — single mounted instance: the mobile <details>
              only toggles visibility of this same graph, so typing + streaming
              never pay for two canvases. */}
          <details
            className="pipeline-details w-full bg-[#05001a]/60 sm:hidden"
            open={isPipelineOpen}
            onToggle={(event) => setIsPipelineOpen(event.currentTarget.open)}
          >
            <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between px-4 py-3 font-mono text-[11px] tracking-[0.2em] text-slate-300 uppercase">
              <span>Agent pipeline</span>
              <span className="chip">{activeNodeId ?? "standby"}</span>
            </summary>
          </details>
          <div
            className={`${
              isPipelineOpen ? "block" : "hidden"
            } w-full bg-[#05001a]/60 sm:block`}
          >
            <div className="h-[300px] w-full sm:h-[380px] lg:h-[420px]">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                minZoom={0.4}
                maxZoom={1.75}
                proOptions={{ hideAttribution: false }}
                className="!bg-transparent"
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={28}
                  size={1.5}
                  color="rgba(8,182,249,0.22)"
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

          {/* Footer strip — one static status card per agent. */}
          <div className="legend-carousel grid grid-cols-1 gap-3 border-t border-white/10 bg-black/30 px-4 py-4 sm:grid-cols-3 sm:px-6">
            {agentLegend.map((item) => {
              const isActive = item.id === activeNodeId;
              return (
                <div
                  key={item.title}
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md transition-colors duration-300 ${
                    isActive
                      ? "border-cyan-300/40 bg-white/[0.09] shadow-[0_0_30px_-8px_rgba(8,182,249,0.75)]"
                      : "border-white/10 bg-white/[0.04]"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${item.dot} ${
                      isActive ? "" : "opacity-60"
                    }`}
                  />
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {item.title}
                    </p>
                    <p className="text-xs text-slate-400">
                      {isActive ? "processing — streaming logs" : item.desc}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        <p className="mt-2 hidden text-center font-mono text-[11px] tracking-[0.25em] text-slate-500 uppercase sm:block">
          Drag nodes // Scroll to zoom // NEXUS glass console
        </p>
        <p className="mt-2 text-center font-mono text-[11px] tracking-[0.25em] text-slate-500 uppercase sm:hidden">
          Tap nodes // Pinch to zoom
        </p>
      </div>
    </div>
  );
}


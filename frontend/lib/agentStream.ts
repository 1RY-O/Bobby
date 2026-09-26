/**
 * Wire contract for the backend LangGraph agent stream (`WS /ws/agent-stream`).
 *
 * Frames look like:
 *   {"agent": "investigator", "action": "Analyzing stack trace...", "status": "active"}
 *
 * This module keeps parsing/normalisation out of the React components so the
 * dashboard only deals with `AgentLog` objects and plain string statuses.
 */

export type AgentAccent = "cyan" | "violet" | "emerald" | "magenta";

/**
 * Node ids declared in the dashboard topology / React Flow canvas.
 * Mirrors the backend graph: orchestrator -> investigator -> remediation ->
 * validator (see backend/agents/graph.py).
 */
export type AgentNodeId =
  | "orchestrator"
  | "investigator"
  | "remediation"
  | "validator";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Lifecycle of the POST /api/start-workflow request. */
export type WorkflowStatus = "idle" | "starting" | "started" | "error";

export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

export interface AgentLog {
  /** Client-side id so React keys stay stable across buffer trims. */
  id: string;
  receivedAt: number;
  /** Agent that reported, exactly as sent by the backend. */
  agent: string;
  /** Human-readable progress line (from `action`, falling back to `message`). */
  action: string;
  /** Raw lifecycle status from the frame ("active", "done", ...) or "". */
  status: string;
  level: LogLevel;
  type: string;
}

/**
 * Endpoints appended to the configured base origins. Kept here (not inlined at
 * call sites) so the env contract and the paths it resolves to live together.
 */
export const API_PATH = "/api/start-workflow";
export const AGENT_STREAM_PATH = "/ws/agent-stream";

/**
 * Sentinel returned when a base origin is missing, blank, unparsable or
 * carries a scheme the browser cannot use. Fail-closed: without a configured
 * absolute origin the UI shows an explicit configuration error rather than
 * silently building a URL that would 404 against the frontend host.
 */
export const AGENT_STREAM_UNCONFIGURED = "__AGENT_STREAM_UNCONFIGURED__";

/** Trim whitespace and every trailing slash from a configured origin. */
export function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Base origins of the API and the agent stream.
 *
 * These MUST be read as direct `process.env.NEXT_PUBLIC_*` member accesses.
 * Next.js performs a literal, per-identifier substitution at build time; it does
 * not inline a computed lookup such as `process.env[name]` or a
 * `process.env[dynamicKey]` helper, so that form silently evaluates to
 * `undefined` in the client bundle and the app would fail closed on a
 * correctly-configured deployment. Keep the accesses static.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_URL ?? "";

/** Full workflow endpoint: `${NEXT_PUBLIC_API_URL}/api/start-workflow`. */
export const WORKFLOW_START_URL = resolveApiUrl(stripTrailingSlashes(API_BASE_URL));

/** Full agent-stream endpoint: `${NEXT_PUBLIC_WS_URL}/ws/agent-stream`. */
export const AGENT_STREAM_URL = resolveAgentStreamUrl(
  stripTrailingSlashes(WS_BASE_URL),
);

/** Generic, non-disclosing transport failure shown in the UI. */
export const AGENT_STREAM_ERROR_MESSAGE =
  "agent stream unavailable (E_CONN) — retrying";

/**
 * Join a configured base origin with an endpoint path, normalising the seam
 * so a trailing slash in the env var can never produce `//api/...` (a 404 on
 * most proxies) or a missing separator.
 */
function joinEndpoint(base: string, path: string): string | null {
  const cleanBase = stripTrailingSlashes(base);
  if (!cleanBase) return null;
  try {
    const url = new URL(cleanBase);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = stripTrailingSlashes(url.pathname) + path;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** True when the workflow POST endpoint is not configured (fail closed). */
export function isApiUrlUnconfigured(url: string): boolean {
  return url === AGENT_STREAM_UNCONFIGURED;
}

/**
 * Normalize the configured stream base into an absolute `ws(s)://…/ws/agent-stream`.
 *
 * - `http(s)` bases are upgraded to `ws(s)` (https → wss, never a downgrade).
 * - `ws://` / `wss://` bases are accepted as-is.
 * - A base that already includes the path is left alone (idempotent).
 * - Anything else — blank, relative, or a non-http(s) scheme like `javascript:`
 *   or the literal `null` — returns the sentinel so the UI surfaces E_CONFIG.
 */
export function resolveAgentStreamUrl(raw: string): string {
  const value = stripTrailingSlashes(raw);
  if (!value) return AGENT_STREAM_UNCONFIGURED;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return AGENT_STREAM_UNCONFIGURED;
  }

  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return AGENT_STREAM_UNCONFIGURED;
  }

  const path = stripTrailingSlashes(url.pathname);
  if (!path.endsWith(AGENT_STREAM_PATH)) {
    url.pathname = path + AGENT_STREAM_PATH;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Resolve the workflow POST endpoint from an API base origin. */
export function resolveApiUrl(raw: string): string {
  return joinEndpoint(raw, API_PATH) ?? AGENT_STREAM_UNCONFIGURED;
}

/** True when the stream must not be attempted (explicitly unconfigured). */
export function isAgentStreamUnconfigured(url: string): boolean {
  return url === AGENT_STREAM_UNCONFIGURED;
}

/**
 * Never upgrade an https page to a plaintext ws:// socket (mixed content),
 * and never let a plaintext page open a wss:// socket in dev.
 */
export function isAgentStreamUrlAllowed(url: string): boolean {
  if (typeof window === "undefined") return true;
  if (isAgentStreamUnconfigured(url)) return false;
  const pageIsSecure = window.location.protocol === "https:";
  return pageIsSecure ? url.startsWith("wss://") : true;
}

/** Give up on the start-workflow request after this long. */
export const WORKFLOW_REQUEST_TIMEOUT_MS = 10_000;

/** Hard cap on retained log lines so a chatty agent can't grow memory forever. */
export const LOG_BUFFER_LIMIT = 200;

/** Node ids in canvas order (must match the backend graph stages). */
export const AGENT_NODE_IDS: readonly AgentNodeId[] = [
  "orchestrator",
  "investigator",
  "remediation",
  "validator",
];

/** Case/format-insensitive key so "Investigator" and "investigator" agree. */
export function normalizeAgentId(agent: string): string {
  return agent.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extra names the workflow might use for a canvas node. Frames whose agent is
 * neither a node id nor listed here (e.g. the "system" heartbeat) map to null
 * and so never move the highlight.
 */
const AGENT_NODE_ALIASES: Record<string, AgentNodeId> = {
  orchestration: "orchestrator",
  planner: "orchestrator",
  router: "orchestrator",
  supervisor: "orchestrator",
  investigation: "investigator",
  inspector: "investigator",
  scanner: "investigator",
  analyzer: "investigator",
  remediator: "remediation",
  patcher: "remediation",
  fixer: "remediation",
  validation: "validator",
  verifier: "validator",
  auditor: "validator",
  checker: "validator",
  qa: "validator",
  guard: "validator",
};

/** Resolve the canvas node a reported agent belongs to (null when foreign). */
export function matchAgentToNode(agent: string): AgentNodeId | null {
  const key = normalizeAgentId(agent);
  const direct = AGENT_NODE_IDS.find((id) => id === key);
  return direct ?? AGENT_NODE_ALIASES[key] ?? null;
}

/**
 * Statuses that mean "this agent is working right now" -> glow its node.
 *
 * Matched twice: first as an exact set member (the documented vocabulary),
 * then as a substring of the normalised key. The substring pass is what makes
 * prefixed/suffixed frames work — the backend emits both bare verbs
 * ("started") and agent-qualified ones ("remediation_started", "working").
 */
const ACTIVE_STATUSES = new Set([
  "active",
  "running",
  "started",
  "start",
  "processing",
  "inprogress",
  "working",
  "busy",
]);

const ACTIVE_MARKERS = [
  "active",
  "running",
  "start",
  "process",
  "inprogress",
  "working",
  "busy",
  "pending",
];

/**
 * Statuses that mean "this agent stopped" -> drop its glow.
 *
 * Completion frames are agent-qualified in this backend
 * ("orchestrator_complete", "investigator_complete", "remediation_complete",
 * "validation_failed"), so an exact-match set alone can never de-energise a
 * node on its *own* completion frame — it would wait for the next agent to
 * report "active". Substring matching fixes that.
 */
const FINISHED_STATUSES = new Set([
  "idle",
  "done",
  "complete",
  "completed",
  "finished",
  "success",
  "succeeded",
  "stopped",
  "error",
  "failed",
  "failure",
]);

/**
 * Note on deliberate tolerance:
 * - "pass"/"passed" covers the validator's outcome frames.
 * - "complete" also matches "incomplete": either way the agent has stopped
 *   working, so de-energising its node is the correct visual.
 */
const FINISHED_MARKERS = [
  "idle",
  "done",
  "complete",
  "finish",
  "success",
  "succeed",
  "stopped",
  "stop",
  "error",
  "fail",
  "pass",
];

/**
 * True when the frame says the reporting agent is currently working.
 *
 * Failure/completion wins over activity, so a frame such as
 * "validation_failed" can never leave a node glowing.
 */
export function isActiveStatus(status: string): boolean {
  const key = normalizeAgentId(status);
  if (!key) return false;
  if (isFinishedKey(key)) return false;
  if (ACTIVE_STATUSES.has(key)) return true;
  return ACTIVE_MARKERS.some((marker) => key.includes(marker));
}

/** True when the frame says the reporting agent has stopped. */
export function isFinishedStatus(status: string): boolean {
  return isFinishedKey(normalizeAgentId(status));
}

function isFinishedKey(key: string): boolean {
  if (!key) return false;
  if (FINISHED_STATUSES.has(key)) return true;
  return FINISHED_MARKERS.some((marker) => key.includes(marker));
}

const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "success",
  "warn",
  "error",
];

/**
 * Log level for the terminal: an explicit `level` field wins, otherwise it is
 * inferred from the lifecycle status so "done"/"failed" colour correctly.
 */
function toLogLevel(value: unknown, status: string): LogLevel {
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (normalised === "warning") return "warn";
    if (["err", "critical", "fatal"].includes(normalised)) return "error";
    if (LOG_LEVELS.includes(normalised as LogLevel)) {
      return normalised as LogLevel;
    }
  }

  const key = normalizeAgentId(status);
  if (["error", "failed", "failure"].includes(key)) return "error";
  if (["warn", "warning", "retrying"].includes(key)) return "warn";
  if (
    ["done", "complete", "completed", "finished", "success", "succeeded"].includes(
      key,
    )
  ) {
    return "success";
  }

  return "info";
}

/**
 * Turns a raw WebSocket frame into a normalised `AgentLog`.
 *
 * Understands the documented `{agent, action, status}` shape and tolerates
 * extras: `message` is used when `action` is absent, `level` is optional, and
 * non-JSON frames are surfaced as plain lines instead of being dropped.
 */
export function normalizeAgentLog(payload: unknown, id: string): AgentLog | null {
  let decoded: unknown = payload;

  if (typeof payload === "string") {
    try {
      decoded = JSON.parse(payload);
    } catch {
      decoded = { action: payload };
    }
  }

  if (decoded === null || typeof decoded !== "object") return null;

  const record = decoded as Record<string, unknown>;

  const rawAgent = typeof record.agent === "string" ? record.agent.trim() : "";
  const status = typeof record.status === "string" ? record.status.trim() : "";

  const action =
    typeof record.action === "string"
      ? record.action
      : typeof record.message === "string"
        ? record.message
        : JSON.stringify(record);

  return {
    id,
    receivedAt: Date.now(),
    agent: rawAgent || "system",
    action,
    status,
    level: toLogLevel(record.level, status),
    type: typeof record.type === "string" ? record.type : "log",
  };
}

/** Shared status presentation used by the toolbar badge and the terminal. */
export const CONNECTION_STATUS_META: Record<
  ConnectionStatus,
  { label: string; chipClass: string; dotClass: string }
> = {
  connecting: {
    label: "CONNECTING",
    chipClass: "border-white/10 bg-white/[0.04] text-amber-200/90",
    dotClass: "bg-amber-200/90 animate-pulse",
  },
  open: {
    label: "STREAM LIVE",
    chipClass: "border-white/10 bg-white/[0.04] text-slate-200",
    dotClass: "bg-emerald-200/90",
  },
  closed: {
    label: "OFFLINE",
    chipClass: "border-white/10 bg-white/[0.04] text-slate-400",
    dotClass: "bg-rose-300/80",
  },
};

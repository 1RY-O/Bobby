import type { NextConfig } from "next";

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";

/**
 * `next dev` needs eval for React Fast Refresh and inline/eval'd scripts for
 * the HMR runtime, and it may talk to a backend on any local port. None of that
 * is acceptable in a production response, so the two directives that carry the
 * dev-only permissions are built conditionally rather than always shipped.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Backend origin reduced to scheme + host + port, for `connect-src`.
 *
 * The browser only ever talks to the backend directly when a NEXT_PUBLIC_*
 * override bypasses the same-origin proxy. With the default deployment the
 * page calls same-origin /api and /ws, which 'self' already covers, so nothing
 * needs to be added. Keeping this conditional stops the policy from quietly
 * widening to a second origin that the app never actually calls.
 */
const CROSS_ORIGIN_BACKEND = (() => {
  const overridden = Boolean(
    process.env.NEXT_PUBLIC_WORKFLOW_START_URL ||
      process.env.NEXT_PUBLIC_AGENT_STREAM_URL,
  );
  if (!overridden) return null;
  try {
    return new URL(BACKEND_ORIGIN).origin;
  } catch {
    return null;
  }
})();

const CONNECT_SRC = [
  "'self'",
  ...(CROSS_ORIGIN_BACKEND ? [CROSS_ORIGIN_BACKEND] : []),
  // Dev additionally needs raw-scheme sockets and HMR on an ephemeral port.
  ...(IS_PRODUCTION
    ? []
    : [
        "ws:",
        "http:",
        "https:",
        "http://localhost:*",
        "https://localhost:*",
        "http://127.0.0.1:*",
        "https://127.0.0.1:*",
      ]),
].join(" ");


/**
 * Defense-in-depth response headers for every route.
 *
 * Notes:
 * - `style-src 'unsafe-inline'` is required by React Flow / Tailwind runtime
 *   inline styles. It stays in production because the graph positions nodes
 *   with inline style attributes.
 * - `script-src` drops `'unsafe-eval'` in production: only `next dev`'s Fast
 *   Refresh needs it, and eval is a direct XSS-to-RCE primitive.
 * - `connect-src` is same-origin in production. The browser reaches the API
 *   through the Next proxy, so no backend host needs to be allowlisted unless
 *   the app is configured to call the backend cross-origin.
 * - `frame-ancestors 'none'` blocks clickjacking by refusing to be iframed.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  // HSTS is ignored by browsers over plain http, so it is only sent in
  // production where the deployment is expected to be behind TLS.
  ...(IS_PRODUCTION
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // 'unsafe-inline' covers the small inline bootstrap Next emits; the
      // nonce/hash route is not available without a custom server here.
      `script-src 'self' 'unsafe-inline'${IS_PRODUCTION ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src ${CONNECT_SRC}`,
      "worker-src 'self' blob:",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  /**
   * Same-origin escape hatch for the workflow API.
   *
   * The dashboard POSTs to NEXT_PUBLIC_WORKFLOW_START_URL, which defaults to
   * the same-origin path /api/start-workflow. Next.js proxies it server-side
   * to BACKEND_ORIGIN so the browser never needs a cross-origin request (and
   * production never ships a hardcoded localhost URL in the bundle).
   * Set NEXT_PUBLIC_WORKFLOW_START_URL only to override (e.g. direct backend).
   */
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_ORIGIN}/api/:path*`,
      },
      {
        // Same-origin WebSocket proxy: the browser opens
        // ws(s)://<host>/ws/agent-stream and Next forwards the upgrade to the
        // FastAPI backend, keeping the bundle free of hardcoded backend URLs.
        source: "/ws/:path*",
        destination: `${BACKEND_ORIGIN}/ws/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;

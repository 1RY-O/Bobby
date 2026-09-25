import type { NextConfig } from "next";

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";

/**
 * Defense-in-depth response headers for every route.
 *
 * Notes:
 * - `style-src 'unsafe-inline'` is required by React Flow / Tailwind runtime
 *   inline styles; `script-src 'unsafe-eval'` keeps Next dev HMR working.
 * - `connect-src` intentionally allows same-origin plus local/dev sockets so
 *   the dashboard can reach the FastAPI backend in development. In production
 *   the app uses same-origin `/api/*` + an explicitly configured `wss:` URL.
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
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' ws: wss: http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*",
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

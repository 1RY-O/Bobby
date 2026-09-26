import type { NextConfig } from "next";

/**
 * `next dev` needs eval for React Fast Refresh and inline/eval'd scripts for
 * the HMR runtime, and it may talk to a backend on any local port. None of that
 * is acceptable in a production response, so the two directives that carry the
 * dev-only permissions are built conditionally rather than always shipped.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

/**
 * Configured backend origins, read from the same env vars the browser bundle
 * uses. These exist so the CSP can allowlist exactly the hosts the app will
 * actually contact — the browser talks to Render directly (cross-domain), so
 * `connect-src` must name those origins explicitly.
 */
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();
const WS_BASE_URL = (process.env.NEXT_PUBLIC_WS_URL ?? "").trim();

/**
 * `connect-src` allowlist: the configured API + WebSocket origins (scheme +
 * host only), plus the same dev-only relaxations. No wildcard and no bare
 * `ws:`/`https:` in production — that would allow exfiltration to any host.
 */
const CONNECT_SRC = [
  "'self'",
  // Deduplicated: with a single Render service the API and WS origins are
  // identical, and CSP does not need the repeat.
  ...Array.from(
    new Set(
      [API_BASE_URL, WS_BASE_URL]
        .map((value) => {
          if (!value) return null;
          try {
            return new URL(value).origin;
          } catch {
            return null;
          }
        })
        .filter((origin): origin is string => origin !== null),
    ),
  ),
  ...(IS_PRODUCTION
    ? []
    : [
        // `next dev` HMR opens a socket on an ephemeral port and proxies the
        // app through localhost; allow the usual loopback + any local port.
        "ws:",
        "wss:",
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
 * - `connect-src` names the explicit Render origins (see above) in addition
 *   to `'self'`, because the browser opens the WebSocket and POSTs directly
 *   cross-domain. There is no Next proxy in front of them.
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
   * No rewrites / proxying.
   *
   * The frontend (Vercel) and the backend (Render) are separate origins and
   * the browser talks to the backend directly via NEXT_PUBLIC_API_URL /
   * NEXT_PUBLIC_WS_URL. Proxying /api and /ws through the Next server would
   * (a) reintroduce a same-origin fallback that 404s the moment the env vars
   * are missing and (b) not actually work for the WebSocket on a serverless
   * runtime anyway. The CSP above is the single source of truth for which
   * backend origins the browser may reach.
   */
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

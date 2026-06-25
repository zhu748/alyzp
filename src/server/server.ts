/**
 * Bun.serve server setup with routing and proxy API key auth.
 * Includes admin dashboard routes.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { handleChatCompletions, handleListModels } from "./routes-openai.js";
import { handleMessages } from "./routes-anthropic.js";
import { handleResponses } from "./routes-responses.js";
import { errorResponse } from "../proxy/handler.js";
import { handleAdminRoute, type AdminOptions } from "../admin/api.js";
import { timingSafeEqual } from "../utils/crypto.js";

export interface ServerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override fetch for testing. */
  fetchImpl?: typeof fetch;
  /** Path to the config file (for admin dashboard save). */
  configPath?: string;
}

/** Create a Bun.serve-compatible fetch handler. */
export function createFetchHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const { config, auth } = opts;
  const proxyOpts = { config, auth, fetchImpl: opts.fetchImpl };
  const corsAllow = config.corsAllowList;

  const adminOpts: AdminOptions = {
    config,
    auth,
    configPath: opts.configPath ?? "config.yaml",
    startTime: Date.now(),
  };

  // Pre-compute the health response body — it only depends on config.provider,
  // which doesn't change between requests (hot-swap of provider updates the
  // config object in place, so we read it lazily inside the handler instead
  // of caching the string — keeps the response correct after hot-swap).
  const healthResponse = (): Response => new Response(
    JSON.stringify({ status: "ok", provider: config.provider }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  // Static route table — O(1) lookup by `${method}:${path}`.
  // Admin routes (/admin, /admin/api/*) are handled separately because they
  // use prefix matching rather than exact match.
  //
  // The Map is built ONCE when createFetchHandler is called — the closures
  // capture `proxyOpts` (which is stable). The per-request `req` is passed as
  // a parameter to each handler, so no mutation is needed.
  type RouteHandler = (req: Request) => Promise<Response> | Response;
  const routes = new Map<string, RouteHandler>([
    ["GET:/health", (req) => addCorsHeaders(healthResponse(), req, corsAllow)],
    ["GET:/healthz", (req) => addCorsHeaders(healthResponse(), req, corsAllow)],
    ["GET:/", (req) => addCorsHeaders(healthResponse(), req, corsAllow)],
    ["GET:/v1/models", (req) => addCorsHeaders(handleListModels(), req, corsAllow)],
    ["POST:/v1/chat/completions", async (req) => addCorsHeaders(await handleChatCompletions(req, proxyOpts), req, corsAllow)],
    ["POST:/v1/messages", async (req) => addCorsHeaders(await handleMessages(req, proxyOpts), req, corsAllow)],
    ["POST:/v1/responses", async (req) => addCorsHeaders(await handleResponses(req, proxyOpts), req, corsAllow)],
  ]);

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight — short-circuit before auth
    if (method === "OPTIONS") {
      return corsResponse(req, corsAllow);
    }

    // Admin dashboard routes (handled before proxy API key auth).
    // Admin page itself is open; API routes use proxyApiKey.
    if (path === "/admin" || path === "/admin/" || path.startsWith("/admin/api/")) {
      const adminResp = await handleAdminRoute(req, adminOpts);
      if (adminResp) return addCorsHeaders(adminResp, req, corsAllow);
    }

    // Health checks are ALWAYS open — Render/Fly/Cloud Run/K8s probes don't
    // send Authorization headers, and returning 401 here causes the platform
    // to mark the service as unhealthy and restart it in a loop. The health
    // response leaks no sensitive info (just `{status:"ok", provider}`).
    // Both `/health` (legacy) and `/healthz` (K8s convention) work.
    if (path === "/health" || path === "/healthz" || path === "/") {
      return addCorsHeaders(healthResponse(), req, corsAllow);
    }

    // Proxy API key auth (if configured) — applies to all non-admin, non-health routes
    if (config.auth.proxyApiKey) {
      const authHeader = req.headers.get("authorization") ?? req.headers.get("x-api-key");
      if (!authHeader || !checkProxyKey(authHeader, config.auth.proxyApiKey)) {
        return addCorsHeaders(errorResponse(401, "authentication_error", "Invalid or missing proxy API key"), req, corsAllow);
      }
    }

    // --- Static route lookup (O(1)) ---
    const handler = routes.get(`${method}:${path}`);
    if (handler) {
      return await handler(req);
    }

    return addCorsHeaders(errorResponse(404, "not_found_error", `No route for ${method} ${path}`), req, corsAllow);
  };
}

/** Start the Bun.serve server. Returns the server instance. */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createFetchHandler(opts);
  const { port, host } = opts.config.server;

  return Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0, // 自用代理：禁用空闲超时，避免长 reasoning 的 LLM 请求被杀
    fetch(req) {
      // CORS headers are already added inside the handler (see
      // createFetchHandler) — no need to add them again here.
      return handler(req);
    },
  });
}

/**
 * Check whether the client provided the correct proxy API key.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function checkProxyKey(authHeader: string, expected: string): boolean {
  // Accept "Bearer {key}" or bare key
  const trimmed = authHeader.trim();
  let provided: string;
  if (trimmed.startsWith("Bearer ")) {
    provided = trimmed.slice(7).trim();
  } else {
    provided = trimmed;
  }
  return timingSafeEqual(provided, expected);
}

/** Build a CORS preflight response. */
function corsResponse(req: Request, allowList?: string[]): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req, allowList),
  });
}

/** Add CORS headers to an existing response (non-mutating). */
function addCorsHeaders(resp: Response, req: Request, allowList?: string[]): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(req, allowList))) {
    headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function corsHeaders(req: Request, allowList?: string[]): Record<string, string> {
  // Echo the requesting Origin only when it's been explicitly allowed, OR
  // when no allowlist is configured (preserving the old permissive behavior
  // for backwards compatibility). When the origin is NOT in the allowlist,
  // we return "null" — which prevents the browser from reading the response
  // cross-origin.
  //
  // We do NOT use Access-Control-Allow-Credentials, so cookies are not sent
  // cross-origin — API auth is via Authorization header only.
  //
  // When no Origin header is present (server-to-server / curl), fall back to
  // "*" for compatibility with simple clients.
  const origin = req.headers.get("origin");
  let allowOrigin: string;
  if (!origin) {
    allowOrigin = "*";
  } else if (allowList && allowList.length > 0) {
    // Allowlist configured — only echo if origin is in the list (case-insensitive).
    allowOrigin = allowList.some(o => o.toLowerCase() === origin.toLowerCase()) ? origin : "null";
  } else {
    // No allowlist configured — preserve old permissive behavior (echo anything).
    // Document this in README so operators can lock down via ZCODE_PROXY_CORS_ALLOWLIST.
    allowOrigin = origin;
  }
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

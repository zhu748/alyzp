/**
 * Admin dashboard API routes — provides CRUD endpoints for the web UI.
 *
 * All routes require the proxy API key (same key used by API clients).
 * Mounted under /admin/api/* in server.ts.
 */
import type { ProxyConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential as AppCredential } from "../auth/types.js";
import { loadCredential, saveCredential, clearCredential, listAccounts, switchAccount, removeAccount, setAccountLabel, setAccountPlan, setAccountProxy, setAccountName, setAccountEmail, setAccountDisabled, exportSingleAccount, exportAccounts, exportStore, importAccounts, maskApiKey, invalidateStoreCache } from "../auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "../auth/oauth.js";
import { KeyResolver } from "../auth/resolver.js";
import { queryQuota } from "../auth/quota.js";
import { readZCodeImport, detectZCodeProvider, listAvailableZCodeImports } from "../auth/zcode-config.js";
import { errorResponse } from "../proxy/handler.js";
import { timingSafeEqual } from "../utils/crypto.js";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { MODELS as GLM_CATALOG } from "../provider/models.js";
import { stringify as stringifyYaml } from "yaml";
// Inline the dashboard HTML at build time so it works inside a
// `bun build --compile` single-file executable. Runtime `readFileSync`
// would resolve to the exe's virtual root (e.g. B:\~BUN\root\) and fail
// with ENOENT because dashboard.html is not shipped next to the exe.
import dashboardHtml from "./dashboard.html.txt" with { type: "text" };

export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
  /**
   * Optional fetch override for outbound requests made by admin handlers
   * (currently used by /admin/api/accounts/proxy-test). Defaults to the
   * global fetch. Test code passes a mock here to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
}

// In-memory stats collector.
//
// `requestIndex` is a Map<id, idx> kept alongside `stats.requests` so that
// dedup lookups (recordStat called with an id we've already seen on the retry
// path) are O(1) instead of O(n). At 200 entries × 100 req/s the old findIndex
// approach ran 20k string compares/sec; the Map version runs 100.
//
// vceshi0.0.7+: `seenIds` is a lifetime Set of ids we've already counted.
// Once a request id is evicted from `requestIndex` (via the 200-entry trim),
// retries that arrive later would otherwise be misclassified as new requests
// and inflate the totals. `seenIds` lets us detect this case and update the
// existing totals without creating a duplicate `requests[]` entry.
//
// The Set is bounded by `SEEN_IDS_LIMIT` (default 5000) — beyond that, we
// accept the small risk of double-counting ancient retries in exchange for
// bounded memory. 5000 ids at ~50 bytes each is ~250KB.
const SEEN_IDS_LIMIT = 5000;
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  retried: 0,
  requests: [] as Array<{ id: string; time: string; model: string; status: number; ttfb: string; tokens: string; inputTokens: string; retried?: boolean }>,
  models: {} as Record<string, { count: number; avgTtfb: number; tokens: number; inputTokens: number }>,
  // vceshi0.0.6+: per-credential usage stats (in-memory, reset on restart).
  // Keyed by maskApiKey(apiKey) to avoid leaking plaintext keys in stats.
  // The dashboard joins this with listAccounts (which has apiKeyMask) to
  // display "使用次数" per account.
  byCredential: {} as Record<string, { count: number; inputTokens: number; outputTokens: number; lastUsed: string }>,
};
const requestIndex = new Map<string, number>();
const seenIds = new Set<string>();

/**
 * Record a request for stats. Called from handler.ts printRow.
 *
 * Dedup: each request id is recorded at most once. Subsequent calls with
 * the same id (e.g. when printRow fires on the retry path) only refresh
 * the existing entry's status/tokens — they do NOT inflate the counters.
 * This fixes the previous bug where a single 529-then-200 request would
 * show up as 2 requests in the stats.
 *
 * vceshi0.0.6+: `inputTokens` and `credentialKey` fields added.
 * - inputTokens: from upstream usage.input_tokens / prompt_tokens
 * - credentialKey: maskApiKey(cred.apiKey) for per-credential usage tracking
 */
export function recordStat(entry: { id: string; time: string; model: string; status: number; ttfb: string; tokens: string; inputTokens?: string; credentialKey?: string; retried?: boolean }) {
  const existingIdx = requestIndex.get(entry.id);
  if (existingIdx !== undefined) {
    // Update the existing entry — do NOT increment counters again.
    const old = stats.requests[existingIdx];
    // Re-classify if the status changed (e.g. 529 → 200 after retry).
    const wasSuccess = old.status >= 200 && old.status < 300;
    const isSuccess = entry.status >= 200 && entry.status < 300;
    if (wasSuccess !== isSuccess) {
      if (isSuccess) { stats.failed--; stats.success++; }
      else { stats.success--; stats.failed++; }
    }
    // Always count retry flag — the final entry wins.
    if (entry.retried && !old.retried) stats.retried++;
    // vceshi0.0.7+: if the success classification flipped to success, the
    // byCredential counter (which only counts successes) was previously
    // skipped on the original failed recordStat call. Now that it succeeded,
    // we must increment byCredential to reflect the actual upstream usage.
    // Conversely, if it flipped from success to failure, the credential
    // didn't actually serve the request successfully — but we don't decrement
    // because the original increment already happened (decrementing would
    // risk going negative on edge cases).
    if (!wasSuccess && isSuccess && entry.credentialKey) {
      const c = stats.byCredential[entry.credentialKey] ?? { count: 0, inputTokens: 0, outputTokens: 0, lastUsed: "" };
      c.count++;
      c.inputTokens += parseInt(entry.inputTokens ?? "0") || 0;
      c.outputTokens += parseInt(entry.tokens) || 0;
      c.lastUsed = entry.time;
      stats.byCredential[entry.credentialKey] = c;
    }
    stats.requests[existingIdx] = {
      ...old,
      ...entry,
      inputTokens: entry.inputTokens ?? old.inputTokens ?? "0",
      retried: entry.retried || old.retried,
    };
    return;
  }

  // vceshi0.0.7+: even if the entry was evicted from requestIndex (by the
  // 200-entry trim below), check the lifetime seenIds set to avoid double-
  // counting. The retry's status update still flows through to the totals
  // (re-classifying success↔failed), but we don't create a new requests[]
  // row for it.
  if (seenIds.has(entry.id)) {
    // We've seen this id before but it was evicted from requestIndex.
    // Update totals based on the diff (assuming the previous state was
    // either success or failed — we can't know which, so we conservatively
    // treat this as a new failure→success re-classification IF the current
    // status is success and we have a credentialKey (the common case is a
    // retried request that now succeeded). For the rarer success→failure
    // case (server gave 200 then retried and got 529 — unusual), we
    // under-count failures, which is acceptable.
    if (entry.status >= 200 && entry.status < 300) stats.success++;
    else stats.failed++;
    if (entry.retried) stats.retried++;
    // Don't double-count total — it was already counted on first sighting.
    return;
  }

  const idx = stats.requests.length;
  stats.total++;
  if (entry.status >= 200 && entry.status < 300) stats.success++;
  else stats.failed++;
  if (entry.retried) stats.retried++;
  const fullEntry = { ...entry, inputTokens: entry.inputTokens ?? "0" };
  stats.requests.push(fullEntry);
  requestIndex.set(entry.id, idx);
  // vceshi0.0.7+: track lifetime-seen ids to handle post-trim retries.
  seenIds.add(entry.id);
  // Bound the seenIds set to prevent unbounded memory growth on long-lived
  // servers. We use a simple "drop the whole set and rebuild from current
  // requestIndex" strategy when the limit is hit — this loses dedup for
  // very old ids but is acceptable (the comment above explains the tradeoff).
  if (seenIds.size > SEEN_IDS_LIMIT) {
    seenIds.clear();
    for (let i = 0; i < stats.requests.length; i++) {
      seenIds.add(stats.requests[i].id);
    }
  }
  if (stats.requests.length > 200) {
    // Drop the oldest 100 entries; rebuild the index from the survivors.
    stats.requests = stats.requests.slice(-100);
    requestIndex.clear();
    for (let i = 0; i < stats.requests.length; i++) {
      requestIndex.set(stats.requests[i].id, i);
    }
  }
  // vceshi0.0.7+: cap the models map to prevent unbounded growth when
  // clients send many distinct model names (e.g. arbitrary strings via
  // custom mappings). 100 distinct models is more than enough for any
  // realistic deployment; beyond that, aggregate into "_other".
  const MAX_MODELS = 100;
  if (Object.keys(stats.models).length >= MAX_MODELS && !stats.models[entry.model]) {
    // Aggregate the new model under "_other" rather than creating a new entry.
    const other = stats.models["_other"] ?? { count: 0, avgTtfb: 0, tokens: 0, inputTokens: 0 };
    other.count++;
    const ttfbMs = parseInt(entry.ttfb) || 0;
    other.avgTtfb = Math.round((other.avgTtfb * (other.count - 1) + ttfbMs) / other.count);
    other.tokens += parseInt(entry.tokens) || 0;
    other.inputTokens += parseInt(fullEntry.inputTokens) || 0;
    stats.models["_other"] = other;
  } else {
    const m = stats.models[entry.model] ?? { count: 0, avgTtfb: 0, tokens: 0, inputTokens: 0 };
    m.count++;
    const ttfbMs = parseInt(entry.ttfb) || 0;
    m.avgTtfb = Math.round((m.avgTtfb * (m.count - 1) + ttfbMs) / m.count);
    m.tokens += parseInt(entry.tokens) || 0;
    m.inputTokens += parseInt(fullEntry.inputTokens) || 0;
    stats.models[entry.model] = m;
  }

  // vceshi0.0.6+: per-credential usage tracking (in-memory).
  // Only count successful requests toward credential usage — failed requests
  // didn't actually consume the credential's quota.
  // vceshi0.0.7+: no cap needed here — byCredential is keyed by maskApiKey
  // which is bounded by the number of stored accounts (typically < 20).
  if (entry.credentialKey && entry.status >= 200 && entry.status < 300) {
    const c = stats.byCredential[entry.credentialKey] ?? { count: 0, inputTokens: 0, outputTokens: 0, lastUsed: "" };
    c.count++;
    c.inputTokens += parseInt(fullEntry.inputTokens) || 0;
    c.outputTokens += parseInt(entry.tokens) || 0;
    c.lastUsed = entry.time;
    stats.byCredential[entry.credentialKey] = c;
  }
}

/**
 * Reset the in-memory stats collector. Exposed for unit tests so they can
 * start from a clean state without polluting each other. Not part of the
 * public API — production callers should use `DELETE /admin/api/stats`.
 * @internal
 */
export function _resetStatsForTesting(): void {
  stats.total = 0;
  stats.success = 0;
  stats.failed = 0;
  stats.retried = 0;
  stats.requests = [];
  stats.models = {};
  stats.byCredential = {};
  requestIndex.clear();
  seenIds.clear();
}

// Active OAuth flows (in-memory)
const activeFlows = new Map<string, { provider: string; flowId: string; pollToken: string; expiresAt: number; plan?: string; status?: string; error?: string; callbackUrl?: string; state?: string }>();

// vceshi0.0.7+: Per-account quota result cache. Keyed by account id.
// Used by /admin/api/accounts/quota to rate-limit upstream billing queries.
// Bounded to 50 entries (FIFO eviction). Entries never expire on their own —
// they're refreshed on the next query after QUOTA_CACHE_MS.
const quotaCache = new Map<string, { ts: number; result: unknown }>();

/**
 * Fire-and-forget a start-plan quota probe right after a credential is saved.
 *
 * The GET billing/current call inside queryQuota is gated by `app_version` — a
 * real client version (3.1.x) activates the start-plan trial on a fresh
 * account on the very first successful query, while a low version (2.0.0)
 * never does (see quota.ts DEFAULT_APP_VERSION + the activation memory).
 *
 * OAuth token exchange itself does NOT activate the plan (verified), so a
 * freshly-OAuth'd account is still in `plans:[]` until something queries
 * billing/current with a real version. Firing this probe once at login means a
 * new account is "OAuth done = ready to use" — the user no longer has to click
 * the quota button manually just to flip the account on.
 *
 * Non-blocking by design: OAuth success must never depend on the activation
 * probe. Activation is irreversible, so even if this fires long after the HTTP
 * response returns, the account still ends up activated. Failures (network /
 * upstream) are swallowed to a debug log — the user can always retry by
 * clicking the quota button. Only start-plan (has a jwt) is probed; coding-plan
 * has no activation concept.
 */
function probeStartPlanActivation(
  cred: AppCredential,
  fetchImpl: typeof fetch,
  appVersion: string | undefined,
): void {
  if (cred.plan !== "start-plan" || !cred.jwt) return;
  // Honour a per-account outbound proxy if configured, matching the quota
  // handler's accountFetch construction.
  const accountFetch = (cred.proxy && cred.proxy.trim()
    ? ((input: RequestInfo | URL, init?: RequestInit) =>
        fetchImpl(input, { ...init, ...(cred.proxy ? { proxy: cred.proxy } : {}) } as any))
    : fetchImpl) as typeof fetch;
  const tag = cred.apiKey.slice(0, 8);
  queryQuota(cred, accountFetch, appVersion)
    .then((r) => {
      const outcome = r.planName ?? r.unavailableReason ?? "ok";
      appendLog("info", `start-plan activation probe (${tag}…): ${outcome}`);
    })
    .catch((e) => {
      appendLog("debug", `start-plan activation probe (${tag}…) failed: ${(e as Error).message}`);
    });
}

/**
 * Periodic cleanup of expired OAuth flows. Without this, abandoned flows
 * (user closed the browser without finishing auth) would accumulate in
 * memory forever — each one carries the pollToken and callbackUrl, both
 * sensitive-ish. Runs every 5 minutes; flows expire 5 minutes after their
 * expiresAt timestamp to give in-flight poll requests a chance to drain.
 */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, flow] of activeFlows) {
    if (now > flow.expiresAt + 5 * 60_000) {
      activeFlows.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    appendLog("debug", `OAuth flow cleanup: removed ${cleaned} expired flow(s)`);
  }
}, 5 * 60_000).unref?.();

// ---------------------------------------------------------------------------
// Debug dump ring buffer (replaces the old writeFileSync-to-disk approach).
// Upstream 4xx bodies used to be written to <cwd>/zcode-proxy-debug-*.json,
// which leaked user conversation content to disk forever. Now we keep the
// last 20 dumps in memory and expose them via /admin/api/debug-dumps.
// ---------------------------------------------------------------------------
const DEBUG_DUMP_LIMIT = 20;
const debugDumps: Array<{
  id: string;
  time: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}> = [];

/**
 * Record a 4xx upstream response's transformed body for diagnostics.
 * Called from handler.ts when upstream returns 4xx.
 */
export function recordDebugDump(entry: {
  id: string;
  status: number;
  upstreamError: string;
  anthropicBeta: string;
  bodySummary: string;
  body: string;
}): void {
  debugDumps.push({
    ...entry,
    time: new Date().toISOString().slice(11, 19),
  });
  if (debugDumps.length > DEBUG_DUMP_LIMIT) {
    debugDumps.splice(0, debugDumps.length - DEBUG_DUMP_LIMIT);
  }
}

/** Clear all debug dumps. */
export function clearDebugDumps(): void {
  debugDumps.length = 0;
}

// ---------------------------------------------------------------------------
// Config persistence — atomic writes + mutex serialization.
//
// The dashboard allows concurrent edits (multiple tabs, multiple users on a
// LAN). Without serialization, two PUTs race: last write wins, losing one of
// the changes. The mutex serializes all config mutations so they apply in
// arrival order.
//
// Writes are also atomic: write to {path}.{pid}.tmp-{ts} then rename. A crash
// between truncate and full write of a non-atomic writeFile leaves a partial
// YAML file; on next startup loadConfig throws and the user is locked out of
// their own config.
// ---------------------------------------------------------------------------
const configWriteMutex = createMutex();
const persistConfig = (config: ProxyConfig, configPath: string): Promise<void> =>
  configWriteMutex.run(() => atomicWriteFile(configPath, configToYaml(config)));

// Log buffer for streaming — uses a monotonic sequence number per entry
// so that SSE clients can track their position even when the underlying
// array is trimmed. The old approach used array indices, which became
// stale whenever splice() ran — causing clients to miss logs or replay
// old ones after a trim event.
const LOG_BUFFER_SIZE = 2000;
const LOG_BUFFER_TRIM = 1000; // trim to this size when capacity is reached
const logBuffer: Array<{ seq: number; time: string; level: string; message: string }> = [];
let logSeq = 0; // monotonic, never reset — used as client cursor
const logWaiters: Array<{ resolve: (value: unknown) => void }> = [];

/** Add a log entry to the buffer (called by intercepting console.log). */
export function appendLog(level: string, message: string) {
  // vceshi0.0.6+: verbose log lines (containing [verbose]) get a higher char
  // limit so the full transformed body / headers aren't truncated to 500 chars.
  // Regular log lines stay at 500 to keep the buffer compact.
  //
  // vceshi0.0.7+: also grant the higher limit to `debug` level — those are
  // the diagnostic logs (request bodies, headers, transformed payloads) that
  // need the extra space. The old `[verbose]` substring check is preserved
  // for backward compat with any code paths that still embed the tag.
  const isVerbose = level === "debug" || message.includes("[verbose]");
  const maxLen = isVerbose ? 3000 : 500;
  const entry = {
    seq: ++logSeq,
    time: new Date().toISOString().slice(11, 19),
    level,
    message: message.slice(0, maxLen),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    // Efficient: remove in bulk instead of one-by-one splice
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_TRIM);
  }
  // Push the new entry to every connected SSE client.
  //
  // vceshi0.0.7+ HOTFIX: the previous `while (logWaiters.length > 0) { shift().resolve() }`
  // form caused an infinite loop because the waiter's resolve() re-pushed
  // itself into logWaiters synchronously — the while condition stayed true
  // forever, blocking the Node.js event loop. Symptom: any action that
  // called appendLog (account switch, config save, etc.) froze the entire
  // dashboard, including unrelated API requests. F5 didn't recover because
  // the server was still stuck in the loop; only a process restart did.
  //
  // The fix is structural: each SSE connection owns ONE long-lived waiter
  // (registered once at start(), removed on cancel()). appendLog just
  // iterates the array and calls resolve(entry) — no shift, no re-push,
  // no loop control to get wrong.
  for (const w of logWaiters) {
    try { w.resolve(entry); } catch { /* ignore — controller may be closed */ }
  }
}

/** Read the bundled dashboard HTML (inlined at build time). */
export function getDashboardHTML(): string {
  return dashboardHtml;
}

/** Handle admin API routes. Returns null if the path doesn't match. */
export async function handleAdminRoute(req: Request, opts: AdminOptions): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // Serve dashboard page
  if (path === "/admin" || path === "/admin/") {
    return new Response(getDashboardHTML(), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Verify auth token for API routes
  if (path.startsWith("/admin/api/") && path !== "/admin/api/verify") {
    // Allow SSE endpoints to receive the token via query parameter, since
    // EventSource cannot set custom HTTP headers.
    const authHeader = req.headers.get("authorization") ?? "";
    let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!token && path === "/admin/api/logs/stream") {
      token = url.searchParams.get("token") ?? "";
    }
    if (opts.config.auth.proxyApiKey && !timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      return errorResponse(401, "authentication_error", "Invalid admin token");
    }
  }

  // --- API Routes ---

  // Verify token
  // Returns {valid: true} when the token matches. When no proxyApiKey is
  // configured the endpoint returns {valid: true, warning: "no_auth"} so
  // the dashboard can surface the security warning to the user instead of
  // silently letting anyone in.
  if (path === "/admin/api/verify" && method === "GET") {
    const authHeader = req.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    if (!opts.config.auth.proxyApiKey) {
      return jsonResp({ valid: true, warning: "no_auth", message: "proxyApiKey not configured — admin dashboard is open to anyone with network access" });
    }
    if (timingSafeEqual(token, opts.config.auth.proxyApiKey)) {
      return jsonResp({ valid: true });
    }
    return errorResponse(401, "authentication_error", "Invalid token");
  }

  // Get config
  if (path === "/admin/api/config" && method === "GET") {
    return jsonResp(sanitizeConfig(opts.config));
  }

  // Update config
  if (path === "/admin/api/config" && method === "PUT") {
    try {
      const body = await req.json() as Record<string, unknown>;
      // Prevent masked placeholder values from overwriting real secrets.
      // The sanitizeConfig() GET endpoint returns "***configured***" for
      // secret fields; if the dashboard sends those back unchanged we skip them.
      const MASK = "***configured***";
      const authBody = body.auth as Record<string, unknown> | undefined;
      if (authBody) {
        if (authBody.apiKey === MASK || authBody.apiKey === "") delete authBody.apiKey;
        if (authBody.proxyApiKey === MASK || authBody.proxyApiKey === "") delete authBody.proxyApiKey;
      }

      // Compute which fields changed in a way that requires a server restart
      // to take effect (vs. fields that can be hot-swapped at runtime).
      // The dashboard uses this to show "restart required" highlights.
      const restartFields: string[] = [];
      const oldPort = opts.config.server.port;
      const oldHost = opts.config.server.host;
      const newServer = body.server as Record<string, unknown> | undefined;
      if (newServer) {
        const newPort = typeof newServer.port === "number" ? newServer.port : parseInt(String(newServer.port), 10);
        if (Number.isFinite(newPort) && newPort !== oldPort) restartFields.push("server.port");
        if (typeof newServer.host === "string" && newServer.host !== oldHost) restartFields.push("server.host");
      }

      const newConfig = { ...opts.config, ...body };
      // Deep-merge nested objects so partial updates don't drop fields.
      // Previously only `auth` was deep-merged; `retry` / `identity` / `logging`
      // / `providers` were shallow-merged, meaning a client sending
      // `{"retry":{"maxRetries":5}}` would lose all other retry fields
      // (initialDelayMs, retryableStatuses, emptyStreamSwitchThreshold, etc.),
      // causing runtime TypeError in handler.ts when those fields became undefined.
      if (authBody) {
        newConfig.auth = { ...opts.config.auth, ...authBody };
      }
      if (body.retry) {
        newConfig.retry = {
          ...opts.config.retry,
          ...(body.retry as object),
          // retryableStatuses is an array — if client sends it, use it; else keep existing
          retryableStatuses: Array.isArray((body.retry as any).retryableStatuses)
            ? (body.retry as any).retryableStatuses
            : opts.config.retry.retryableStatuses,
        };
      }
      if (body.identity) {
        newConfig.identity = { ...opts.config.identity, ...(body.identity as object) };
      }
      if (body.logging) {
        newConfig.logging = { ...opts.config.logging, ...(body.logging as object) };
      }
      if (body.providers) {
        const bp = body.providers as any;
        newConfig.providers = {
          zai: { ...opts.config.providers.zai, ...(bp.zai || {}) },
          bigmodel: { ...opts.config.providers.bigmodel, ...(bp.bigmodel || {}) },
        };
      }
      // Validate the merged config before persisting
      validateConfigForSave(newConfig);
      await persistConfig(newConfig as ProxyConfig, opts.configPath);

      // Apply hot-swappable fields to the in-memory config so they take
      // effect immediately. Restart-required fields (port/host) are NOT
      // applied — they only take effect after the user restarts the process.
      opts.config.provider = newConfig.provider;
      opts.config.plan = newConfig.plan;
      opts.config.defaultModel = newConfig.defaultModel;
      opts.config.models = newConfig.models;
      opts.config.identity = newConfig.identity;
      opts.config.logging = newConfig.logging;
      opts.config.retry = newConfig.retry;
      opts.config.routingRules = newConfig.routingRules;
      opts.config.modelMappings = newConfig.modelMappings;
      if (newConfig.responsesThinking) opts.config.responsesThinking = newConfig.responsesThinking;
      if (newConfig.forceStreamAnthropic !== undefined) opts.config.forceStreamAnthropic = newConfig.forceStreamAnthropic;
      if (authBody) opts.config.auth = newConfig.auth;
      // providers.*.anthropicBase / openaiBase: also hot-swappable
      if (body.providers) {
        opts.config.providers = newConfig.providers;
      }

      appendLog("info", "Configuration updated via admin dashboard");
      return jsonResp({
        ok: true,
        requiresRestart: restartFields.length > 0,
        restartFields,
        // hotApplied: fields that were applied to the live config without restart
        hotApplied: ["provider", "plan", "defaultModel", "models", "identity", "logging", "retry", "routingRules", "modelMappings", "responsesThinking", ...(authBody ? ["auth"] : []), ...(body.providers ? ["providers"] : [])],
      });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get credentials (active credential summary)
  if (path === "/admin/api/credentials" && method === "GET") {
    // Invalidate cache so external writes (e.g. start.bat adding a credential)
    // are reflected on dashboard refresh.
    invalidateStoreCache();
    const cred = await loadCredential();
    if (!cred) return jsonResp({ credential: null });
    return jsonResp({
      credential: {
        provider: cred.provider,
        apiKeyMask: maskApiKey(cred.apiKey),
        hasSecret: !!cred.secret,
        userId: cred.userId,
        expiresAt: cred.expiresAt,
        mode: opts.config.auth.mode,
        plan: cred.plan || "coding-plan",
      },
    });
  }

  // Add API key
  if (path === "/admin/api/credentials" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; apiKey: string; plan?: string; proxy?: string };
      // Field validation (vceshi0.0.5+): reject empty apiKey / unknown provider
      // before they get persisted as garbage that breaks later requests.
      if (!body.apiKey || typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        return errorResponse(400, "missing_param", "apiKey is required and must be a non-empty string");
      }
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const plan = (body.plan === "start-plan" ? "start-plan" : "coding-plan") as "coding-plan" | "start-plan";
      const cred = {
        apiKey: body.apiKey.trim(),
        provider: body.provider,
        plan,
        // Per-account proxy (v2.1.4.1test5+). Trim; empty/whitespace → undefined
        // so the field is omitted from the serialized credential entirely.
        ...(body.proxy && body.proxy.trim() ? { proxy: body.proxy.trim() } : {}),
      } as AppCredential;
      // Manual add: NO keepActive — new key becomes active (matches user expectation
      // that clicking "Add Key" makes it the active credential immediately).
      await saveCredential(cred);
      invalidateStoreCache();
      // Hot-swap in-memory credential so oauth-mode requests pick up the new
      // active credential immediately without restart.
      const active = await loadCredential();
      if (active && active.apiKey === cred.apiKey) {
        opts.auth.setOAuthCredential(active);
      }
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Clear ALL credentials (the "Clear Credentials" button).
  //
  // vceshi0.0.7+: also clear the in-memory oauth credential so running
  // requests stop using the just-deleted credential. Previously the proxy
  // kept serving from the stale in-memory credential until restart —
  // defeating the purpose of the clear action and creating a confusing
  // "I cleared credentials but the proxy still works" experience.
  if (path === "/admin/api/credentials" && method === "DELETE") {
    clearCredential();
    opts.auth.clearOAuthCredential();
    appendLog("info", "All credentials cleared via admin dashboard");
    return jsonResp({ ok: true });
  }

  // List all stored accounts (multi-account support)
  //
  // BUGFIX: invalidate the in-memory store cache before reading. The cache is
  // process-local — if the user added a credential via start.bat (which runs
  // `zcode-proxy auth login` in a separate process) while the proxy server
  // was still running, the new credential is on disk but the cache still
  // holds the old snapshot. Without this invalidation, refreshing the
  // dashboard would NOT show the new credential until the proxy was restarted.
  if (path === "/admin/api/accounts" && method === "GET") {
    invalidateStoreCache();
    const result = await listAccounts();
    return jsonResp(result);
  }

  // Switch active account
  if (path === "/admin/api/accounts/active" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string };
      if (!body.id) return errorResponse(400, "missing_param", "id is required");
      const ok = await switchAccount(body.id);
      if (!ok) return errorResponse(404, "not_found", "Account not found");
      // Hot-swap the in-memory credential and sync plan
      const cred = await loadCredential();
      let planSynced = false;
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        // Sync config.plan to match the account's plan, and persist to yaml
        // so the change survives a server restart. Without this, users who
        // switch plan via the dashboard find the change silently reverted
        // after restart — leading to confusing "still coding-plan" reports.
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          planSynced = true;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Switched active account to ${body.id}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      if (planSynced) {
        try {
          await persistConfig(opts.config, opts.configPath);
          appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
        } catch (e) {
          appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
        }
      }
      return jsonResp({ ok: true, plan: cred?.plan || opts.config.plan });
    } catch (err) {
      return errorResponse(500, "switch_failed", (err as Error).message);
    }
  }

  // Update account label
  if (path === "/admin/api/accounts/label" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; label?: string };
      if (!body.id || typeof body.label !== "string") {
        return errorResponse(400, "missing_param", "id and label are required");
      }
      const ok = await setAccountLabel(body.id, body.label);
      if (!ok) return errorResponse(404, "not_found", "Account not found");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account plan
  if (path === "/admin/api/accounts/plan" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; plan?: string };
      if (!body.id || !body.plan) {
        return errorResponse(400, "missing_param", "id and plan are required");
      }
      if (body.plan !== "coding-plan" && body.plan !== "start-plan") {
        return errorResponse(400, "invalid_param", "plan must be coding-plan or start-plan");
      }
      const ok = await setAccountPlan(body.id, body.plan);
      if (!ok) return errorResponse(404, "not_found", "Account not found");

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use the new
      // plan. Without this, the proxy would keep using the old plan until
      // restart — defeating the purpose of the dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
        if (cred.plan && cred.plan !== opts.config.plan) {
          opts.config.plan = cred.plan;
          appendLog("info", `Plan synced to ${cred.plan} (from account ${body.id})`);
        }
      }
      appendLog("info", `Account ${body.id} plan changed to ${body.plan}`);
      // Persist the (possibly updated) plan to yaml so restart keeps it.
      // Always write — even if plan matches config, the dashboard edit is
      // an explicit user action worth persisting (in case config.yaml had
      // been manually edited out of band).
      try {
        await persistConfig(opts.config, opts.configPath);
        appendLog("info", `Persisted plan=${opts.config.plan} to ${opts.configPath}`);
      } catch (e) {
        appendLog("error", `Failed to persist plan to config: ${(e as Error).message}`);
      }
      return jsonResp({ ok: true, plan: body.plan });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Update account outbound proxy (v2.1.4.1test5+)
  // Accepts an empty/whitespace string to clear the override.
  if (path === "/admin/api/accounts/proxy" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; proxy?: string };
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required");
      }
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required (use empty string to clear)");
      }
      // Basic scheme validation. We accept http://, https://, socks5://,
      // and socks5h:// (Bun supports both). Empty string clears the override.
      const trimmed = body.proxy.trim();
      if (trimmed) {
        const ok = /^(https?|socks5h?):\/\/[^\s]+$/i.test(trimmed);
        if (!ok) {
          return errorResponse(
            400,
            "invalid_param",
            "proxy must be a valid URL with scheme http://, https://, socks5://, or socks5h://",
          );
        }
      }
      const success = await setAccountProxy(body.id, body.proxy);
      if (!success) return errorResponse(404, "not_found", "Account not found");

      // If the updated account is the currently active one, hot-swap the
      // in-memory credential so running requests immediately use (or stop
      // using) the new proxy. Without this, the proxy change would only
      // take effect after a server restart — defeating the purpose of the
      // dashboard edit.
      const cred = await loadCredential();
      if (cred) {
        opts.auth.setOAuthCredential(cred);
      }
      appendLog(
        "info",
        `Account ${body.id} proxy ${trimmed ? `set to ${trimmed}` : "cleared"}`,
      );
      return jsonResp({ ok: true, proxy: trimmed });
    } catch (err) {
      return errorResponse(500, "update_failed", (err as Error).message);
    }
  }

  // Test proxy connectivity (v2.1.4.1test6+)
  // Does a HEAD request to the configured provider's base URL through the
  // supplied proxy URL. Any HTTP response (even 4xx/5xx) means the proxy is
  // reachable; only network-level failures (timeout, connection refused, DNS
  // failure through the proxy, auth rejection by the proxy) report ok=false.
  //
  // Body: { proxy: string, provider?: "zai"|"bigmodel" }
  // Returns: { ok: true, status, latencyMs, target } on success
  //          { ok: false, error, latencyMs, target } on failure (still HTTP 200
  //           so the dashboard can render the error message cleanly)
  if (path === "/admin/api/accounts/proxy-test" && method === "POST") {
    try {
      const body = await req.json() as { proxy?: string; provider?: string };
      if (typeof body.proxy !== "string") {
        return errorResponse(400, "missing_param", "proxy is required");
      }
      const trimmed = body.proxy.trim();
      if (!trimmed) {
        return errorResponse(400, "invalid_param", "proxy URL cannot be empty (use 'No proxy' on the dashboard instead)");
      }
      if (!/^(https?|socks5h?):\/\/[^\s]+$/i.test(trimmed)) {
        return errorResponse(
          400,
          "invalid_param",
          "proxy must be a valid URL with scheme http://, https://, socks5://, or socks5h://",
        );
      }

      // Test target: the relevant provider's base host. Hitting the bare host
      // (no path, no auth) is enough to verify the proxy can reach it — any
      // HTTP response means success. 10s timeout is generous for slow proxies
      // but short enough that a dead proxy doesn't hang the dashboard.
      const providerId = body.provider === "bigmodel" ? "bigmodel" : "zai";
      const providerCfg = opts.config.providers[providerId];
      // Use the anthropicBase URL (e.g. https://api.z.ai/api/anthropic) and
      // strip down to just the origin — we want a HEAD against the host root,
      // not a real API path (which would 404 anyway, but origin is cleaner).
      let target: string;
      try {
        const u = new URL(providerCfg.anthropicBase);
        target = `${u.protocol}//${u.host}`;
      } catch {
        target = providerId === "bigmodel"
          ? "https://open.bigmodel.cn"
          : "https://api.z.ai";
      }

      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      // Use injected fetchImpl if provided (for tests); fall back to global.
      const fetchImpl = opts.fetchImpl ?? fetch;
      try {
        // Bun native: fetch(url, { proxy, signal })
        const resp = await fetchImpl(target, {
          method: "HEAD",
          signal: ctrl.signal,
          // Allow redirects to be followed automatically so a 3xx-to-200
          // path is treated as success, not a redirect failure.
          redirect: "follow",
          // cast through any because { proxy } is Bun-specific
          ...(trimmed ? { proxy: trimmed } : {}),
        } as any);
        clearTimeout(timer);
        const latencyMs = Date.now() - started;
        // Any HTTP response means the proxy is working — the upstream may
        // return 200, 404, 403, etc. depending on its root path handling.
        return jsonResp({
          ok: true,
          status: resp.status,
          latencyMs,
          target,
        });
      } catch (err) {
        clearTimeout(timer);
        const latencyMs = Date.now() - started;
        const errMsg = (err as Error).message || String(err);
        // Distinguish timeout from other errors for clearer UX
        const isTimeout = ctrl.signal.aborted || /abort/i.test(errMsg);
        return jsonResp({
          ok: false,
          error: isTimeout ? `Connection timed out after 10s` : errMsg,
          latencyMs,
          target,
        });
      }
    } catch (err) {
      return errorResponse(500, "test_failed", (err as Error).message);
    }
  }

  // Query upstream quota / balance for an account (v2.1.4.2+)
  // Reverses the ZCode client's BigModelUsageQuotaProvider. start-plan queries
  // zcode.z.ai billing with the JWT; coding-plan queries the provider's monitor
  // quota/limit with the api key. Never throws — surface unavailableReason.
  //
  // vceshi0.0.7+: per-account rate limit (max 1 query / 15s). The upstream
  // billing endpoint is not free — repeated hammering from a refresh-happy
  // user can exhaust the JWT or trigger IP-based throttling. The cache is
  // per-account so querying account A doesn't block account B.
  if (path === "/admin/api/accounts/quota" && method === "POST") {
    try {
      const body = await req.json() as { id?: string };
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      // Per-account rate limit: 1 query / 15s. Stale cached results are
      // returned with a `cached: true` flag so the dashboard can show "this
      // is a cached result, query again in Ns" instead of silently returning
      // old data.
      const now = Date.now();
      const QUOTA_CACHE_MS = 15_000;
      const cached = quotaCache.get(body.id);
      if (cached && now - cached.ts < QUOTA_CACHE_MS) {
        // Spread the cached result object and add cache metadata.
        // Cast through Record<string, unknown> because the cached result
        // is typed as `unknown` (we accept any QuotaResult shape).
        return jsonResp({ ...(cached.result as Record<string, unknown>), cached: true, cachedAt: cached.ts });
      }
      const store = await exportStore();
      const acct = store?.accounts.find((a) => a.id === body.id);
      if (!acct || !acct.credential) {
        return errorResponse(404, "not_found", "Account not found");
      }
      const cred = acct.credential;
      // Honour a per-account outbound proxy if configured, matching how real
      // LLM requests are routed (proxy-test handler uses the same { proxy } opt).
      const baseFetch = opts.fetchImpl ?? fetch;
      const accountFetch = (cred.proxy && cred.proxy.trim()
        ? ((input: RequestInfo | URL, init?: RequestInit) =>
            baseFetch(input, { ...init, ...(cred.proxy ? { proxy: cred.proxy } : {}) } as any))
        : baseFetch) as typeof fetch;
      const result = await queryQuota(cred, accountFetch, opts.config.identity?.appVersion);
      // Cache the fresh result (even on failure — saves the upstream from
      // immediate re-hammering when the failure is durable like a 403).
      quotaCache.set(body.id, { ts: now, result });
      // Bound the cache size — 50 accounts is plenty, drop oldest by insertion.
      if (quotaCache.size > 50) {
        const firstKey = quotaCache.keys().next().value;
        if (firstKey !== undefined) quotaCache.delete(firstKey);
      }
      return jsonResp({ ...result, cached: false });
    } catch (err) {
      return errorResponse(500, "quota_failed", (err as Error).message);
    }
  }

  // Delete an account
  if (path.startsWith("/admin/api/accounts/") && method === "DELETE") {
    const id = path.slice("/admin/api/accounts/".length);
    if (!id) return errorResponse(400, "missing_param", "account id required");
    const ok = await removeAccount(id);
    if (!ok) return errorResponse(404, "not_found", "Account not found");
    // Hot-swap the in-memory credential if active changed
    const cred = await loadCredential();
    if (cred) opts.auth.setOAuthCredential(cred);
    appendLog("info", `Removed account ${id}`);
    return jsonResp({ ok: true });
  }

  // Import from ZCode
  // Reads BOTH config.json + credentials.json (encrypted) and merges them —
  // config.json gives the directly-usable apiKey, credentials.json supplements
  // email/userId + drives provider auto-detect. When the only coding-plan
  // credential is a raw access_token JWT (no plaintext apiKey in config.json),
  // resolve it via the biz API first. See zcode-config.ts.
  if (path === "/admin/api/import" && method === "POST") {
    try {
      const body = await req.json() as { provider: string; plan?: string };
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider as "zai" | "bigmodel";
      // The dashboard's plan dropdown is the user's explicit choice — pass it
      // as forcedPlan so readZCodeImport imports exactly what they picked.
      const forcedPlan = (body.plan === "start-plan" ? "start-plan" : body.plan === "coding-plan" ? "coding-plan" : undefined) as "coding-plan" | "start-plan" | undefined;
      const source = readZCodeImport(provider, forcedPlan);

      // Build the Credential. A raw access_token JWT needs the biz-API exchange
      // to become a usable apiKey.secret; a config.json plaintext apiKey is
      // already usable.
      let cred: AppCredential;
      if (source.isRawAccessToken) {
        const resolver = new KeyResolver(opts.fetchImpl ?? fetch);
        cred = await resolver.resolveCredential(source.apiKey, source.provider, source.userId, source.plan, source.jwt, source.email);
      } else {
        cred = {
          apiKey: source.apiKey,
          provider: source.provider,
          plan: source.plan,
          jwt: source.jwt,
          userId: source.userId,
          email: source.email,
        };
      }
      // Auto-generate name: prefer `{email}-{plan}` (like OAuth imports) when
      // we have an email from credentials.json; otherwise fall back to the
      // `zcode(N)-{plan}` numbering convention.
      if (source.email) {
        cred.name = `${source.email}-${source.plan}`;
      } else {
        try {
          const list = await listAccounts();
          const zcodeCount = list.accounts.filter(a => (a.name || "").startsWith("zcode(")).length;
          cred.name = `zcode(${zcodeCount + 1})-${source.plan}`;
        } catch { /* non-fatal */ }
      }
      // Import should NOT auto-activate the new credential — preserve the
      // user's currently-active account. The user can manually click
      // "Activate" on the new account if they want to switch to it.
      // This matches the user's explicit requirement: "通过zcode导入的凭证
      // 会直接开启它，应该不默认开启，而是保留原来凭证开启，就是不要立马切换
      // 新导入凭证".
      await saveCredential(cred, { keepActive: true });
      invalidateStoreCache();
      // NO hot-swap — the in-memory active credential stays as-is. The new
      // account is added to the store but doesn't become active until the
      // user explicitly activates it via the dashboard.
      return jsonResp({
        ok: true,
        apiKeyMask: maskApiKey(cred.apiKey),
        plan: cred.plan,
        email: cred.email,
        name: cred.name,
        activated: false, // signal to dashboard: not auto-activated
      });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // Detect available ZCode imports — drives the dashboard's import dropdown
  // pre-fill (activeProvider) + option disabling (availability). Reads both
  // config.json + credentials.json.
  if (path === "/admin/api/import/detect" && method === "GET") {
    try {
      const activeProvider = detectZCodeProvider();
      const available = listAvailableZCodeImports();
      return jsonResp({ activeProvider, available });
    } catch (err) {
      return errorResponse(500, "detect_failed", (err as Error).message);
    }
  }

  // Export all accounts (backup)
  if (path === "/admin/api/accounts/export" && method === "GET") {
    try {
      const accounts = await exportAccounts();
      return jsonResp({ accounts, exportedAt: Date.now(), version: 2 });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Export credentials as a base64 blob suitable for the ZCODE_OAUTH_CREDENTIAL
  // env var on Render / Fly.io / K8s.
  //
  // This is the dashboard equivalent of `zcode-proxy auth export` on the CLI.
  // Use case: you logged in via the dashboard (or imported from ZCode), and
  // now want to deploy to Render without re-doing the OAuth flow there.
  //
  // Two output formats, auto-selected by account count:
  //
  //   • Single account  → base64(JSON.stringify(credential))
  //     Backward-compatible with the original render-start.sh, which wraps the
  //     decoded blob as a single-account v2 store on the remote host.
  //
  //   • Multiple accounts → base64(JSON.stringify({version:2, activeId, accounts}))
  //     The full v2 store envelope, so all accounts (and the activeId pointer)
  //     survive the trip to Render. render-start.sh detects this format (top-
  //     level `version: 2` + `accounts` array) and writes it directly to
  //     credentials.json instead of wrapping.
  //
  // Returns:
  //   { credential: <base64>, json: <pretty JSON>, envVars: {...},
  //     multi: boolean, accountCount: number, instructions: <string> }
  // The `credential` field is what you paste into Render's ZCODE_OAUTH_CREDENTIAL.
  // The `json` field is the decoded payload for human inspection.
  // ---------------------------------------------------------------------
  // vceshi0.0.4+: Edit account name/email + export single account JSON
  // ---------------------------------------------------------------------

  // Edit account name/email (vceshi0.0.4+).
  // Body: { id, name?, email? } — only provided fields are updated; omitted
  // fields preserve their current value. Empty string clears the field.
  if (path === "/admin/api/accounts/edit" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; name?: string; email?: string };
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      // Type-check name/email (vceshi0.0.5+): non-string values (numbers, null,
      // objects) would crash setAccountName's .trim() call. Reject early.
      if (body.name !== undefined && typeof body.name !== "string") {
        return errorResponse(400, "invalid_param", "name must be a string");
      }
      if (body.email !== undefined && typeof body.email !== "string") {
        return errorResponse(400, "invalid_param", "email must be a string");
      }
      // At least one of name/email must be provided (otherwise the call is a no-op).
      if (body.name === undefined && body.email === undefined) {
        return errorResponse(400, "missing_param", "At least one of name or email must be provided");
      }

      // Update name if provided (including empty string to clear)
      if (body.name !== undefined) {
        const ok = await setAccountName(body.id, body.name);
        if (!ok) return errorResponse(404, "not_found", "Account not found");
      }
      // Update email if provided (including empty string to clear)
      if (body.email !== undefined) {
        const ok = await setAccountEmail(body.id, body.email);
        if (!ok) return errorResponse(404, "not_found", "Account not found");
      }

      // If the active account was edited, hot-swap the in-memory credential so
      // the new name/email take effect immediately for any running requests
      // (email is read by some upstreams via metadata.user_id — though name
      // is purely for display, hot-swapping is cheap and keeps things consistent).
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);

      appendLog("info", `Account ${body.id} edited (name=${body.name !== undefined ? "updated" : "kept"}, email=${body.email !== undefined ? "updated" : "kept"})`);
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "edit_failed", (err as Error).message);
    }
  }

  // Export single account as JSON (vceshi0.0.4+).
  // Query param: ?id=<accountId>
  // Returns the full account record including plaintext credential — caller
  // should treat the response as sensitive (recommend downloading as a file
  // rather than logging).
  if (path === "/admin/api/accounts/export-single" && method === "GET") {
    try {
      const id = url.searchParams.get("id");
      if (!id) {
        return errorResponse(400, "missing_param", "id query param is required");
      }
      // Invalidate cache so external writes (e.g. start.bat adding a credential)
      // are reflected — otherwise we might return 404 for a just-added account.
      invalidateStoreCache();
      const account = await exportSingleAccount(id);
      if (!account) {
        return errorResponse(404, "not_found", "Account not found");
      }
      return jsonResp({ ok: true, account });
    } catch (err) {
      return errorResponse(500, "export_failed", (err as Error).message);
    }
  }

  // Toggle account disabled state (vceshi0.0.6+).
  // Body: { id, disabled: boolean }
  // When disabled, the credential is excluded from auto-switch + manual activation.
  if (path === "/admin/api/accounts/disabled" && method === "PUT") {
    try {
      const body = await req.json() as { id?: string; disabled?: boolean };
      if (!body.id || typeof body.id !== "string") {
        return errorResponse(400, "missing_param", "id is required and must be a string");
      }
      if (typeof body.disabled !== "boolean") {
        return errorResponse(400, "invalid_param", "disabled must be a boolean");
      }
      const ok = await setAccountDisabled(body.id, body.disabled);
      if (!ok) return errorResponse(404, "not_found", "Account not found");
      invalidateStoreCache();
      appendLog("info", `Account ${body.id} ${body.disabled ? "disabled" : "enabled"}`);
      return jsonResp({ ok: true, disabled: body.disabled });
    } catch (err) {
      return errorResponse(500, "toggle_failed", (err as Error).message);
    }
  }

  if (path === "/admin/api/accounts/render-export" && method === "GET") {
    try {
      const store = await exportStore();
      if (!store || store.accounts.length === 0) {
        return errorResponse(404, "not_logged_in", "No stored credential. Login or import first.");
      }

      // Single-account path: emit the bare credential (backward compat with
      // existing render-start.sh consumers).
      if (store.accounts.length === 1) {
        const cred = store.accounts[0].credential;
        const json = JSON.stringify(cred);
        const b64 = Buffer.from(json, "utf8").toString("base64");
        return jsonResp({
          credential: b64,
          json: JSON.stringify(cred, null, 2),
          envVars: {
            ZCODE_AUTH_MODE: "oauth",
            ZCODE_OAUTH_CREDENTIAL: b64,
          },
          multi: false,
          accountCount: 1,
          instructions: [
            "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
            "2. On Render, go to your service → Environment → add/edit:",
            "   - ZCODE_AUTH_MODE = oauth",
            "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
            "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
            "4. Save and let Render redeploy.",
            "",
            "WARNING: This blob contains your upstream credential in plaintext.",
            "Treat it like a password. On Render, mark the env var as Secret.",
          ].join("\n"),
        });
      }

      // Multi-account path: emit the full v2 store envelope so all accounts
      // are preserved on the remote host.
      const storeJson = JSON.stringify(store);
      const b64 = Buffer.from(storeJson, "utf8").toString("base64");
      return jsonResp({
        credential: b64,
        json: JSON.stringify(store, null, 2),
        envVars: {
          ZCODE_AUTH_MODE: "oauth",
          ZCODE_OAUTH_CREDENTIAL: b64,
        },
        multi: true,
        accountCount: store.accounts.length,
        instructions: [
          `Detected ${store.accounts.length} stored accounts — exporting the full credential store (v2 envelope).`,
          "All accounts and the active-account pointer are preserved in the base64 blob.",
          "",
          "1. Copy the value of ZCODE_OAUTH_CREDENTIAL below.",
          "2. On Render, go to your service → Environment → add/edit:",
          "   - ZCODE_AUTH_MODE = oauth",
          "   - ZCODE_OAUTH_CREDENTIAL = <paste the base64 blob>",
          "3. Make sure ZCODE_API_KEY is UNSET (otherwise the proxy uses apikey mode).",
          "4. Save and let Render redeploy.",
          "",
          "WARNING: This blob contains ALL your upstream credentials in plaintext.",
          "Treat it like a password. On Render, mark the env var as Secret.",
        ].join("\n"),
      });
    } catch (err) {
      return errorResponse(500, "render_export_failed", (err as Error).message);
    }
  }

  // Import accounts from backup
  if (path === "/admin/api/accounts/import" && method === "POST") {
    try {
      const body = await req.json() as { accounts?: unknown[] };
      if (!Array.isArray(body.accounts)) {
        return errorResponse(400, "invalid_param", "accounts array is required");
      }
      // Basic validation: each account must have id, label, createdAt, credential
      const validated = body.accounts.filter((a: any) =>
        a && typeof a.id === "string" && typeof a.label === "string" &&
        typeof a.createdAt === "number" && a.credential && typeof a.credential.apiKey === "string"
      );
      if (validated.length === 0) {
        return errorResponse(400, "invalid_param", "No valid accounts found in import data");
      }
      const result = await importAccounts(validated as any);
      appendLog("info", `Imported accounts: ${result.added} added, ${result.updated} updated`);
      // Hot-swap active credential (only if it changed). After import we
      // must invalidate cache so loadCredential() reads the freshly-imported
      // store from disk (importAccounts already wrote it, but our cache is
      // stale).
      invalidateStoreCache();
      const cred = await loadCredential();
      if (cred) opts.auth.setOAuthCredential(cred);
      return jsonResp({ ok: true, added: result.added, updated: result.updated });
    } catch (err) {
      return errorResponse(500, "import_failed", (err as Error).message);
    }
  }

  // OAuth init
  if (path === "/admin/api/oauth/init" && method === "POST") {
    try {
      const body = await req.json() as { provider?: string; plan?: string };
      // vceshi0.0.7+: validate provider explicitly. The old code did an
      // unchecked `as "zai" | "bigmodel"` cast, which meant an unknown
      // provider would slip through and crash deep inside the OAuth client
      // (e.g. BigmodelOAuthClient constructor) with a confusing message
      // like "Cannot read property of undefined". Surface a clear 400 instead.
      if (body.provider !== "zai" && body.provider !== "bigmodel") {
        return errorResponse(400, "invalid_param", "provider must be 'zai' or 'bigmodel'");
      }
      const provider = body.provider;
      const oauthPlan = (body.plan === "start-plan" ? "start-plan" : "coding-plan") as "coding-plan" | "start-plan";

      if (provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        const { authorizeUrl, callbackUrl, state } = await oauth.start();
        // Store flow info for polling
        const flowId = `bm_${state.slice(0, 16)}`;
        activeFlows.set(flowId, {
          provider,
          flowId,
          pollToken: state,
          expiresAt: Date.now() + 300_000,
          // Store the localhost callback URL & state for manual callback exchange path
          callbackUrl,
          state,
          plan: oauthPlan,
        } as any);
        // Start background process to wait for callback.
        //
        // Wrapped in try/finally so oauth.close() ALWAYS runs — even if
        // saveCredential throws (e.g. disk full). The old code only called
        // close() on success or in the catch block, so a saveCredential
        // failure left the localhost OAuth callback server listening until
        // the 5-minute flow cleanup interval fired (10 min after expiry).
        (async () => {
          try {
            const authCode = await oauth.waitForCallback(300_000);
            const { accessToken, userId, jwt, email } = await oauth.exchangeCode(authCode, callbackUrl, state);
            const resolver = new KeyResolver();
            const cred = await resolver.resolveCredential(accessToken, provider, userId, oauthPlan, jwt, email);
            // Auto-generate name from email + plan (vceshi0.0.4+).
            // Falls back to no name (label will be auto-generated by store) if
            // email is missing — e.g. older OAuth responses without email field.
            if (email) {
              cred.name = `${email}-${oauthPlan}`;
            }
            // keepActive:true — do NOT silently swap the user's currently-active
            // credential out from under them. The new account appears in the
            // dashboard list; the user explicitly clicks "Activate" to switch.
            // (Only swap if there's no active credential yet — i.e. first-ever login.)
            await saveCredential(cred, { keepActive: true });
            // Hot-swap the in-memory credential ONLY IF there was no active
            // credential before this OAuth flow completed. Otherwise preserve
            // the current selection — the user can activate the new account
            // explicitly from the dashboard.
            const existingActive = await loadCredential();
            // If existingActive is the just-saved cred (i.e. there was no prior
            // active), hot-swap. Otherwise leave the in-memory credential alone.
            if (existingActive && existingActive.apiKey === cred.apiKey) {
              opts.auth.setOAuthCredential(existingActive);
            }
            // Probe start-plan activation in the background (fire-and-forget).
            // See probeStartPlanActivation — non-blocking, never fails the login.
            probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);
            // Mark flow as ready
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "ready"; }
          } catch (err) {
            const flow = activeFlows.get(flowId);
            if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
            appendLog("debug", `bigmodel OAuth flow ${flowId} failed: ${(err as Error).message}`);
          } finally {
            // ALWAYS close the localhost callback server, regardless of
            // outcome. Without this, abandoned flows leak a listening socket
            // for ~10 min until the cleanup interval fires.
            try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
          }
        })();
        return jsonResp({ flowId, authorizeUrl });
      }

      // Z.AI OAuth — same auth-code/callback shape as bigmodel above.
      // start() spins up the localhost callback server and returns the
      // authorize URL (flowId == state doubles as the CSRF token + flow key).
      const oauth = new ZaiOAuthClient();
      const init = await oauth.start();
      activeFlows.set(init.flowId, {
        provider,
        flowId: init.flowId,
        pollToken: init.pollToken,
        expiresAt: init.expiresAt,
        callbackUrl: init.callbackUrl,
        state: init.state,
        plan: oauthPlan,
      } as any);
      // Background process: wait for the localhost callback, then exchange.
      // Wrapped in try/finally so oauth.close() ALWAYS runs — see bigmodel path.
      (async () => {
        try {
          const authCode = await oauth.waitForCallback(init.expiresAt - Date.now() || 300_000);
          const { accessToken, userId, jwt, email } = await oauth.exchangeCode(authCode, init.callbackUrl, init.state);
          const resolver = new KeyResolver();
          const cred = await resolver.resolveCredential(accessToken, provider, userId, oauthPlan, jwt, email);
          // Auto-generate name from email + plan (vceshi0.0.4+).
          if (email) {
            cred.name = `${email}-${oauthPlan}`;
          }
          // keepActive:true — see bigmodel path comment above.
          await saveCredential(cred, { keepActive: true });
          const existingActive = await loadCredential();
          if (existingActive && existingActive.apiKey === cred.apiKey) {
            opts.auth.setOAuthCredential(existingActive);
          }
          // Probe start-plan activation in the background (fire-and-forget).
          probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "ready"; }
        } catch (err) {
          const flow = activeFlows.get(init.flowId);
          if (flow) { (flow as any).status = "failed"; (flow as any).error = (err as Error).message; }
          appendLog("debug", `zai OAuth flow ${init.flowId} failed: ${(err as Error).message}`);
        } finally {
          try { await oauth.close(); } catch (e) { appendLog("debug", `oauth.close() cleanup failed: ${(e as Error).message}`); }
        }
      })();
      return jsonResp({ flowId: init.flowId, authorizeUrl: init.authorizeUrl, expiresAt: init.expiresAt });
    } catch (err) {
      return errorResponse(500, "oauth_init_failed", (err as Error).message);
    }
  }

  // OAuth poll
  if (path === "/admin/api/oauth/poll" && method === "GET") {
    const flowId = url.searchParams.get("flowId");
    if (!flowId) return errorResponse(400, "missing_param", "flowId required");
    const flow = activeFlows.get(flowId);
    if (!flow) return errorResponse(404, "not_found", "Unknown flow");
    // Check expiry (vceshi0.0.5+): expired flows return "expired" status so the
    // dashboard can show a clear "授权已过期" message instead of spinning forever.
    if (Date.now() > flow.expiresAt) {
      activeFlows.delete(flowId);
      return jsonResp({ status: "expired" });
    }
    const status = (flow as any).status || "pending";
    const resp: any = { status };
    // Surface the error message on failure (vceshi0.0.5+) — previously the
    // dashboard couldn't tell the user WHY the flow failed.
    if (status === "failed" && (flow as any).error) {
      resp.error = (flow as any).error;
    }
    if (status === "ready" || status === "failed") activeFlows.delete(flowId);
    return jsonResp(resp);
  }

  // OAuth manual callback URL submission
  // User pastes the redirected browser URL (containing ?code=...&state=...) after authorizing
  if (path === "/admin/api/oauth/callback" && method === "POST") {
    try {
      const body = await req.json() as { flowId?: string; callbackUrl?: string };
      const flowId = body.flowId;
      const callbackUrl = body.callbackUrl ?? "";

      if (!flowId || !callbackUrl) {
        return errorResponse(400, "missing_param", "flowId and callbackUrl are required");
      }

      const flow = activeFlows.get(flowId);
      if (!flow) {
        return errorResponse(404, "flow_not_found", "Unknown or expired OAuth flow. Please restart the login.");
      }
      if (Date.now() > flow.expiresAt) {
        activeFlows.delete(flowId);
        return errorResponse(410, "flow_expired", "OAuth flow has expired. Please restart the login.");
      }

      // Parse the callback URL to extract code & state (used as authorization confirmation)
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(callbackUrl);
      } catch {
        return errorResponse(400, "invalid_url", "Callback URL is not a valid URL.");
      }

      const code = parsedUrl.searchParams.get("code");
      const state = parsedUrl.searchParams.get("state");
      if (!code || !state) {
        return errorResponse(400, "invalid_callback", "Callback URL missing 'code' or 'state' parameter.");
      }

      // Z.AI manual callback: same shape as the bigmodel path below. The
      // user pasted the redirected browser URL (containing ?code=&state=);
      // we exchange it via the zcode.z.ai proxy using the localhost
      // callback URL + state recorded on the flow at start() time.
      if (flow.provider === "zai") {
        const oauth = new ZaiOAuthClient();
        const storedCallbackUrl = (flow as any).callbackUrl;
        if (!storedCallbackUrl) {
          return errorResponse(500, "missing_callback", "Original localhost callback URL not found. Please restart the login.");
        }
        // state from the pasted URL must match the state recorded on the flow
        if (state !== flow.state) {
          return errorResponse(400, "state_mismatch", "Callback state does not match the OAuth flow. Please restart the login.");
        }
        const { accessToken, userId, jwt, email } = await oauth.exchangeCode(code, storedCallbackUrl, state);
        const resolver = new KeyResolver();
        const flowPlan = ((flow as any).plan ?? "coding-plan") as "coding-plan" | "start-plan";
        const cred = await resolver.resolveCredential(accessToken, "zai", userId, flowPlan, jwt, email);
        // Auto-generate name from email + plan (vceshi0.0.4+).
        if (email) {
          cred.name = `${email}-${flowPlan}`;
        }
        // keepActive:true — manual callback path matches auto-poll path behavior.
        await saveCredential(cred, { keepActive: true });
        const existingActive = await loadCredential();
        if (existingActive && existingActive.apiKey === cred.apiKey) {
          opts.auth.setOAuthCredential(existingActive);
        }
        // Probe start-plan activation in the background (fire-and-forget).
        probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);

        activeFlows.delete(flowId);
        return jsonResp({
          ok: true,
          provider: "zai",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      // For bigmodel: the callback URL points to localhost (which the user can't reach
      // from a remote browser), so we still need to manually exchange the code via
      // zcode.z.ai proxy. Extract the code and call exchangeCode with the original
      // callback URL stored on the flow.
      if (flow.provider === "bigmodel") {
        const oauth = new BigmodelOAuthClient();
        // The original callbackUrl stored on the flow is the localhost URL we
        // registered at start() time — we need it for the token exchange.
        const storedCallbackUrl = (flow as any).callbackUrl;
        if (!storedCallbackUrl) {
          return errorResponse(500, "missing_callback", "Original localhost callback URL not found. Please restart the login.");
        }
        // State validation (vceshi0.0.5+): defense-in-depth CSRF check, matching
        // the zai path above. Previously bigmodel manual callback skipped this.
        if (state !== flow.state) {
          return errorResponse(400, "state_mismatch", "Callback state does not match the OAuth flow. Please restart the login.");
        }
        const { accessToken, userId, jwt, email } = await oauth.exchangeCode(code, storedCallbackUrl, state);
        const resolver = new KeyResolver();
        const flowPlan = ((flow as any).plan ?? "coding-plan") as "coding-plan" | "start-plan";
        const cred = await resolver.resolveCredential(accessToken, "bigmodel", userId, flowPlan, jwt, email);
        // Auto-generate name from email + plan (vceshi0.0.4+).
        if (email) {
          cred.name = `${email}-${flowPlan}`;
        }
        // keepActive:true — matches zai manual path + auto-poll path behavior.
        await saveCredential(cred, { keepActive: true });
        const existingActive = await loadCredential();
        if (existingActive && existingActive.apiKey === cred.apiKey) {
          opts.auth.setOAuthCredential(existingActive);
        }
        // Probe start-plan activation in the background (fire-and-forget).
        probeStartPlanActivation(cred, opts.fetchImpl ?? fetch, opts.config.identity?.appVersion);

        activeFlows.delete(flowId);
        return jsonResp({
          ok: true,
          provider: "bigmodel",
          apiKeyMask: maskApiKey(cred.apiKey),
          userId: cred.userId,
        });
      }

      return errorResponse(400, "unsupported_provider", `Provider ${flow.provider} does not support callback URL exchange.`);
    } catch (err) {
      return errorResponse(500, "oauth_callback_failed", (err as Error).message);
    }
  }

  // Update endpoints (zai/bigmodel anthropicBase + openaiBase).
  //
  // vceshi0.0.7+: validate URLs before applying. The config PUT path goes
  // through validateConfigForSave() which rejects malformed URLs, but this
  // endpoint bypassed that check — meaning a typo like "api.z.ai" (missing
  // https://) would be silently accepted, then 404 every subsequent request
  // until the user noticed. Now we mirror validateConfigForSave's check.
  if (path === "/admin/api/endpoints" && method === "PUT") {
    try {
      const body = await req.json() as { zai?: Record<string, unknown>; bigmodel?: Record<string, unknown> };
      // Validate first; only apply if all fields pass.
      const allowedFields = ["anthropicBase", "openaiBase"] as const;
      for (const provKey of ["zai", "bigmodel"] as const) {
        const prov = body[provKey];
        if (!prov || typeof prov !== "object") continue;
        for (const field of allowedFields) {
          const v = prov[field];
          if (v === undefined) continue;
          if (typeof v !== "string" || v.length === 0) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be a non-empty string`);
          }
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              return errorResponse(400, "invalid_param", `providers.${provKey}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
        // Reject unknown fields to prevent accidental injection of unrelated keys.
        for (const k of Object.keys(prov)) {
          if (!allowedFields.includes(k as any)) {
            return errorResponse(400, "invalid_param", `providers.${provKey}.${k} is not allowed on this endpoint (only anthropicBase and openaiBase)`);
          }
        }
      }
      // Apply validated changes
      if (body.zai) Object.assign(opts.config.providers.zai, body.zai);
      if (body.bigmodel) Object.assign(opts.config.providers.bigmodel, body.bigmodel);
      // Persist to disk so changes survive restart (vceshi0.0.5+ fix — previously
      // the in-memory update was hot but lost on restart, silently reverting).
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", "Proxy endpoints updated via admin dashboard");
      return jsonResp({ ok: true });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get routing rules
  if (path === "/admin/api/routing-rules" && method === "GET") {
    return jsonResp({ rules: opts.config.routingRules ?? [] });
  }

  // Update routing rules (full replace)
  if (path === "/admin/api/routing-rules" && method === "PUT") {
    try {
      const body = await req.json() as { rules?: Array<{ pattern?: string; provider?: string; endpoint?: string; note?: string }> };
      if (!Array.isArray(body.rules)) {
        return errorResponse(400, "invalid_request", "rules must be an array");
      }
      // Validate & normalize
      const cleaned: RoutingRule[] = [];
      for (const r of body.rules) {
        if (typeof r.pattern !== "string" || r.pattern.trim() === "") {
          return errorResponse(400, "invalid_rule", "Each rule needs a non-empty 'pattern'");
        }
        if (r.provider !== "zai" && r.provider !== "bigmodel") {
          return errorResponse(400, "invalid_rule", `Rule '${r.pattern}' has invalid provider (must be 'zai' or 'bigmodel')`);
        }
        cleaned.push({
          pattern: r.pattern.trim(),
          provider: r.provider,
          endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
          note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
        });
      }
      opts.config.routingRules = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Routing rules updated (${cleaned.length} rule(s))`);
      return jsonResp({ ok: true, rules: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get model mappings
  if (path === "/admin/api/model-mappings" && method === "GET") {
    return jsonResp({ mappings: opts.config.modelMappings ?? [] });
  }

  // Update model mappings (full replace)
  if (path === "/admin/api/model-mappings" && method === "PUT") {
    try {
      const body = await req.json() as { mappings?: Array<{ from?: string; to?: string; note?: string }> };
      if (!Array.isArray(body.mappings)) {
        return errorResponse(400, "invalid_request", "mappings must be an array");
      }
      const cleaned: ModelMapping[] = [];
      const seenFrom = new Set<string>();
      for (const m of body.mappings) {
        if (typeof m.from !== "string" || m.from.trim() === "") {
          return errorResponse(400, "invalid_mapping", "Each mapping needs a non-empty 'from'");
        }
        if (typeof m.to !== "string" || m.to.trim() === "") {
          return errorResponse(400, "invalid_mapping", `Mapping '${m.from}' has empty 'to'`);
        }
        const fromLower = m.from.trim().toLowerCase();
        if (seenFrom.has(fromLower)) {
          return errorResponse(400, "invalid_mapping", `Duplicate 'from' value: '${m.from}' (case-insensitive)`);
        }
        seenFrom.add(fromLower);
        cleaned.push({
          from: fromLower,
          to: m.to.trim(),
          note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
        });
      }
      opts.config.modelMappings = cleaned;
      // Persist
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Model mappings updated (${cleaned.length} mapping(s))`);
      return jsonResp({ ok: true, mappings: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get GLM model catalog (full pinned list from provider/models.ts).
  // Used by the dashboard for "pull current model list for quick selection"
  // dropdowns in model mappings and responses-thinking config.
  if (path === "/admin/api/glm-models" && method === "GET") {
    return jsonResp({
      models: GLM_CATALOG.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        reasoning: !!m.reasoning,
      })),
    });
  }

  // Get responses-thinking config
  if (path === "/admin/api/responses-thinking" && method === "GET") {
    return jsonResp({ models: opts.config.responsesThinking?.models ?? [] });
  }

  // Update responses-thinking config (full replace)
  if (path === "/admin/api/responses-thinking" && method === "PUT") {
    try {
      const body = await req.json() as { models?: unknown };
      if (!Array.isArray(body.models)) {
        return errorResponse(400, "invalid_request", "models must be an array of strings");
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const item of body.models) {
        if (typeof item !== "string") {
          return errorResponse(400, "invalid_model", `Each model must be a string (got ${typeof item})`);
        }
        const id = item.trim();
        if (!id) continue;
        const key = id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(id);
      }
      const cfg: ResponsesThinkingConfig = { models: cleaned };
      opts.config.responsesThinking = cfg;
      await persistConfig(opts.config, opts.configPath);
      appendLog("info", `Responses thinking override updated (${cleaned.length} model(s))`);
      return jsonResp({ ok: true, models: cleaned });
    } catch (err) {
      return errorResponse(500, "save_failed", (err as Error).message);
    }
  }

  // Get stats
  if (path === "/admin/api/stats" && method === "GET") {
    return jsonResp({
      ...stats,
      uptime: Date.now() - opts.startTime,
    });
  }

  // Reset stats
  if (path === "/admin/api/stats" && method === "DELETE") {
    stats.total = 0;
    stats.success = 0;
    stats.failed = 0;
    stats.retried = 0;
    stats.requests = [];
    stats.models = {};
    stats.byCredential = {};
    requestIndex.clear();
    seenIds.clear(); // vceshi0.0.7+: clear lifetime dedup set on manual reset
    appendLog("info", "Stats reset by admin");
    return jsonResp({ ok: true });
  }

  // Log stream (SSE)
  // Uses monotonic seq numbers instead of array indices so that clients
  // never miss logs even when the underlying buffer is trimmed. The client
  // cursor (lastSentSeq) is a seq value, not an array index — it stays
  // valid across splice() calls because we look up entries by seq.
  //
  // vceshi0.0.7+ HOTFIX: this handler was rewritten to fix an infinite loop
  // bug. The previous version registered a waiter whose resolve() re-pushed
  // itself into logWaiters synchronously — appendLog's `while (length > 0)
  // { shift().resolve() }` then looped forever, blocking the event loop.
  // The new model: each SSE connection owns ONE long-lived waiter (registered
  // once at start(), removed on cancel()). appendLog just iterates the array
  // and calls resolve(entry) — no shift, no re-push. The waiter's resolve()
  // sends the specific entry directly to the SSE stream (no flushNew re-scan
  // needed), keeping push-based delivery with low latency.
  //
  // The 2s polling interval is kept as a safety net for the rare race where
  // appendLog fires between the initial buffer-scan and the logWaiters.push()
  // (which would otherwise be missed because the waiter isn't registered yet).
  if (path === "/admin/api/logs/stream" && method === "GET") {
    let lastSentSeq = logSeq;
    let cleanup: (() => void) | null = null;
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (entry: { seq: number; time: string; level: string; message: string }) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
          } catch { /* SSE controller may be closed; safe to ignore */ }
        };

        // Flush any new entries with seq > lastSentSeq, then advance cursor.
        // Used by the safety-net polling interval only — push delivery goes
        // through waiter.resolve(entry) directly, no full buffer scan needed.
        const flushNew = () => {
          for (const e of logBuffer) {
            if (e.seq > lastSentSeq) send(e);
          }
          lastSentSeq = logSeq;
        };

        // Send existing buffered logs first.
        const startSeq = logBuffer.length > 0 ? logBuffer[0].seq : logSeq + 1;
        for (const entry of logBuffer) {
          if (entry.seq < startSeq) continue;
          send(entry);
        }
        lastSentSeq = logSeq;

        // Long-lived waiter: appendLog() calls resolve(entry) for every
        // connected SSE client. resolve() just sends the entry directly —
        // NO re-push, NO flushNew (the entry is right here, no need to
        // re-scan the buffer). The waiter stays in logWaiters until the
        // connection closes (cancel() handler removes it).
        const waiter: { resolve: (value: unknown) => void } = {
          resolve: (value: unknown) => {
            if (closed) return;
            // The value IS the new log entry — send it directly.
            // No need to flushNew() because we have the entry right here.
            const entry = value as { seq: number; time: string; level: string; message: string };
            if (entry.seq > lastSentSeq) {
              send(entry);
              lastSentSeq = entry.seq;
            }
          },
        };
        logWaiters.push(waiter);

        // Safety-net polling: 2s interval, used only to recover from the
        // rare race where appendLog fires between the buffer-scan above and
        // the logWaiters.push() above. Slow enough to be cheap on idle
        // systems; fast enough that the race window is negligible.
        const interval = setInterval(() => {
          if (closed) return;
          flushNew();
        }, 2000);

        // Safety timeout: close after 1 hour
        const maxTimeout = setTimeout(() => {
          doCleanup();
          try { controller.close(); } catch { /* already closed */ }
        }, 3600000);

        const doCleanup = () => {
          closed = true;
          clearInterval(interval);
          clearTimeout(maxTimeout);
          const idx = logWaiters.indexOf(waiter);
          if (idx >= 0) logWaiters.splice(idx, 1);
        };
        cleanup = doCleanup;
      },
      cancel() {
        // Cleanup if the client disconnects early
        cleanup?.();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        // Disable Nagle's algorithm for snappier streaming
        "x-accel-buffering": "no",
      },
    });
  }

  // Get logs (batch)
  if (path === "/admin/api/logs" && method === "GET") {
    const level = url.searchParams.get("level");
    const search = url.searchParams.get("search")?.toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 2000);
    let logs = logBuffer;
    if (level) logs = logs.filter(l => l.level === level);
    if (search) logs = logs.filter(l => l.message.toLowerCase().includes(search));
    return jsonResp({ logs: logs.slice(-limit), total: logBuffer.length });
  }

  // Get debug dumps (memory ring buffer of upstream 4xx transformed bodies).
  // Replaces the old writeFileSync-to-disk approach that leaked user
  // conversation content to <cwd>/zcode-proxy-debug-*.json forever.
  if (path === "/admin/api/debug-dumps" && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 100);
    // Strip the full body by default — only return it when ?full=1.
    // Bodies can be 90KB+ and may contain user conversation content, so we
    // hide them behind an explicit opt-in to avoid surprising the user.
    const includeBody = url.searchParams.get("full") === "1";
    const dumpId = url.searchParams.get("id");
    if (dumpId) {
      const dump = debugDumps.find(d => d.id === dumpId);
      if (!dump) return errorResponse(404, "not_found", "Debug dump not found");
      return jsonResp(dump);
    }
    return jsonResp({
      dumps: debugDumps.slice(-limit).reverse().map(d =>
        includeBody ? d : { ...d, body: undefined }
      ),
      total: debugDumps.length,
    });
  }

  // Clear debug dumps
  if (path === "/admin/api/debug-dumps" && method === "DELETE") {
    clearDebugDumps();
    appendLog("info", "Debug dumps cleared by admin");
    return jsonResp({ ok: true });
  }

  return null; // Not an admin route
}

// --- Helpers ---

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sanitizeConfig(config: ProxyConfig): Record<string, unknown> {
  return {
    server: config.server,
    provider: config.provider,
    plan: config.plan,
    auth: {
      mode: config.auth.mode,
      // Don't expose full API key, just indicate presence
      apiKey: config.auth.apiKey ? "***configured***" : "",
      proxyApiKey: config.auth.proxyApiKey ? "***configured***" : "",
    },
    providers: config.providers,
    defaultModel: config.defaultModel,
    models: config.models,
    identity: config.identity,
    logging: config.logging,
    retry: config.retry,
    routingRules: config.routingRules ?? [],
    modelMappings: config.modelMappings ?? [],
    responsesThinking: config.responsesThinking ?? { models: [] },
  };
}

function configToYaml(config: ProxyConfig): string {
  // Build a plain object preserving insertion order matching config.example.yaml,
  // then let the `yaml` library handle quoting/indentation/escape correctly.
  // This keeps values with special chars (colons, leading spaces, quotes) safe
  // and avoids the brittle manual string concatenation that previously broke on
  // URLs containing ':' and other reserved characters.
  const obj: Record<string, unknown> = {
    server: { port: config.server.port, host: config.server.host },
    auth: {
      mode: config.auth.mode,
      ...(config.auth.apiKey ? { apiKey: config.auth.apiKey } : {}),
      ...(config.auth.proxyApiKey ? { proxyApiKey: config.auth.proxyApiKey } : {}),
    },
    provider: config.provider,
    plan: config.plan,
    providers: {
      zai: {
        anthropicBase: config.providers.zai.anthropicBase,
        openaiBase: config.providers.zai.openaiBase,
        ...(config.providers.zai.credential ? { credential: config.providers.zai.credential } : {}),
      },
      bigmodel: {
        anthropicBase: config.providers.bigmodel.anthropicBase,
        openaiBase: config.providers.bigmodel.openaiBase,
        ...(config.providers.bigmodel.credential ? { credential: config.providers.bigmodel.credential } : {}),
      },
    },
    defaultModel: config.defaultModel,
    models: config.models,
    identity: { ...config.identity },
    logging: { ...config.logging },
    retry: { ...config.retry, retryableStatuses: [...config.retry.retryableStatuses] },
    ...(config.routingRules && config.routingRules.length > 0
      ? { routingRules: config.routingRules.map(r => ({
          pattern: r.pattern,
          provider: r.provider,
          ...(r.endpoint ? { endpoint: r.endpoint } : {}),
          ...(r.note ? { note: r.note } : {}),
        })) }
      : {}),
    ...(config.modelMappings && config.modelMappings.length > 0
      ? { modelMappings: config.modelMappings.map(m => ({
          from: m.from,
          to: m.to,
          ...(m.note ? { note: m.note } : {}),
        })) }
      : {}),
    ...(config.responsesThinking && config.responsesThinking.models.length > 0
      ? { responsesThinking: { models: [...config.responsesThinking.models] } }
      : {}),
  };

  return stringifyYaml(obj, {
    indent: 2,
    lineWidth: 0,        // Don't wrap long strings (URLs, API keys)
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    nullStr: "",
  });
}

/** Basic validation for config saves from the dashboard. Throws on invalid input. */
function validateConfigForSave(cfg: Record<string, unknown>): void {
  const server = cfg.server as Record<string, unknown> | undefined;
  if (server) {
    const port = typeof server.port === "number" ? server.port : parseInt(String(server.port), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error(`server.port ${port} is out of range (1-65535)`);
    }
    if (typeof server.host === "string" && server.host.length > 0) {
      // Basic host validation: IPv4, IPv6, or hostname. Rejects spaces and
      // most special chars. 0.0.0.0 is allowed (bind to all interfaces).
      const hostRe = /^(\d{1,3}\.){3}\d{1,3}$|^[a-fA-F0-9:]+:[a-fA-F0-9:]+$|^[a-zA-Z0-9._-]+$/;
      if (!hostRe.test(server.host)) {
        throw new Error(`server.host "${server.host}" is not a valid IP or hostname`);
      }
    }
  }
  const provider = cfg.provider as string | undefined;
  if (provider && provider !== "zai" && provider !== "bigmodel") {
    throw new Error(`Invalid provider "${provider}": must be "zai" or "bigmodel"`);
  }
  const plan = cfg.plan as string | undefined;
  if (plan && plan !== "coding-plan" && plan !== "start-plan") {
    throw new Error(`Invalid plan "${plan}": must be "coding-plan" or "start-plan"`);
  }

  // Validate providers.*.anthropicBase / openaiBase are URLs (when present).
  // Catches typos like missing https:// or trailing slashes that would 404
  // silently on every request.
  const providers = cfg.providers as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    for (const [name, p] of Object.entries(providers)) {
      for (const field of ["anthropicBase", "openaiBase"]) {
        const v = p?.[field];
        if (typeof v === "string" && v.length > 0) {
          try {
            const u = new URL(v);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error(`providers.${name}.${field} must be http(s):// URL (got ${u.protocol})`);
            }
          } catch (err) {
            throw new Error(`providers.${name}.${field} is not a valid URL: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  // Validate retry config bounds to prevent runaway retry loops.
  // Note: maxRetries has NO upper bound — operators may legitimately want
  // to retry indefinitely (e.g. a flaky upstream during peak hours).
  const retry = cfg.retry as Record<string, unknown> | undefined;
  if (retry) {
    const maxRetries = typeof retry.maxRetries === "number" ? retry.maxRetries : parseInt(String(retry.maxRetries), 10);
    if (Number.isFinite(maxRetries) && maxRetries < 0) {
      throw new Error(`retry.maxRetries ${maxRetries} must be >= 0`);
    }
    const initialDelayMs = typeof retry.initialDelayMs === "number" ? retry.initialDelayMs : parseInt(String(retry.initialDelayMs), 10);
    if (Number.isFinite(initialDelayMs) && (initialDelayMs < 0 || initialDelayMs > 60_000)) {
      throw new Error(`retry.initialDelayMs ${initialDelayMs} is out of range (0-60000)`);
    }
    const maxDelayMs = typeof retry.maxDelayMs === "number" ? retry.maxDelayMs : parseInt(String(retry.maxDelayMs), 10);
    if (Number.isFinite(maxDelayMs) && (maxDelayMs < 0 || maxDelayMs > 300_000)) {
      throw new Error(`retry.maxDelayMs ${maxDelayMs} is out of range (0-300000)`);
    }
    if (Array.isArray(retry.retryableStatuses)) {
      for (const s of retry.retryableStatuses) {
        const n = typeof s === "number" ? s : parseInt(String(s), 10);
        if (!Number.isFinite(n) || n < 100 || n > 599) {
          throw new Error(`retry.retryableStatuses contains invalid status: ${s}`);
        }
      }
    }
    // credentialSwitchThreshold: 0 = disabled, otherwise the number of
    // consecutive failures (including initial) before switching credentials.
    // No upper bound — but if it exceeds maxRetries+1, switching will never
    // trigger (the retry loop exhausts first). We allow any non-negative int.
    const credentialSwitchThreshold = typeof retry.credentialSwitchThreshold === "number"
      ? retry.credentialSwitchThreshold
      : parseInt(String(retry.credentialSwitchThreshold), 10);
    if (Number.isFinite(credentialSwitchThreshold) && credentialSwitchThreshold < 0) {
      throw new Error(`retry.credentialSwitchThreshold ${credentialSwitchThreshold} must be >= 0`);
    }
    // emptyStreamSwitchThreshold (vceshi0.0.5+): 0 = disabled, otherwise the
    // number of consecutive empty-stream 529s before forcing a credential switch.
    const emptyStreamSwitchThreshold = typeof retry.emptyStreamSwitchThreshold === "number"
      ? retry.emptyStreamSwitchThreshold
      : parseInt(String(retry.emptyStreamSwitchThreshold), 10);
    if (Number.isFinite(emptyStreamSwitchThreshold) && emptyStreamSwitchThreshold < 0) {
      throw new Error(`retry.emptyStreamSwitchThreshold ${emptyStreamSwitchThreshold} must be >= 0`);
    }
    // backoffFactor: must be > 0 (0 → all delays become 0, no backoff; negative → invalid)
    const backoffFactor = typeof retry.backoffFactor === "number"
      ? retry.backoffFactor
      : parseFloat(String(retry.backoffFactor));
    if (Number.isFinite(backoffFactor) && backoffFactor <= 0) {
      throw new Error(`retry.backoffFactor ${backoffFactor} must be > 0`);
    }
  }

  // Validate models array is non-empty (after applying changes).
  const models = cfg.models as unknown[] | undefined;
  if (Array.isArray(models) && models.length === 0) {
    throw new Error(`models must contain at least one entry (got empty array)`);
  }
  const defaultModel = cfg.defaultModel as string | undefined;
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    throw new Error(`defaultModel must be a string`);
  }
  // Mirrors loadConfig's auto-append behavior (loader.ts:291-294): if
  // defaultModel is set but not in models[], we add it here so the dashboard
  // save and the next startup agree on what `GET /v1/models` returns.
  // Without this, a dashboard user setting `defaultModel: gpt-4` while
  // `models: [glm-4.6]` would silently grow the array on next loadConfig,
  // producing an inconsistent validation surface.
  if (typeof defaultModel === "string" && defaultModel.length > 0
      && Array.isArray(models) && models.length > 0
      && !models.includes(defaultModel)) {
    models.push(defaultModel);
  }
}

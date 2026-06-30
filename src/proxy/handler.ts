/**
 * Main proxy handler — routes requests, injects auth, forwards, and streams responses.
 *
 * **Translation mode** (OpenAI clients): the proxy translates OpenAI requests
 * to Anthropic format, forwards to the Anthropic upstream (provider's
 * anthropic endpoint in coding-plan, or zcode.z.ai gateway in start-plan),
 * then translates the response back to OpenAI format. Anthropic clients
 * pass through unchanged in both plans.
 *
 * @see .omo/plans/zcode-proxy.md Task 6
 */
import type { Format } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { Credential } from "../auth/types.js";
import { getProvider } from "../provider/providers.js";
import { listModelIds } from "../provider/models.js";
import { buildUpstreamRequest } from "./upstream.js";
import { transformRequestBodyObj } from "./body-transformer.js";
import { detectCaptchaChallenge, getCaptchaToken, invalidateCaptchaToken, RETRY_HEADERS } from "./captcha.js";
import { detectSseErrorAndConvert } from "./sse-error-detector.js";
import { anthropicSseToBatchMessage } from "./sse-to-batch.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { translateRequestResponsesToAnthropic } from "../translator/responses-to-anthropic.js";
import { translateResponseAnthropicToResponses, anthropicSseToResponsesSse } from "../translator/anthropic-to-responses.js";
import { saveTurn } from "../translator/responses-store.js";
import { anthropicSseToOpenaiSse } from "../translator/sse-translator.js";
import type { OpenAIChatRequest, OpenAIResponseRequest, AnthropicMessagesResponse } from "../translator/types.js";
import { pickProxy, markProxyFailed, getMaxRotations, getCurrentWorkingProxy, setCurrentWorkingProxy } from "./proxy-pool.js";
import { wrapFetchWithSocksBridge } from "./proxied-fetch.js";
import { recordStat, recordDebugDump, appendLog } from "../admin/api.js";
import { sleep } from "../utils/sleep.js";
import { exportAccounts, switchAccount, maskApiKey } from "../auth/store.js";
import { recordHeaders } from "../utils/header-debug.js";
import { RETRY as RETRY_CONST, PROXY_POOL as PROXY_POOL_CONST, WAF as WAF_CONST, SSE as SSE_CONST, SSE_HEARTBEAT as SSE_HEARTBEAT_CONST } from "../utils/constants.js";

/** Options for the proxy handler. */
export interface ProxyHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Override the global fetch (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Resolve the TCP-remote client IP for a request. In production this is
   * wired to Bun's `server.requestIP(req)?.address`, which reads the real
   * socket peer address and CANNOT be spoofed by headers. When omitted
   * (e.g., in tests), the proxy path falls back to X-Forwarded-For ONLY
   * when `config.server.trustProxy` is true, otherwise to the empty string.
   *
   * vceshi0.0.8+: previously the sessionCache fingerprint always read XFF
   * without any trust gate, which meant any client could spoof XFF to
   * share/pollute another user's upstream session ID. Now we use the
   * socket address by default and only fall back to XFF when explicitly
   * opted in.
   */
  resolveClientIp?: (req: Request) => string | undefined;
}

/**
 * Forward a client request to the upstream provider with injected auth.
 *
 * Uses `decompress: false` on the upstream fetch so compressed response bodies
 * (gzip/deflate/br) pass through untouched — the raw bytes and Content-Encoding
 * header are forwarded as-is, letting the client handle decompression.
 *
 * Upstream timeout: an AbortController fires after UPSTREAM_TIMEOUT_MS (default
 * 10 minutes for streams, 5 minutes for batch). Without this, a hung upstream
 * TCP connection pins a Bun worker + the client connection indefinitely — under
 * upstream network partitions requests accumulate until OOM or fd exhaustion.
 * The timeout is generous enough to never fire on legitimate LLM calls (the
 * slowest reasonable thinking-trace stream is well under 10 minutes).
 *
 * Connection-level errors (ECONNREFUSED, DNS failure, abort) surface as 502.
 */
/**
 * Default upstream timeout constants. The stream timeout is longer than
 * the batch timeout because LLM streams can legitimately run for many
 * minutes on long reasoning chains.
 *
 * These are DEFAULTS — operators can override via
 * `config.server.upstreamTimeoutMs` (a single value applied to both
 * stream and batch paths). When the config value is set (non-zero), it
 * takes precedence over these constants. When unset (0 or undefined),
 * the constants are used as-is. This lets operators tighten the timeout
 * for fast networks or loosen it for very long context windows without
 * recompiling.
 *
 * vceshi0.0.8+ bugfix: previously these constants were hardcoded and the
 * `config.server.upstreamTimeoutMs` field was parsed by the loader but
 * never read by the handler — the config was effectively dead. Now the
 * handler reads the config value and falls back to these defaults.
 */
const DEFAULT_UPSTREAM_TIMEOUT_STREAM_MS = 10 * 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_BATCH_MS = 5 * 60_000;

export async function proxyRequest(
  clientReq: Request,
  format: Format,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  const { config, auth } = opts;
  // wrapFetchWithSocksBridge transparently routes SOCKS proxies (socks4://,
  // socks4a://, socks5://, socks5h://) through a local HTTP-CONNECT→SOCKS
  // bridge. Bun's native fetch only supports HTTP/HTTPS proxies and would
  // otherwise throw `UnsupportedProxyProtocol` for SOCKS URLs — breaking
  // both the per-account `cred.proxy` and the global proxy pool entries
  // that use a SOCKS scheme. HTTP/HTTPS proxies and direct connections
  // pass through unchanged. The injected `opts.fetchImpl` (used by tests)
  // is wrapped so mock fetches still receive the bridge URL for SOCKS
  // proxies (and the original proxy URL for HTTP proxies).
  const fetchImpl = wrapFetchWithSocksBridge(opts.fetchImpl ?? fetch);
  const started = Date.now();
  const reqId = nextReqId();

  // G1: Request entry log — the FIRST log line for every request, appearing
  // before any routing/transform/upstream log. Without this, the first log
  // for a request appears at the routing stage, making it impossible to
  // correlate "how long did the request wait before routing?" or "which
  // reqId corresponds to this client request?".
  const clientPath = new URL(clientReq.url).pathname;
  const clientMethod = clientReq.method;
  console.log(`${reqId} >>> ${clientMethod} ${clientPath} (${format})`);

  // Debug logging flag — when true, logs the full upstream response details
  // (status + key headers + body preview) for every request. Enabled via
  // config.logging.debug OR env var ZCODE_PROXY_DEBUG_LOGGING=1. This is the
  // "调试日志" the user requested: see exactly what 529 / empty 200 / etc.
  // the upstream returns, including the error JSON body.
  const debugLoggingEnabled = config.logging?.debug === true
    || process.env.ZCODE_PROXY_DEBUG_LOGGING === "1";

  const body = await readBody(clientReq);

  // G7: Log actual body size (more accurate than Content-Length header, which
  // may be absent for chunked transfers or inaccurate for compressed bodies).
  if (body && body.length > 0) {
    const sizeKB = (body.length / 1024).toFixed(1);
    console.log(`${reqId} body size: ${sizeKB}KB (${body.length} bytes)`);
  }

  // Parse the body once and reuse the parsed object throughout the pipeline.
  // Previously the body string was JSON.parse'd up to 3 times (peekBody,
  // translateOpenAIBody, transformRequestBody) — now we parse once.
  let parsedBody: unknown;
  if (body && body.length > 0) {
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      const meta: RequestMeta = { model: "-", stream: false };
      printRow(reqId, format, meta, 400, started, Date.now(), 0, 0, 0);
      return errorResponse(400, "invalid_json", `Request body is not valid JSON: ${(err as Error).message}`);
    }
  }

  // Strip "[undefined]" string values from the parsed body.
  //
  // Some clients (notably Cherry Studio) serialize JavaScript `undefined`
  // values as the literal STRING "[undefined]" instead of omitting the field.
  // JSON.parse then turns these into string values, not undefined — so they
  // pass through to z.ai as actual request fields like:
  //   "temperature": "[undefined]"
  //   "system": "[undefined]"
  //   "tools": "[undefined]"
  //
  // These garbage fields are a strong WAF fingerprint — no real client
  // would ever send them. z.ai's WAF scores requests containing these as
  // script traffic and starts blocking. We recursively strip any field
  // whose value is exactly the string "[undefined]".
  if (parsedBody && typeof parsedBody === "object") {
    const removed = stripUndefinedStringFields(parsedBody as Record<string, unknown>);
    if (removed > 0) {
      console.log(`${reqId} stripped ${removed} "[undefined]" field(s) from request body`);
    }
  }

  const meta = peekParsedBody(parsedBody);

  // Per-model routing rules: if any rule's pattern matches the request's
  // model field (glob-style, e.g. "glm-5*" matches "glm-5.1"), override the
  // provider/endpoint. Previously the rules were configured but never
  // consulted at request time — making the entire feature a no-op.
  const matchedRule = meta.model !== "-" && config.routingRules && config.routingRules.length > 0
    ? config.routingRules.find(r => globMatch(r.pattern, meta.model))
    : undefined;
  const effectiveProviderId = matchedRule?.provider ?? config.provider;

  const staticProvider = getProvider(effectiveProviderId);
  const provider = {
    ...staticProvider,
    anthropicBaseURL: config.providers[effectiveProviderId].anthropicBase,
    openaiBaseURL: config.providers[effectiveProviderId].openaiBase,
  };
  if (matchedRule) {
    console.log(`${reqId} routing rule matched: ${matchedRule.pattern} → provider=${matchedRule.provider}${matchedRule.endpoint ? `, endpoint=${matchedRule.endpoint}` : ""}`);
    // Note: matchedRule.endpoint is currently used for documentation/UI only.
    // Applying a custom endpoint here would require restructuring buildUpstreamURL
    // to accept a URL override; tracked separately. For now, the rule's provider
    // override is applied (the most common use case).
  }

  let cred: Credential;
  try {
    cred = await auth.getCredential();
  } catch (err) {
    printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
    return errorResponse(503, "credential_unavailable", (err as Error).message);
  }

  // Translation mode: OpenAI client formats are routed through the Anthropic
  // upstream (provider's anthropic endpoint in coding-plan, or zcode.z.ai
  // gateway in start-plan). The request body is translated OpenAI→Anthropic,
  // and the response is translated back Anthropic→OpenAI.
  //
  // "openai"           → Chat Completions format
  // "openai-responses" → Responses API format (used by Codex CLI)
  const translateMode = format === "openai" || format === "openai-responses";
  const upstreamFormat: Format = translateMode ? "anthropic" : format;

  // Model rewrite for translation modes:
  //   1. If client-sent model matches a modelMappings entry (case-insensitive),
  //      rewrite to the mapped target.
  //   2. Else if the model is not a known GLM model (e.g. Codex CLI's "gpt-5.5"),
  //      fall back to config.defaultModel so GLM upstream doesn't 400.
  // Original model is preserved in the response echo for client compatibility.
  //
  // This is only applied in translation mode because passthrough mode lets the
  // upstream decide (matches the original proxy semantics — see README: "the
  // listing is informational, not a gate").
  if (translateMode && parsedBody && typeof parsedBody === "object") {
    const bodyObj = parsedBody as Record<string, unknown>;
    const clientModel = typeof bodyObj.model === "string" ? bodyObj.model : "";
    if (clientModel) {
      const mapped = lookupModelMapping(clientModel, config.modelMappings);
      if (mapped) {
        console.log(`${reqId} model mapping: ${clientModel} → ${mapped} (configured)`);
        bodyObj.model = mapped;
        meta.model = mapped;
      } else if (!isKnownGlmModel(clientModel)) {
        const fallback = config.defaultModel || "glm-4.6";
        console.log(`${reqId} model fallback: ${clientModel} → ${fallback} (non-GLM model not accepted upstream)`);
        bodyObj.model = fallback;
        meta.model = fallback;
      }
    }
  }

  // =====================================================================
  //  FORMAT CONVERSION ORCHESTRATION (Claude Code + Codex → ZCode upstream)
  // =====================================================================
  //  Two client paths converge here before forwarding to z.ai upstream:
  //
  //    Claude Code (anthropic)  ─→  NO translation needed (already Anthropic)
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //    Codex      (responses)  ─→  responses-to-anthropic.translateRequest...
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //    OpenAI     (openai)     ─→  openai-to-anthropic.translateRequest...
  //                                 ↓
  //                                 body-transformer.alignZCodeRequestFormat
  //                                 ↓
  //                                 upstream
  //
  //  Both translators + alignZCodeRequestFormat are MARKED as format conversion
  //  boundaries — see the doc comments in those files. Do NOT casually modify
  //  them; run the alignment test scripts first if you must.
  //
  //  Verification scripts:
  //    /home/z/my-project/scripts/test_alignment.ts            (Claude Code)
  //    /home/z/my-project/scripts/test_responses_alignment.ts  (Codex)
  // =====================================================================
  let upstreamBodyObj: unknown = parsedBody;
  if (translateMode) {
    const forceThinkingModels = format === "openai-responses"
      ? config.responsesThinking?.models
      : undefined;
    const translated = translateClientBodyObj(parsedBody, format, forceThinkingModels ? { forceThinkingModels } : undefined);
    if (translated instanceof Response) return translated;
    upstreamBodyObj = translated;
  }

  // currentPlan tracks the effective plan for the CURRENT credential. It starts
  // as config.plan but is updated whenever the credential is switched mid-retry
  // (vceshi0.0.5+ fix for the "cross-plan credential switch" bug). Without this,
  // switching from a coding-plan cred to a start-plan cred (or vice versa) would
  // keep using the old plan's upstream URL, auth headers, and captcha logic —
  // guaranteeing the retried request fails the same way.
  let currentPlan: "coding-plan" | "start-plan" = config.plan;
  const effectivePlanForCred = (c: Credential): "coding-plan" | "start-plan" => {
    if (c.plan === "start-plan" || c.plan === "coding-plan") return c.plan;
    // Infer from JWT presence (matches store.ts inferPlan logic)
    return c.jwt ? "start-plan" : "coding-plan";
  };

  let transformedObj = transformRequestBodyObj(upstreamBodyObj, { format: upstreamFormat, userId: cred.userId, startPlan: currentPlan === "start-plan", thinkingLevel: config.thinkingLevel === "high" ? "high" : "max" });

  // v0.2.2+ PERF: cache transformed body keyed by (userId|plan|thinkingLevel).
  // On credential switch mid-retry, the transform is re-run even though
  // only `userId` (and possibly `plan`) actually changed — for coding-plan
  // switches the userId isn't even applied (applyAnthropicUserId is a no-op
  // when startPlan=false), so the transform output is IDENTICAL. Re-running
  // it on a 90KB body costs ~5-10ms each time, plus another 3-5ms for
  // JSON.stringify. Caching shaves 8-30ms off each credential switch retry.
  //
  // IMPORTANT: this does NOT touch the ZCode wire-shape transform logic
  // itself — `alignZCodeRequestFormat`, `sanitizeContentBlocks`, etc. all
  // still run; we just don't re-run them when the inputs are unchanged.
  let transformedCacheKey = `${cred.userId ?? ""}|${currentPlan}|${config.thinkingLevel ?? ""}`;
  let transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
  // Cache the (key → { obj, body }) pair so a credential switch can
  // short-circuit when the new key matches.
  const transformedCache = new Map<string, { obj: unknown; body: string | undefined }>();
  if (transformedObj !== undefined) {
    transformedCache.set(transformedCacheKey, { obj: transformedObj, body: transformedBody });
  }
  /**
   * Re-run the transform only when (userId|plan|thinkingLevel) actually
   * changed. Returns the cached values otherwise. Safe to call after a
   * credential switch — the closure captures `upstreamBodyObj` and
   * `upstreamFormat` which never change within a single request.
   */
  const rebuildTransformedBody = (newUserId: string | undefined, newPlan: "coding-plan" | "start-plan"): void => {
    const newKey = `${newUserId ?? ""}|${newPlan}|${config.thinkingLevel ?? ""}`;
    if (newKey === transformedCacheKey) {
      // Inputs unchanged — keep existing transformedObj/transformedBody.
      return;
    }
    const cached = transformedCache.get(newKey);
    if (cached) {
      transformedObj = cached.obj;
      transformedBody = cached.body;
      transformedCacheKey = newKey;
      return;
    }
    // Cache miss — actually run the transform.
    transformedObj = transformRequestBodyObj(upstreamBodyObj, {
      format: upstreamFormat,
      userId: newUserId,
      startPlan: newPlan === "start-plan",
      thinkingLevel: config.thinkingLevel === "high" ? "high" : "max",
    });
    transformedBody = transformedObj !== undefined ? JSON.stringify(transformedObj) : undefined;
    transformedCacheKey = newKey;
    if (transformedObj !== undefined) {
      transformedCache.set(newKey, { obj: transformedObj, body: transformedBody });
    }
  };

  // v0.2.0.4: `stream: true` is now forced unconditionally inside
  // alignZCodeRequestFormat (body-transformer.ts) to match the real ZCode
  // desktop client's wire shape. The separate `forceStreamAnthropic` config
  // toggle has been removed — there is no longer a "respect client stream
  // preference" mode. The response path buffers SSE → batch JSON for clients
  // that originally requested non-streaming, so this is transparent to them.

  // (transformedBody is declared above, alongside the transform cache.)

  // Diagnostic: log thinking-block strip counts so users can verify the fix
  // is actually running. If the count goes from N → 0, the strip worked.
  // If N > 0 in the transformed body, something is wrong.
  if (format === "anthropic") {
    const before = countThinkingBlocks(parsedBody);
    const after = countThinkingBlocks(transformedObj);
    if (before > 0 || after > 0) {
      console.log(`${reqId} thinking blocks: ${before} → ${after} (stripped ${before - after})`);
    }
    // Also log cache_control-on-tool_result strip counts — this was the
    // root cause of the v2.1.3.4beta0 start-plan 3001.
    const ccBefore = countToolResultCacheControl(parsedBody);
    const ccAfter = countToolResultCacheControl(transformedObj);
    if (ccBefore > 0 || ccAfter > 0) {
      console.log(`${reqId} tool_result+cache_control: ${ccBefore} → ${ccAfter} (stripped ${ccBefore - ccAfter})`);
    }
  }

  let captchaHeaders: Record<string, string> | undefined;
  // Track cumulative captcha solve time for this request (G4: TTFB split).
  // Each captcha solve takes 20-40s; knowing how much of TTFB is captcha
  // vs actual upstream latency is critical for diagnosing slow start-plan
  // requests.
  let totalCaptchaMs = 0;
  // v0.1.8+ EVERY FETCH GETS A FRESH TOKEN.
  //
  // Aliyun verifyParam is consumed on EVERY upstream response — not just on
  // 403 captcha failure. Even a successful 200 / 529 / 429 response consumes
  // the token. Reusing the same token on retry → 403 "captcha verify failed"
  // (code 3007).
  //
  // v0.1.7 had a per-request cache that reused the token on 529 retries,
  // assuming "529 means captcha passed". WRONG — zcode.z.ai consumes the
  // token regardless of the response status. This caused 3007 errors on
  // every retry after the first attempt.
  //
  // v0.1.8 fix: NO per-request cache. Every fetchUpstreamDetected() call
  // solves a fresh token. This adds ~20-40s per retry (JSDOM solve time),
  // but it's the only correct behavior given Aliyun's one-shot semantics.
  //
  // handleCaptchaChallenge() is kept as a fast-path for 403 (re-solve +
  // immediate retry without waiting for the next loop iteration), but it
  // no longer caches the result.
  if (currentPlan === "start-plan") {
    try {
      const token = await getCaptchaToken(reqId);
      totalCaptchaMs += token.solveMs;
      captchaHeaders = { [RETRY_HEADERS.PARAM]: token.verifyParam, [RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Will solve on 403 fallback below
    }
  }

  // Factory that builds a FRESH Request object for each fetch call.
  // Request bodies are single-use — once fetch() consumes the body, the same
  // Request object cannot be passed to fetch() again (throws
  // "Request body already used"). This bit us hard on retries: the first
  // request would succeed or fail, then every retry would throw that error,
  // get caught by the catch block, and get converted to a synthetic 502 —
  // making retries completely ineffective.
  const buildUpstreamReq = (captcha?: Record<string, string>) =>
    buildUpstreamRequest(
      clientReq,
      upstreamFormat,
      provider,
      cred,
      transformedBody,
      config.identity,
      currentPlan,
      captcha,
      opts.resolveClientIp,
      config.server.trustProxy,
    );

  // Track the last anthropic-beta header actually sent upstream. Since v0.2.0.6
  // we strip anthropic-beta ENTIRELY (the real ZCode client sends none — see
  // upstream.ts STRIP_HEADERS), so this is always null on the wire. Kept for
  // diagnostic completeness: the `anthropic-beta sent:` log line confirms the
  // header is absent, and if a future change re-enables beta this capture
  // already wires it to the real fetch (no throwaway Request needed).
  let lastSentBeta: string | null = null;

  // === Global proxy pool integration ===
  // Resolution order (per the user spec "优先级低于单账号设置的代理"):
  //   1. cred.proxy (per-account override) — highest priority
  //   2. proxy pool (pickProxy round-robin) — fallback when no per-account proxy
  //   3. direct connection (no proxy)
  //
  // The currentRequestProxy is tracked per-request so that on a 405/WAF block
  // we can rotate to a DIFFERENT pool proxy and retry. Proxies already tried
  // in this request are kept in `triedPoolProxies` so we don't cycle back.
  let currentRequestProxy: string | undefined = undefined;
  // v0.2.2+ FIX: triedPoolProxies now uses a Map<url, triedAt> with a TTL
  // cooldown. Previously a Set accumulated across all retries in the
  // request — once a proxy was tried (even on a transient WAF blip), it was
  // excluded for ALL subsequent retries, even if it had recovered by then.
  // In the worst case (maxRotations=3, maxRetries=3) this exhausted the
  // pool and forced a direct connection that was guaranteed to fail.
  //
  // With TTL cooldown (default 60s), a proxy becomes eligible again after
  // the cooldown expires — retries have a fair chance of succeeding.
  const triedPoolProxies = new Map<string, number>();
  const isProxyInCooldown = (url: string): boolean => {
    const triedAt = triedPoolProxies.get(url);
    if (triedAt === undefined) return false;
    if (Date.now() - triedAt > PROXY_POOL_CONST.TRIED_TTL_MS) {
      triedPoolProxies.delete(url);
      return false;
    }
    return true;
  };
  const markProxyTried = (url: string): void => {
    triedPoolProxies.set(url, Date.now());
  };
  // Adapter Set view for pickProxy's excludeUrls param (filters by TTL).
  // Built fresh on each call so the cooldown check fires at lookup time.
  const triedProxySetView = (): Set<string> => {
    const s = new Set<string>();
    for (const url of triedPoolProxies.keys()) {
      if (isProxyInCooldown(url)) s.add(url);
    }
    return s;
  };

  // Fetch + SSE error detection in one shot. Used for both the initial fetch
  // AND every retry, so SSE errors hidden in 200 streams are caught on every
  // attempt — not just the first one.
  //
  // An AbortController applies an upstream timeout: 10 min for streaming
  // requests (LLM thinking traces can be long), 5 min for batch. Prevents a
  // hung upstream TCP connection from pinning a Bun worker forever.
  //
  // Per-account outbound proxy (v2.1.4.1test5+): if `cred.proxy` is set,
  // route the upstream fetch through that proxy via Bun's native
  // `{ proxy: url }` RequestInit option. We re-read `cred.proxy` on EVERY
  // call (not captured in a closure) so a credential switch mid-retry picks
  // up the new account's proxy automatically — without this, switching from
  // a proxied account to a direct one would keep using the old proxy.
  //
  // Global proxy pool (v0.2.2+): when `cred.proxy` is NOT set, we consult
  // the pool (pickProxy) for a fallback proxy. The picked proxy is stored
  // in `currentRequestProxy` so the WAF-rotation path can advance to the
  // next one on retry.
  const fetchUpstreamDetected = async (captcha?: Record<string, string>, isInitialAttempt: boolean = false): Promise<Response> => {
    const req = buildUpstreamReq(captcha);
    lastSentBeta = req.headers.get("anthropic-beta");

    // v0.2.0.9+: header debug logging — record the inbound client request
    // headers + the translated upstream request headers to a JSON file, so
    // the operator can diff "what the client sent" vs "what the proxy sent
    // upstream" and verify the translation pipeline has no header defects.
    //
    // Only the FIRST fetch attempt per request is recorded. Retries and
    // captcha re-solve fetches pass isInitialAttempt=false (the default),
    // so they skip this block entirely — one pair per request, no noise
    // from retries. This is the user-requested behaviour: "重试的不记录".
    //
    // v0.2.0.9: recordHeaders writes TWO files — {prefix}_inbound.json
    // (the raw client request) and {prefix}_upstream.json (the translated
    // request sent to z.ai). Pass the raw `body` (client request body as
    // received) as inboundBody so the operator can diff client body vs
    // translated body alongside the header diff.
    //
    // Fire-and-forget (recordHeaders is async, never awaited, never throws).
    if (isInitialAttempt && config.logging?.headerDebug) {
      try {
        recordHeaders(clientReq, req, reqId, format, transformedBody, body);
      } catch (e) {
        // Defensive — recordHeaders already swallows errors, but belt + suspenders.
        void e;
      }
    }

    // vceshi0.0.8+: read the operator-configured upstream timeout (if any)
    // and fall back to the hardcoded defaults. A single config value applies
    // to BOTH stream and batch paths — operators who want different stream
    // vs batch timeouts should leave this unset and rely on the defaults.
    const configuredTimeout = config.server.upstreamTimeoutMs ?? 0;
    const defaultTimeout = meta.stream ? DEFAULT_UPSTREAM_TIMEOUT_STREAM_MS : DEFAULT_UPSTREAM_TIMEOUT_BATCH_MS;
    const timeoutMs = configuredTimeout > 0 ? configuredTimeout : defaultTimeout;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Bun's native fetch accepts `{ proxy: "http://..." }` / `socks5://...`
    // Cast through `any` because the option is Bun-specific and not in the
    // standard TypeScript DOM RequestInit type.
    const fetchOpts: any = {
      ...(translateMode ? {} : { decompress: false }),
      signal: ctrl.signal,
    };
    // === Proxy resolution (v0.2.2+ global pool) ===
    // Priority: cred.proxy (per-account) > pool (sticky/round-robin) > direct.
    if (cred.proxy) {
      fetchOpts.proxy = cred.proxy;
    } else {
      // Pool consultation is best-effort: if the pool is disabled or empty,
      // pickProxy returns null and we fall through to a direct connection.
      //
      // Sticky behavior: pickProxy returns the current "working" proxy if
      // one is set (from a previous successful request), so subsequent
      // requests reuse the same proxy until it fails. On failure
      // (markProxyFailed), the sticky proxy is cleared and the next pickProxy
      // advances to a new one.
      if (!currentRequestProxy) {
        try {
          const picked = await pickProxy(triedProxySetView());
          if (picked) {
            currentRequestProxy = picked;
            markProxyTried(picked);
            // Log which proxy is being used for this request. Sticky proxies
            // (reused from a previous success) are marked accordingly.
            const sticky = getCurrentWorkingProxy() === picked;
            console.log(`${reqId} proxy: ${picked}${sticky ? " (sticky)" : ""}`);
          }
        } catch (e) {
          // Pool must NEVER break the request — log and fall through.
          console.log(`${reqId} proxy pool pick failed: ${(e as Error).message}`);
        }
      }
      if (currentRequestProxy) {
        fetchOpts.proxy = currentRequestProxy;
      }
    }
    let resp: Response;
    try {
      resp = await fetchImpl(req, fetchOpts);
    } catch (err) {
      clearTimeout(timer);
      // Distinguish abort (timeout) from real network errors so the error
      // message surfaces the actual cause to the client.
      if (ctrl.signal.aborted) {
        throw new Error(`upstream timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
    clearTimeout(timer);
    // vceshi0.0.6+: verbose logging — log the upstream request headers + body
    // when logging.verbose is enabled. Auth tokens are masked to avoid leaking
    // secrets to the dashboard log panel. Truncated to 2000 chars to avoid
    // flooding the 500-char-per-line log buffer (appendLog truncates anyway,
    // but we truncate here too so the console output stays readable).
    if (config.logging?.verbose) {
      try {
        const headerSummary: Record<string, string> = {};
        for (const [k, v] of req.headers.entries()) {
          const lk = k.toLowerCase();
          // Mask auth-bearing headers
          if (lk === "authorization" || lk === "x-api-key") {
            headerSummary[k] = v.length > 12 ? v.slice(0, 8) + "..." + v.slice(-4) : "***";
          } else {
            headerSummary[k] = v;
          }
        }
        console.log(`${reqId} [verbose] upstream headers: ${JSON.stringify(headerSummary)}`);
        if (transformedBody) {
          const bodyPreview = transformedBody.length > 2000
            ? transformedBody.slice(0, 2000) + `...(truncated, total ${transformedBody.length} chars)`
            : transformedBody;
          console.log(`${reqId} [verbose] transformed body: ${bodyPreview}`);
        }
      } catch { /* verbose logging must never break the request */ }
    }
    if (resp.status === 200) {
      const originalStatus = resp.status;
      resp = await detectSseErrorAndConvert(resp);
      if (resp.status !== originalStatus) {
        console.log(`${reqId} SSE error detected in 200 stream → HTTP ${resp.status}`);
      }
    }
    // DEBUG: log the upstream response details for debugging quota / empty /
    // error issues. Enabled when config.logging.debug is true (or env var
    // ZCODE_PROXY_DEBUG_LOGGING=1). Shows status, key headers, and a body
    // preview so the user can see EXACTLY what the upstream returned —
    // whether it's a 529 with an error JSON, an empty 200, or a real
    // response. This is the "调试日志" the user requested: "无论返回什么
    // 都能看到它具体返回啥的东西，比如529还是空回200都能看到具体返回的参数".
    if (debugLoggingEnabled) {
      logUpstreamResponseDebug(reqId, resp, meta.stream);
    }
    return resp;
  };

  // Get a FRESH captcha token for every fetch attempt. No cache.
  //
  // v0.1.8+: Aliyun verifyParam is consumed on EVERY upstream response (200,
  // 529, 429, 403 — all of them). Reusing a token on retry → 3007 error.
  // So every call to refreshCaptchaHeaders() solves a fresh token.
  //
  // This adds ~20-40s per retry (JSDOM solve time), but it's mandatory.
  // The solveMutex in captcha.ts serializes solves so only one JSDOM
  // exists at a time (prevents OOM).
  //
  // Called before EVERY fetch attempt (initial + retries). The mutex
  // ensures concurrent requests solve sequentially, not in parallel.
  //
  // v0.2.2+ FIX: distinguish hard fails (config unavailable, network down)
  // from soft fails (transient solve error). Hard fails throw a tagged
  // error that bubbles up to break the retry loop — without this, the
  // loop would burn 120s of captcha timeouts PER credential switch,
  // sometimes running 10+ minutes before surfacing the error to the
  // client. The "captcha_config_unavailable" tag is detected in the
  // catch block of fetchUpstreamDetected / handleCaptchaChallenge.
  const CAPTCHA_CONFIG_UNAVAILABLE = "captcha_config_unavailable";
  const refreshCaptchaHeaders = async (): Promise<Record<string, string> | undefined> => {
    if (currentPlan !== "start-plan") return undefined;
    try {
      const token = await getCaptchaToken(reqId);
      totalCaptchaMs += token.solveMs;
      return { [RETRY_HEADERS.PARAM]: token.verifyParam, [RETRY_HEADERS.REGION]: token.region };
    } catch (err) {
      // v0.2.2+: distinguish three failure modes:
      //   1. configFetchFailed=true → network error fetching the captcha
      //      config from zcode.z.ai. Retrying won't help — hard-fail the
      //      retry loop to avoid burning 15s × N retries on a dead network.
      //   2. "captcha_disabled_by_config" → the upstream returned a config
      //      with captcha disabled (or missing fields). This is the test
      //      environment / "upstream doesn't require captcha" case. Soft-fail:
      //      skip captcha headers, let the upstream decide.
      //   3. Any other error → transient solve failure (SDK timeout, JSDOM
      //      hiccup). Soft-fail: the resulting 403 will trigger
      //      handleCaptchaChallenge's re-solve path which has its own budget.
      const taggedErr = err as Error & { configFetchFailed?: boolean };
      if (taggedErr.configFetchFailed === true) {
        const wrapped = new Error(`${CAPTCHA_CONFIG_UNAVAILABLE}: ${(err as Error).message}`);
        (wrapped as Error & { captchaConfigUnavailable?: boolean }).captchaConfigUnavailable = true;
        throw wrapped;
      }
      // Soft fail (cases 2 and 3) — return undefined and let the fetch proceed.
      return undefined;
    }
  };

  // Handle a 403 captcha challenge by re-solving and retrying with a fresh
  // token. Returns the new response, or a synthetic 503 if re-solve fails.
  // Used both for the initial fetch AND for retry-loop fetches — without
  // this, a retry that returns 403 would leak through to the client.
  //
  // v0.1.8+: NO per-request cache. The re-solved token is used only for
  // this single fetch — the next retry will solve again via
  // refreshCaptchaHeaders(). This is intentional: Aliyun tokens are
  // one-shot, caching them invites 3007 errors.
  const handleCaptchaChallenge = async (resp: Response): Promise<Response> => {
    try { resp.body?.cancel(); } catch {}
    console.log(`${reqId} captcha challenge (403), re-solving...`);
    invalidateCaptchaToken(); // no-op in v0.1.8+, kept for API compat
    try {
      const fresh = await getCaptchaToken(reqId);
      totalCaptchaMs += fresh.solveMs;
      console.log(`${reqId} captcha re-solved (token ${fresh.verifyParam.length} chars, ${fresh.solveMs}ms), retrying...`);
      const freshCaptcha = {
        [RETRY_HEADERS.PARAM]: fresh.verifyParam,
        [RETRY_HEADERS.REGION]: fresh.region,
      };
      const newResp = await fetchUpstreamDetected(freshCaptcha);
      headersAt = Date.now();
      return newResp;
    } catch (err) {
      console.log(`${reqId} captcha re-solve failed: ${(err as Error).message}`);
      // Return a synthetic 503 so caller can decide what to do
      return errorResponse(503, "captcha_solver_failed", (err as Error).message);
    }
  };

  let upstreamResp: Response;
  try {
    // Always refresh captcha token right before the fetch — the token we
    // got at the start of this function might have expired by now if there
    // was any await in between (config loading, body parsing, etc.).
    captchaHeaders = await refreshCaptchaHeaders();
    // isInitialAttempt=true: this is the FIRST fetch for this request.
    // Header debug logging (if enabled) records inbound + upstream headers
    // here. Retries below call fetchUpstreamDetected without this flag, so
    // only the first attempt is logged.
    upstreamResp = await fetchUpstreamDetected(captchaHeaders, true);
  } catch (err) {
    // v0.2.2+: hard-fail captcha config errors with a specific status code
    // so the client (Claude Code, OpenAI SDK) doesn't waste retry budget.
    const isCaptchaConfigHardFail = (err as Error & { captchaConfigUnavailable?: boolean }).captchaConfigUnavailable === true;
    if (isCaptchaConfigHardFail) {
      printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
      return errorResponse(503, "captcha_config_unavailable", (err as Error).message);
    }
    printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
    return errorResponse(502, "upstream_unreachable", (err as Error).message);
  }
  let headersAt = Date.now();

  // === WAF 拦截检测 ===
  // z.ai / zcode.z.ai 用阿里云 WAF。被拦截时返回:
  //   - HTTP 405 / 403 / 200 + content-type: text/html
  //   - body 是阿里云拦截页 HTML，含 `errors.aliyun.com` 字样
  //   - server: Tengine
  //
  // 这种响应绝对不能重试 — 越撞越黑。立即返回一个明确的错误，避免
  // 进入 retry 循环让 IP 越拉越黑。
  // vceshi0.0.8+: checkWafBlock consumes the body to inspect it, and on
  // the non-WAF path returns a FRESH Response with the body reconstructed.
  // We reassign `upstreamResp` to the fresh response so all downstream
  // code (`.body.tee()`, `.text()`, `.json()`) works as if the inspection
  // never happened. Previously, the non-WAF path left `upstreamResp.body`
  // in a consumed/locked state, causing `body.tee()` to throw on rare
  // 200 + HTML upstream responses.
  const wafCheck = await checkWafBlock(upstreamResp);
  if (wafCheck.wafBlocked) {
    // === v0.2.2+ Proxy rotation on WAF block ===
    // The original behavior was: STOP all retries immediately. Hammering the
    // WAF from a blacklisted IP makes the blacklist worse.
    //
    // With the global proxy pool, we have a third option: rotate to a
    // DIFFERENT proxy and retry. The new IP may not be blacklisted. We try
    // up to `pool.config.maxRotations` (default 3) different proxies before
    // giving up. Each tried proxy is added to `triedPoolProxies` so we don't
    // cycle back to it within the same request.
    //
    // Conditions for rotation:
    //   1. We were using a pool proxy (currentRequestProxy is set AND came
    //      from the pool, not from cred.proxy — per-account proxy rotation
    //      is a separate concern and we don't touch it here).
    //   2. The pool still has untried proxies.
    //   3. We haven't exceeded maxRotations.
    //
    // If rotation is not possible (no pool, no untried proxies, or per-account
    // proxy was in use), we fall back to the original "stop & return 503" path.
    const ct = upstreamResp.headers.get("content-type") ?? "";
    console.error(
      `${reqId} ⚠️  ALIYUN WAF BLOCK DETECTED — status=${upstreamResp.status}, ` +
      `content-type=${ct}. Will attempt proxy rotation if pool has alternatives.`,
    );

    // Mark the current pool proxy as failed (best-effort).
    if (currentRequestProxy) {
      try { await markProxyFailed(currentRequestProxy); } catch { /* non-fatal */ }
    }

    // Try rotating through up to maxRotations different pool proxies.
    // maxRotations comes from the pool config (default 3); read it fresh
    // so a dashboard config change takes effect immediately.
    const maxRotations = await getMaxRotations().catch(() => 3);
    let rotated = false;
    if (maxRotations > 0) {
      for (let rot = 0; rot < maxRotations; rot++) {
      // If we were using a per-account proxy (cred.proxy), there's no pool
      // rotation to do — bail and surface the WAF error.
      if (cred.proxy) break;

      // Force pickProxy to skip the current proxy by clearing
      // currentRequestProxy and adding it to the tried set (already done).
      currentRequestProxy = undefined;
      let nextProxy: string | null = null;
      try {
        nextProxy = await pickProxy(triedProxySetView());
      } catch (e) {
        console.log(`${reqId} proxy pool rotation failed: ${(e as Error).message}`);
        break;
      }
      if (!nextProxy) {
        // No more untried proxies in the pool — give up.
        console.log(`${reqId} proxy pool exhausted after ${rot} rotation(s) — surfacing WAF error`);
        break;
      }
      currentRequestProxy = nextProxy;
      markProxyTried(nextProxy);
      console.log(`${reqId} WAF rotation ${rot + 1}/${maxRotations}: switching to proxy ${nextProxy}`);

      // Cancel the old response body before refetching.
      try { upstreamResp.body?.cancel(); } catch (e) { void e; }

      // Refetch with the new proxy. Captcha is refreshed per-fetch; for
      // start-plan we get a fresh token, for coding-plan we skip it.
      try {
        const rotCaptcha = await refreshCaptchaHeaders();
        upstreamResp = await fetchUpstreamDetected(rotCaptcha);
        headersAt = Date.now();
      } catch (err) {
        console.log(`${reqId} WAF rotation ${rot + 1} fetch failed: ${(err as Error).message}`);
        // Network error with this proxy — try the next one.
        try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
        continue;
      }

      // Re-check the new response for WAF block. If it's still blocked,
      // loop and try the next proxy. If it's NOT a WAF block, we're done.
      const rotWafCheck = await checkWafBlock(upstreamResp);
      if (!rotWafCheck.wafBlocked) {
        upstreamResp = rotWafCheck.response;
        console.log(`${reqId} WAF rotation ${rot + 1} succeeded — request now proceeds with proxy ${nextProxy}`);
        rotated = true;
        break;
      }
      // Still blocked — mark this proxy failed and try the next one.
      try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
      console.log(`${reqId} WAF rotation ${rot + 1} still blocked on proxy ${nextProxy}`);
      }
    }

    if (!rotated) {
      // All rotations failed (or none were possible). Return the WAF error.
      try { upstreamResp.body?.cancel(); } catch (e) { void e; }
      printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
      return errorResponse(
        503,
        "waf_blocked",
        "Request blocked by Aliyun WAF (status=" + upstreamResp.status + "). " +
        "Your IP is likely blacklisted. Stop retrying immediately, change IP, and wait before retrying. " +
        "See: https://errors.aliyun.com",
      );
    }
    // Rotated successfully — fall through to normal response handling.
  } else {
    // Not a WAF block — use the reconstructed response (fresh readable body).
    upstreamResp = wafCheck.response;
  }

  if (upstreamResp.status === 401 && currentPlan === "start-plan") {
    printRow(reqId, format, meta, 401, started, headersAt, 0, 0, 0);
    return errorResponse(401, "start_plan_jwt_invalid", "Start-plan JWT was rejected. Re-run: zcode-proxy auth login");
  }

  // start-plan: on 403 captcha challenge, force re-solve and retry once.
  // This handles the INITIAL response. Retries that return 403 are handled
  // inside the retry loop below via the same handleCaptchaChallenge() helper.
  if (currentPlan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
    upstreamResp = await handleCaptchaChallenge(upstreamResp);
    // If captcha re-solve itself failed, bail out.
    //
    // v0.2.1.8 BUGFIX (ReadableStream is locked):
    //   Previously this block called `await upstreamResp.text()` to inspect
    //   the error JSON, then `return upstreamResp`. But `errorResponse()`
    //   constructs the Response with a string body, which Bun wraps in a
    //   single-consumer ReadableStream. Once `.text()` drains that stream,
    //   the Response is "locked" — returning it to the server causes:
    //     TypeError: ReadableStream is locked
    //     at <anonymous> (native:1:11)
    //   which surfaces as an unhandledRejection and breaks the client
    //   connection (Claude Code / OpenAI SDK see a truncated response).
    //
    //   The fix: clone the Response *before* reading. `Response.clone()`
    //   produces an independent copy whose body can be consumed without
    //   locking the original. We then read the clone, and return the
    //   pristine original to the server.
    //
    //   This also matches the pattern used elsewhere in this file (e.g.
    //   the non-streaming JSON passthrough path) where the body is read
    //   for stats but the Response is rebuilt for return.
    if (upstreamResp.status === 503 && upstreamResp.headers.get("content-type")?.includes("application/json")) {
      // Clone FIRST so the original's body stays readable for return.
      const probe = upstreamResp.clone();
      try {
        const body = await probe.text();
        const parsed = JSON.parse(body);
        if (parsed?.error?.type === "captcha_solver_failed") {
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
          return upstreamResp;
        }
      } catch { /* not a captcha_solver_failed response — continue */ }
    }
  }

  // SSE error detection for the initial response is already handled inside
  // fetchUpstreamDetected() above. The standalone detection block that used
  // to live here has been removed — fetchUpstreamDetected now handles it
  // uniformly for both the initial fetch and every retry.

  // Retry on retryable status codes (e.g. 529 site overloaded, 429 rate limited)
  // Uses exponential backoff with jitter, and respects Retry-After header.
  //
  // CRITICAL: Each retry MUST build a fresh Request via fetchUpstreamDetected().
  // Reusing the same Request object fails with "Request body already used"
  // because fetch() consumes the body on the first call — this was the bug
  // where every retry after the first would silently fail with a synthetic 502.
  //
  // === CRITICAL FIX (命令行还在继续重试 bug) ===
  // Declared OUTSIDE the retry-if block so the post-retry 503 check (which
  // lives outside the block, after the retry loop ends) can read it. Without
  // this outer scope, TypeScript would reject the reference as out-of-scope.
  let allCredentialsExhausted = false;
  if (config.retry.maxRetries > 0 && config.retry.retryableStatuses.includes(upstreamResp.status)) {
    // Detect empty-stream 529 (set by sse-error-detector.ts when the upstream
    // returned HTTP 200 + text/event-stream with zero SSE events — typical
    // quota-exhausted signature). This gets a dedicated retry policy:
    //   - retry up to 3 times with the SAME credential
    //   - if still empty after 3 retries, switch to the next stored credential
    //     and retry with the new one (counter resets on credential switch)
    //   - if no alternative credential is available, return the error to client
    //
    // This is separate from the generic credentialSwitchThreshold because
    // empty-stream is a high-confidence "this credential is dead" signal —
    // we don't want to wait for 5 generic failures before switching.
    const isEmptyStream529 = upstreamResp.status === 529 &&
      upstreamResp.headers.get("x-zcode-empty-stream") === "1";

    try { upstreamResp.body?.cancel(); } catch (e) { /* v0.2.0.8: surface cancel failures for diagnostics — cancel() shouldn't throw, but if Bun's internal stream state is weird we want a trace */ void e; }

    // Credential switching: track consecutive failures with the current
    // credential. When the threshold (config.retry.credentialSwitchThreshold)
    // is reached, the proxy switches to another stored credential before the
    // next retry. The initial attempt already failed (we only enter this block
    // on a retryable status), so the counter starts at 1.
    let consecutiveCredFailures = 1;
    // Fallback to 0 (disabled) if the field is missing — e.g. when a partial
    // config update via the admin API replaced the retry object without this
    // field. The loader always sets it, so this is just a safety net.
    const switchThreshold = config.retry.credentialSwitchThreshold ?? 0;
    // Credentials already tried in this request — prevents cycling back to a
    // known-failing credential when multiple alternatives exist.
    const triedApiKeys = new Set<string>([cred.apiKey]);
    // EMPTY-STREAM counter: tracks consecutive empty-stream 529s with the
    // current credential. When it hits EMPTY_STREAM_SWITCH_THRESHOLD, switch
    // to the next credential (regardless of the generic switchThreshold).
    // Threshold is configurable via config.retry.emptyStreamSwitchThreshold
    // (env var: ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD). Default 3.
    // Set to 0 to disable (fall back to the generic credentialSwitchThreshold).
    const EMPTY_STREAM_SWITCH_THRESHOLD = config.retry.emptyStreamSwitchThreshold ?? 3;
    let consecutiveEmptyStreams = isEmptyStream529 ? 1 : 0;
    // Track whether we already forcibly bumped maxRetries to give the empty-stream
    // path enough attempts to cycle through alternative credentials. The user's
    // spec is "retry 3 times then switch" — we may need MORE than maxRetries
    // total attempts if we want to actually try an alternative credential after
    // the switch (default maxRetries=3 would exhaust before the switch+retry).
    // We bump the effective limit by 1 per credential switch.
    let extraAttemptsFromSwitches = 0;
    // === CRITICAL FIX (命令行还在继续重试 bug) ===
    // allCredentialsExhausted is declared OUTSIDE this if-block (a few lines
    // above) so the post-retry 503 check can read it. When this flag is true
    // and the retry loop exhausts, we return 503 (non-retryable) instead of
    // forwarding 529 (retryable) — tells well-behaved clients like Claude
    // Code, OpenAI SDK to STOP retrying.
    //
    // IMPORTANT: this flag is ONLY set when we actually had multiple
    // credentials to try AND all of them failed. When there's only one
    // credential (no alternatives to begin with), we DON'T set this flag —
    // the failure might be transient upstream overload, so forwarding 529
    // (retryable) is correct. Setting 503 in the single-credential case
    // would break legitimate "service overloaded, retry later" semantics.
    //
    // We track the total available credential count up front so we can
    // distinguish "no alternatives because there's only one" from "no
    // alternatives because all N have been tried".
    let totalAvailableCredentials = 1; // default: assume only the current one
    try {
      totalAvailableCredentials = await auth.getAvailableCredentialCount();
      // Edge case: getAvailableCredentialCount returns 0 if listAllCredentials
      // isn't configured. In that case, fall back to 1 (the current credential
      // is the only one we know about).
      if (totalAvailableCredentials === 0) totalAvailableCredentials = 1;
    } catch { /* ignore — fall back to 1 */ }

    // v0.2.2+ FIX (infinite retry loop): hard cap on total attempts.
    // `extraAttemptsFromSwitches` increments on every credential switch,
    // so under concurrent dashboard imports / large credential pools the
    // loop could run far longer than the operator intended — each extra
    // attempt also waits ~20-40s for a fresh captcha solve (start-plan).
    // Cap at max(config.retry.maxRetries * 4 + 10, MAX_TOTAL_ATTEMPTS_CAP)
    // to guarantee termination in bounded time.
    const MAX_TOTAL_ATTEMPTS = Math.min(
      config.retry.maxRetries * RETRY_CONST.MAX_TOTAL_ATTEMPTS_FACTOR + RETRY_CONST.MAX_TOTAL_ATTEMPTS_FLAT,
      RETRY_CONST.MAX_TOTAL_ATTEMPTS_CAP,
    );

    for (let attempt = 1; attempt <= Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS); attempt++) {
      // v0.2.2+ safety: if we've hit the hard cap, force-exit the loop
      // immediately. This catches the edge case where extraAttemptsFromSwitches
      // grew faster than the cap check (the for-condition only re-evaluates
      // at the top of each iteration).
      if (attempt > MAX_TOTAL_ATTEMPTS) {
        console.log(`${reqId} hit MAX_TOTAL_ATTEMPTS cap (${MAX_TOTAL_ATTEMPTS}) — stopping retry loop`);
        allCredentialsExhausted = totalAvailableCredentials > 1;
        break;
      }
      // Calculate backoff delay: initialDelay * backoffFactor^(attempt-1), capped at maxDelay
      const rawDelay = config.retry.initialDelayMs * Math.pow(config.retry.backoffFactor, attempt - 1);
      let delayMs = Math.min(rawDelay, config.retry.maxDelayMs);

      // Respect Retry-After header. Per RFC 7231 §7.1.3 the value can be:
      //   - delta-seconds (e.g. "120"), OR
      //   - HTTP-date   (e.g. "Wed, 21 Oct 2025 07:28:00 GMT")
      // The old code only parsed delta-seconds and silently ignored HTTP-date
      // values — meaning the proxy would retry sooner than the upstream
      // explicitly requested.
      const retryAfter = upstreamResp.headers.get("retry-after");
      if (retryAfter) {
        let retryAfterMs: number;
        const asNum = parseFloat(retryAfter);
        if (Number.isFinite(asNum)) {
          retryAfterMs = asNum * 1000;
        } else {
          // Try HTTP-date format
          const dateMs = Date.parse(retryAfter);
          retryAfterMs = Number.isFinite(dateMs) ? dateMs - Date.now() : NaN;
        }
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          delayMs = Math.max(delayMs, retryAfterMs);
        }
      }

      // Add small random jitter (0–25% of delay) to avoid thundering herd
      const jitter = delayMs * 0.25 * Math.random();
      delayMs = Math.round(delayMs + jitter);

      console.log(
        `${reqId} upstream returned ${upstreamResp.status}, retry ${attempt}/${config.retry.maxRetries} in ${delayMs}ms...`,
      );
      await sleep(delayMs);

      // Credential switching: if the current credential has failed
      // consecutively enough times, switch to another stored credential
      // before this retry attempt. The new credential's auth headers and
      // userId are applied by reassigning `cred` and rebuilding the
      // transformed body — the buildUpstreamReq closure picks up the new
      // values automatically on the next fetch.
      //
      // EMPTY-STREAM SHORTCUT: if we've seen EMPTY_STREAM_SWITCH_THRESHOLD
      // (default 3) consecutive empty-stream 529s with the current credential,
      // switch IMMEDIATELY regardless of switchThreshold. Empty streams are
      // a much stronger "credential is dead" signal than a generic 529, so
      // we don't make the user wait through 5 generic failures first.
      // When EMPTY_STREAM_SWITCH_THRESHOLD is 0, the shortcut is disabled
      // (falls back to the generic credentialSwitchThreshold only).
      const shouldSwitchForEmptyStream = EMPTY_STREAM_SWITCH_THRESHOLD > 0 &&
        consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD;
      if (shouldSwitchForEmptyStream ||
          (switchThreshold > 0 && consecutiveCredFailures >= switchThreshold)) {
        const failedCount = consecutiveCredFailures;
        const newCred = await auth.switchToNextCredential(triedApiKeys);
        if (newCred) {
          const reason = shouldSwitchForEmptyStream
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          console.log(
            `${reqId} credential switched after ${reason} ` +
            `(retry ${attempt}/${Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS)}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          // Sync currentPlan to the new credential's plan (vceshi0.0.5+ fix for
          // cross-plan credential switch bug). Without this, switching from a
          // coding-plan cred to a start-plan cred (or vice versa) would keep
          // using the old plan's upstream URL, auth headers, captcha logic —
          // guaranteeing the retried request fails the same way.
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            console.log(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          // v0.2.2+ PERF: rebuild the transformed body only if the
          // (userId|plan|thinkingLevel) key actually changed. For coding-plan
          // → coding-plan switches, the userId isn't applied (startPlan=false
          // makes applyAnthropicUserId a no-op) and the transform output is
          // IDENTICAL — re-running it on a 90KB body wastes 5-10ms each time.
          rebuildTransformedBody(newCred.userId, currentPlan);
          consecutiveCredFailures = 0;
          consecutiveEmptyStreams = 0; // reset empty-stream counter on switch
          triedApiKeys.add(newCred.apiKey);
          // Grant one extra retry attempt ONLY for empty-stream switches.
          // The user's spec is "retry 3 times then switch" — without an extra
          // attempt, the new credential would only get whatever's left of the
          // original maxRetries budget (often just 1 attempt with default
          // maxRetries=3). The extra attempt gives the new credential a fair
          // shot. For generic switchThreshold switches we DON'T add extra
          // attempts — the existing tests expect the loop to end at maxRetries.
          if (shouldSwitchForEmptyStream) {
            extraAttemptsFromSwitches++;
          }
          // Persist the switch so the dashboard reflects the new active account.
          // Non-fatal: if persistence fails, the in-memory switch still works
          // for the remainder of this request.
          //
          // === CRITICAL FIX (账号全没 bug) ===
          // switchAccount now returns `null` when the store can't be read
          // (transient AV lock etc.) instead of silently writing an empty
          // store. Handle all three return values explicitly so we don't
          // log a misleading "Auto-switched" message when the write was
          // actually skipped.
          try {
            const accounts = await exportAccounts();
            if (accounts.length === 0) {
              // Store is empty — don't even try switchAccount (it would
              // return false anyway). This is expected when the user has
              // cleared credentials; the in-memory switch above still
              // works for the remainder of this request.
              console.log(`${reqId} credential store is empty, skipping switchAccount persist`);
            } else {
              const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
              if (match) {
                const persistResult = await switchAccount(match.id);
                if (persistResult === true) {
                  appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
                } else if (persistResult === null) {
                  // Transient store read failure — the in-memory switch still
                  // works for this request. Don't log an error (it's not
                  // actionable), just a debug note.
                  console.log(`${reqId} could not persist credential switch: store temporarily unreadable, will retry on next switch`);
                } else {
                  // false: account not in store (race condition — another
                  // process removed it between exportAccounts and switchAccount)
                  console.log(`${reqId} could not persist credential switch: account ${match.id} not found in store (race condition)`);
                }
              }
            }
          } catch (e) {
            console.log(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
        } else {
          // No alternative credential available (or all alternatives already
          // tried in this request). Mark exhausted ONLY when there were
          // multiple credentials to begin with — if there's only one, the
          // failure might be transient upstream overload and forwarding 529
          // (retryable) is the correct behavior.
          if (totalAvailableCredentials > 1) {
            allCredentialsExhausted = true;
            console.log(
              `${reqId} credential switch threshold reached but no alternative credential available ` +
              `(tried ${triedApiKeys.size} of ${totalAvailableCredentials} credential(s)). ` +
              `Will return 503 (not 529) after retries exhaust to stop client retry loops.`,
            );
          } else {
            console.log(
              `${reqId} credential switch threshold reached but no alternative credential available ` +
              `(only ${totalAvailableCredentials} credential configured). Continuing with current — ` +
              `forwarding 529 (retryable) to client since this may be transient overload.`,
            );
          }
        }
      }

      try {
        // Build a FRESH Request for each retry — never reuse upstreamReq.
        // fetchUpstreamDetected also runs SSE error detection so 200 streams
        // with hidden errors get caught on every attempt.
        //
        // CRITICAL for start-plan: refresh captcha token before each retry.
        // The token from the initial fetch might have expired during the
        // backoff sleep (TTL is only 45s). Using a stale token returns 403
        // "captcha verify failed" — which is NOT a retryable status, so it
        // would break out of the loop and leak the 403 to the client.
        const retryCaptcha = await refreshCaptchaHeaders();
        upstreamResp = await fetchUpstreamDetected(retryCaptcha);
        headersAt = Date.now();

        // If the retry itself returns 403 (captcha challenge), try to
        // re-solve and retry once before giving up. This handles the case
        // where the token expired between refreshCaptchaHeaders() and the
        // upstream actually validating it (rare but possible under load).
        if (currentPlan === "start-plan" && (upstreamResp.status === 403 || detectCaptchaChallenge(upstreamResp))) {
          console.log(`${reqId} retry ${attempt} got 403 captcha challenge, re-solving...`);
          upstreamResp = await handleCaptchaChallenge(upstreamResp);
        }

        // vceshi0.0.8+: also check for WAF block on retry — if the IP got
        // blacklisted DURING the retry loop, we need to bail immediately
        // (same rationale as the pre-loop check; hammering the WAF makes
        // the blacklist worse). checkWafBlock returns a fresh response on
        // the non-WAF path so downstream code can read the body normally.
        //
        // v0.2.2+: with the global proxy pool, we now attempt proxy rotation
        // before giving up (same logic as the pre-loop WAF handler). If a
        // different pool proxy succeeds, the rotated response replaces the
        // blocked one and the retry loop continues normally.
        const retryWafCheck = await checkWafBlock(upstreamResp);
        if (retryWafCheck.wafBlocked) {
          const ct = upstreamResp.headers.get("content-type") ?? "";
          console.error(
            `${reqId} ⚠️  ALIYUN WAF BLOCK DETECTED on retry ${attempt} — status=${upstreamResp.status}, ` +
            `content-type=${ct}. Attempting proxy rotation...`,
          );

          // Mark current pool proxy failed (best-effort).
          if (currentRequestProxy) {
            try { await markProxyFailed(currentRequestProxy); } catch { /* non-fatal */ }
          }

          // Try up to maxRotations different pool proxies (from pool config).
          let retryRotated = false;
          if (!cred.proxy) { // only rotate when using the pool, not per-account proxy
            const retryMaxRotations = await getMaxRotations().catch(() => 3);
            if (retryMaxRotations > 0) {
              for (let rot = 0; rot < retryMaxRotations; rot++) {
              currentRequestProxy = undefined;
              let nextProxy: string | null = null;
              try {
                nextProxy = await pickProxy(triedProxySetView());
              } catch (e) {
                console.log(`${reqId} retry proxy pool rotation failed: ${(e as Error).message}`);
                break;
              }
              if (!nextProxy) {
                console.log(`${reqId} retry proxy pool exhausted after ${rot} rotation(s)`);
                break;
              }
              currentRequestProxy = nextProxy;
              markProxyTried(nextProxy);
              console.log(`${reqId} retry WAF rotation ${rot + 1}/${retryMaxRotations}: switching to proxy ${nextProxy}`);

              try { upstreamResp.body?.cancel(); } catch (e) { void e; }
              try {
                const rotCaptcha = await refreshCaptchaHeaders();
                upstreamResp = await fetchUpstreamDetected(rotCaptcha);
                headersAt = Date.now();
              } catch (err) {
                console.log(`${reqId} retry WAF rotation ${rot + 1} fetch failed: ${(err as Error).message}`);
                try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
                continue;
              }
              const rotWafCheck = await checkWafBlock(upstreamResp);
              if (!rotWafCheck.wafBlocked) {
                upstreamResp = rotWafCheck.response;
                console.log(`${reqId} retry WAF rotation ${rot + 1} succeeded — proxy ${nextProxy}`);
                retryRotated = true;
                break;
              }
              try { await markProxyFailed(nextProxy); } catch { /* non-fatal */ }
              console.log(`${reqId} retry WAF rotation ${rot + 1} still blocked on ${nextProxy}`);
              }
            }
          }

          if (!retryRotated) {
            try { upstreamResp.body?.cancel(); } catch (e) { void e; }
            printRow(reqId, format, meta, upstreamResp.status, started, headersAt, 0, 0, 0);
            return errorResponse(
              503,
              "waf_blocked",
              "Request blocked by Aliyun WAF (status=" + upstreamResp.status + "). " +
              "Your IP is likely blacklisted. Stop retrying immediately, change IP, and wait before retrying. " +
              "See: https://errors.aliyun.com",
            );
          }
          // Rotated successfully — fall through; the new upstreamResp is the
          // rotated (non-WAF) response.
        } else {
          upstreamResp = retryWafCheck.response;
        }
      } catch (err) {
        // v0.2.2+: captcha config hard-fail breaks the retry loop immediately.
        // Retrying is pointless — each retry would burn another 120s waiting
        // for a captcha config that won't suddenly become available.
        const isCaptchaConfigHardFail = (err as Error & { captchaConfigUnavailable?: boolean }).captchaConfigUnavailable === true;
        if (isCaptchaConfigHardFail) {
          console.log(`${reqId} captcha config unavailable — breaking retry loop`);
          printRow(reqId, format, meta, 503, started, Date.now(), 0, 0, 0);
          return errorResponse(503, "captcha_config_unavailable", (err as Error).message);
        }
        // Network error during retry — log the ACTUAL error so users can
        // diagnose (the old code just said "network error" with no detail).
        const errMsg = (err as Error).message ?? String(err);
        // Network errors count toward the credential-switch failure counter.
        consecutiveCredFailures++;
        if (attempt < Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS)) {
          console.log(`${reqId} fetch failed on retry ${attempt}: ${errMsg}, will retry again...`);
          // Network errors are ALWAYS retryable — they are the most common
          // retry scenario (upstream blip, transient DNS, ECONNREFUSED during
          // deploy). The previous code synthesized a 502 and then checked
          // `retryableStatuses.includes(502)` — but the default config is
          // `[529]` only, so synthetic 502 broke the loop and the actual
          // retry never happened. Skip the retryable-status check below by
          // continuing the loop directly here.
          continue;
        }
        console.log(`${reqId} fetch failed on final retry ${attempt}: ${errMsg}`);
        printRow(reqId, format, meta, 502, started, Date.now(), 0, 0, 0);
        return errorResponse(502, "upstream_unreachable", errMsg);
      }

      // If the new response is no longer a retryable status, break out
      if (!config.retry.retryableStatuses.includes(upstreamResp.status)) {
        console.log(`${reqId} retry ${attempt} succeeded (status ${upstreamResp.status})`);
        break;
      }

      // Still a retryable status — count as a failure for credential switching.
      consecutiveCredFailures++;
      // Track empty-stream responses separately — they trigger a faster
      // credential switch (3 consecutive empties vs. switchThreshold=5 for
      // generic failures).
      const retryWasEmptyStream = upstreamResp.status === 529 &&
        upstreamResp.headers.get("x-zcode-empty-stream") === "1";
      if (retryWasEmptyStream) {
        consecutiveEmptyStreams++;
        console.log(`${reqId} retry ${attempt} got empty-stream 529 (${consecutiveEmptyStreams}/${EMPTY_STREAM_SWITCH_THRESHOLD} before forced switch)`);
      } else {
        // Any non-empty retryable status resets the empty-stream counter —
        // a 529 from a real overloaded_error is a different signal than
        // an empty stream, and we don't want it to count toward the
        // empty-stream switch.
        consecutiveEmptyStreams = 0;
      }

      // vceshi0.0.5+ fix: off-by-one in empty-stream switch.
      // Previously the switch check was only at the TOP of the loop, so if
      // the threshold was reached on the LAST retry attempt, the break below
      // would fire before the switch ever triggered — making the feature
      // a no-op under default config (maxRetries=3, threshold=3, initial
      // response non-empty). Now we check AFTER incrementing and BEFORE the
      // break: if threshold reached AND there's an alternative credential
      // available, force a switch + grant an extra attempt so the new cred
      // actually gets tried.
      const shouldForceSwitchNow = (
        (EMPTY_STREAM_SWITCH_THRESHOLD > 0 && consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD) ||
        (switchThreshold > 0 && consecutiveCredFailures >= switchThreshold)
      );
      if (shouldForceSwitchNow) {
        // Try to switch — if a new cred is available, grant an extra attempt
        // and continue the loop instead of breaking.
        const failedCount = consecutiveCredFailures;
        const newCred = await auth.switchToNextCredential(triedApiKeys);
        if (newCred) {
          const reason = (EMPTY_STREAM_SWITCH_THRESHOLD > 0 && consecutiveEmptyStreams >= EMPTY_STREAM_SWITCH_THRESHOLD)
            ? `${consecutiveEmptyStreams} consecutive empty-stream responses`
            : `${failedCount} consecutive failures`;
          console.log(
            `${reqId} credential switched (end-of-loop) after ${reason} ` +
            `(retry ${attempt}/${Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS)}): ${maskApiKey(cred.apiKey)} → ${maskApiKey(newCred.apiKey)}`,
          );
          cred = newCred;
          const newPlan = effectivePlanForCred(newCred);
          if (newPlan !== currentPlan) {
            console.log(`${reqId} plan synced to ${newPlan} (from new credential ${maskApiKey(newCred.apiKey)})`);
            currentPlan = newPlan;
          }
          // v0.2.2+ PERF: see rebuildTransformedBody docstring above.
          rebuildTransformedBody(newCred.userId, currentPlan);
          consecutiveCredFailures = 0;
          consecutiveEmptyStreams = 0;
          triedApiKeys.add(newCred.apiKey);
          extraAttemptsFromSwitches++;
          // Persist the switch so the dashboard reflects the new active account.
          // This was MISSING in the end-of-loop switch block — the in-memory
          // credential was switched (so the request used the new account), but
          // the on-disk activeId still pointed at the old account. The user
          // saw "激活还是停在原来的账号上，但实际上已经用了下一个账号进行调用了".
          // Now both switch blocks (top-of-loop and end-of-loop) persist the
          // switch consistently. Non-fatal: if persistence fails, the in-memory
          // switch still works for the remainder of this request.
          //
          // === CRITICAL FIX (账号全没 bug) ===
          // Handle switchAccount's new null return value (store transiently
          // unreadable) — don't log misleading "Auto-switched" message.
          try {
            const accounts = await exportAccounts();
            if (accounts.length === 0) {
              console.log(`${reqId} credential store is empty, skipping switchAccount persist (end-of-loop)`);
            } else {
              const match = accounts.find(a => a.credential.apiKey === newCred.apiKey);
              if (match) {
                const persistResult = await switchAccount(match.id);
                if (persistResult === true) {
                  appendLog("info", `Auto-switched credential to "${match.label}" (${maskApiKey(newCred.apiKey)}) after ${reason}`);
                } else if (persistResult === null) {
                  console.log(`${reqId} could not persist credential switch (end-of-loop): store temporarily unreadable`);
                } else {
                  console.log(`${reqId} could not persist credential switch (end-of-loop): account ${match.id} not found (race)`);
                }
              }
            }
          } catch (e) {
            console.log(`${reqId} could not persist credential switch: ${(e as Error).message}`);
          }
          try { upstreamResp.body?.cancel(); } catch (e) { /* v0.2.0.8: surface cancel failures for diagnostics — cancel() shouldn't throw, but if Bun's internal stream state is weird we want a trace */ void e; }
          continue; // skip the break, give the new cred a chance
        }
        // No alternative credential — mark exhausted ONLY if we had multiple
        // to begin with (single-credential failure may be transient overload,
        // forward 529). Fall through to break.
        if (totalAvailableCredentials > 1) {
          allCredentialsExhausted = true;
          console.log(
            `${reqId} no alternative credential available after switch threshold ` +
            `(tried ${triedApiKeys.size} of ${totalAvailableCredentials} credential(s)). ` +
            `Will return 503 to stop client retries.`,
          );
        } else {
          console.log(
            `${reqId} no alternative credential available ` +
            `(only ${totalAvailableCredentials} credential configured). ` +
            `Forwarding 529 (retryable) — may be transient overload.`,
          );
        }
      }

      // Still a retryable status — if this was the last attempt, keep the
      // response body intact (don't cancel) so we can return it to the
      // client with a body. Previously the code cancelled the body then
      // refetched — but that refetch reused the consumed Request object
      // and always failed. Keeping the body is simpler and correct.
      if (attempt === Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS)) {
        console.log(`${reqId} all ${Math.min(config.retry.maxRetries + extraAttemptsFromSwitches, MAX_TOTAL_ATTEMPTS)} retries exhausted, returning ${upstreamResp.status}`);
        break;
      }

      // More retries left — cancel the body before looping
      try { upstreamResp.body?.cancel(); } catch (e) { /* v0.2.0.8: surface cancel failures for diagnostics — cancel() shouldn't throw, but if Bun's internal stream state is weird we want a trace */ void e; }
    }
  }

  // === CRITICAL FIX (命令行还在继续重试 bug) ===
  // If all credentials have been tried and exhausted (switchToNextCredential
  // returned null), return 503 (non-retryable) instead of forwarding the
  // upstream's 529 (retryable). This tells well-behaved clients like Claude
  // Code, OpenAI SDK, etc. to STOP retrying — they honor Retry-After.
  //
  // Previously the proxy forwarded 529 to the client after exhausting all
  // credentials. Clients interpret 529 as "service overloaded, try again
  // later" and keep re-sending the request. The proxy runs the same retry
  // loop, exhausts again, returns 529 again... infinite loop. The user
  // reported "命令行还在继续重试" long after the proxy had given up.
  //
  // 503 with Retry-After: 300 (5 minutes) gives the upstream quota time to
  // reset. The user can also manually add a new credential via the dashboard
  // during this window.
  //
  // We only do this if the final status is a retryable 5xx (529/503/502 etc.)
  // — for non-retryable statuses (4xx), forwarding the original response is
  // correct.
  if (allCredentialsExhausted && upstreamResp.status >= 500 && upstreamResp.status < 600) {
    console.log(
      `${reqId} all credentials exhausted + upstream ${upstreamResp.status}, ` +
      `returning 503 (Retry-After: 300) to stop client retry loops`,
    );
    printRow(reqId, format, meta, 503, started, headersAt, 0, 0, 0);
    try { upstreamResp.body?.cancel(); } catch (e) { /* v0.2.0.8: surface cancel failures for diagnostics — cancel() shouldn't throw, but if Bun's internal stream state is weird we want a trace */ void e; }
    const body = JSON.stringify({
      error: {
        type: "all_credentials_exhausted",
        message:
          "All stored credentials have been tried and exhausted. " +
          "The proxy will not retry automatically — please add a new credential " +
          "via the dashboard, or wait for upstream quota to reset " +
          "(Retry-After: 300 seconds).",
      },
    });
    return new Response(body, {
      status: 503,
      headers: {
        "content-type": "application/json",
        "retry-after": "300",
        // X-Should-Not-Retry is a non-standard hint for clients that don't
        // honor Retry-After on 503 (rare but possible).
        "x-should-not-retry": "1",
      },
    });
  }

  // === Sticky proxy: mark the current pool proxy as "working" ===
  // If this request used a pool proxy (not cred.proxy) and the response is
  // successful (2xx), make it the sticky proxy for future requests. This
  // implements "后面请求也要记住这个代理继续使用" — once a proxy works,
  // subsequent requests reuse it until it fails.
  //
  // We do NOT clear the sticky state on non-2xx responses here — that's
  // already handled by markProxyFailed in the WAF rotation path. For other
  // 4xx/5xx errors (quota, auth, etc.), we leave the sticky proxy in place
  // because the error is likely account-specific, not proxy-specific.
  if (currentRequestProxy && !cred.proxy && upstreamResp.status >= 200 && upstreamResp.status < 300) {
    if (getCurrentWorkingProxy() !== currentRequestProxy) {
      setCurrentWorkingProxy(currentRequestProxy);
      console.log(`${reqId} proxy sticky: ${currentRequestProxy} (will reuse for future requests)`);
    }
  }

  const isSSEUpstream = upstreamResp.headers.get("content-type")?.includes("text/event-stream") ?? false;
  // isSSE mutates below: when we buffer SSE → batch JSON for non-stream
  // clients, isSSE becomes false so the SSE branch is skipped.
  let isSSE = isSSEUpstream;

  // v0.2.0.4: stream:true is forced upstream (in alignZCodeRequestFormat) to
  // match the real ZCode desktop client's wire shape. When the original client
  // requested non-streaming (no `stream: true` in their body), upstream still
  // returns SSE — we buffer it into batch JSON so the client gets the response
  // format it expects. This makes the wire-shape alignment transparent to
  // non-stream clients (Claude Code, SDK calls, integration tests, etc.).
  //
  // Both passthrough AND translation paths benefit (translatedBatchResponse /
  // translatedResponsesBatchResponse both expect a JSON body — the synthetic
  // JSON response flows through them naturally).
  //
  // Runs only on 2xx SSE responses (4xx/5xx are handled by the diagnostic
  // peek below; the SSE error detector converts errored/empty SSE to non-2xx
  // JSON before we reach here, so isSSE=false for those).
  if (isSSE && upstreamResp.ok && !meta.stream && upstreamResp.body) {
    const result = await anthropicSseToBatchMessage(upstreamResp.body, meta.model);
    if ("error" in result) {
      console.log(`${reqId} SSE->batch reassembly error: ${result.error}`);
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "upstream_stream_error", result.error);
    }
    const json = JSON.stringify(result.message);
    // Preserve relevant upstream headers (request-id, ratelimit-*). Drop the
    // text/event-stream content-type — the synthetic response is JSON.
    const respHeaders = new Headers();
    for (const h of ["x-request-id", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-requests-reset", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "anthropic-ratelimit-tokens-reset"]) {
      const v = upstreamResp.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    respHeaders.set("content-type", "application/json");
    upstreamResp = new Response(json, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
    isSSE = false; // the synthetic response is JSON, not SSE
    // The reassembled message carries `usage` (input_tokens / output_tokens),
    // which the batch path below extracts automatically — no need to plumb
    // token counts separately.
  }

  // Diagnostic: when the upstream rejects with 4xx (especially 3001 "parameter
  // error" from GLM), record a debug dump in memory so the user can inspect
  // the exact transformed body via /admin/api/debug-dumps without writing
  // files to disk. The old code wrote to <cwd>/zcode-proxy-debug-*.json
  // which leaked user conversation content to disk forever.
  if (!upstreamResp.ok && upstreamResp.status >= 400 && upstreamResp.status < 500) {
    const errPeek = await upstreamResp.text().catch(() => "");
    console.log(`${reqId} upstream ${upstreamResp.status} ${errPeek.slice(0, 200)}`);
    console.log(`${reqId} transformed request summary: ${summarizeBody(transformedObj ?? parsedBody)}`);
    // Also log the anthropic-beta header that was actually sent upstream —
    // mismatched beta flags vs body is a common 3001 cause on ZCode gateway.
    // Reuses lastSentBeta captured during the real fetch (instead of building
    // a fresh Request just to read one header — the old code generated new
    // random UUIDs for x-request-id etc., making the logged header belong to
    // a different request than the one actually sent).
    console.log(`${reqId} anthropic-beta sent: ${lastSentBeta ?? "(none)"}`);
    if (transformedBody) {
      try {
        recordDebugDump({
          id: reqId,
          status: upstreamResp.status,
          upstreamError: errPeek.slice(0, 500),
          anthropicBeta: lastSentBeta ?? "",
          bodySummary: summarizeBody(transformedObj ?? parsedBody),
          body: transformedBody,
        });
      } catch (e) {
        console.log(`${reqId} failed to record debug dump: ${(e as Error).message}`);
      }
    }
    // Reconstruct the response with the peeked body so the passthrough below
    // still has something to send. upstreamResp.text() consumed the body.
    //
    // v0.2.2+ note: content-encoding is PRESERVED because passthrough mode
    // uses `decompress: false` — the peeked text is the raw compressed bytes
    // (or plain text if upstream didn't compress). The encoding header
    // correctly describes the body either way.
    upstreamResp = new Response(errPeek, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  }

  if (translateMode) {
    if (!upstreamResp.ok) {
      const errBody = await upstreamResp.text().catch(() => "");
      printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
      return errorResponse(502, "translation_failed", `upstream returned ${upstreamResp.status}: ${errBody.slice(0, 200)}`);
    }
    if (format === "openai-responses") {
      // Responses API translation: use the dedicated SSE / batch translators.
      if (isSSE && upstreamResp.body) {
        const translated = anthropicSseToResponsesSse(upstreamResp.body, meta.model);
        // v0.2.0.8: pipe through an inline stats TransformStream instead of
        // tee()+parallel reader — avoids buffering the whole stream when the
        // stats reader falls behind (see createStatsTransform docs).
        const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, null, maskApiKey(cred.apiKey), totalCaptchaMs);
        // v0.2.1.7: heartbeat AFTER stats (closer to client). Stats sees
        // only real upstream bytes; heartbeat comment lines flow straight
        // to the client without stats inspecting them.
        const heartbeat = createSseHeartbeatTransform(config.server.sseHeartbeatMs ?? 0);
        return translatedSseResponse(translated.pipeThrough(stats.transform).pipeThrough(heartbeat));
      }
      return await translatedResponsesBatchResponse(
        clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt,
        (parsedBody as OpenAIResponseRequest | undefined)?.previous_response_id,
        (parsedBody as OpenAIResponseRequest | undefined)?.input,
        maskApiKey(cred.apiKey),
        totalCaptchaMs,
      );
    }
    // Chat Completions translation: use the original SSE / batch translators.
    if (isSSE && upstreamResp.body) {
      const translated = anthropicSseToOpenaiSse(upstreamResp.body, meta.model);
      // v0.2.0.8: inline stats transform (see createStatsTransform docs).
      const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, null, maskApiKey(cred.apiKey), totalCaptchaMs);
      // v0.2.1.7: heartbeat AFTER stats — see openai-responses branch above.
      const heartbeat = createSseHeartbeatTransform(config.server.sseHeartbeatMs ?? 0);
      return translatedSseResponse(translated.pipeThrough(stats.transform).pipeThrough(heartbeat));
    }
    return await translatedBatchResponse(clientReq, upstreamResp, meta.model, reqId, format, meta, started, headersAt, maskApiKey(cred.apiKey), totalCaptchaMs);
  }

  if (isSSE && upstreamResp.body) {
    // v0.2.0.8: inline stats transform — pass content-encoding so compressed
    // streams skip SSE parsing (we'd only see gzip bytes, not SSE events).
    const contentEncoding = upstreamResp.headers.get("content-encoding");
    const stats = createStatsTransform(reqId, format, meta, upstreamResp.status, started, contentEncoding, maskApiKey(cred.apiKey), totalCaptchaMs);
    // v0.2.1.7: heartbeat AFTER stats — keeps the client connection alive
    // across CF's 100s Proxy Read Timeout when upstream is slow to TTFB
    // (e.g. GLM-5.2 thinking mode sitting silent for 60-180s).
    //
    // CRITICAL: heartbeat is DISABLED when the upstream response is
    // compressed (content-encoding: gzip/br/deflate). In passthrough mode
    // (decompress: false), upstreamResp.body is raw compressed bytes and
    // passthroughResponse preserves the content-encoding header — the
    // client decompresses on its end. Injecting plaintext ": keepalive\n\n"
    // into a compressed stream would corrupt the client's decompression
    // (Z_DATA_ERROR), destroying the entire response.
    //
    // translateMode branches above are unaffected: Bun auto-decompresses
    // (no decompress:false), translators output plaintext SSE, and
    // translatedSseResponse doesn't set content-encoding — so heartbeat
    // is always safe there.
    //
    // Trade-off: passthrough + compressed SSE loses CF 524 protection.
    // In practice z.ai/bigmodel SSE responses are rarely compressed (SSE
    // is streaming; compression introduces buffering latency), so this
    // is a rare edge case. If you hit it, the fix is to use stream:true
    // on the client (which may route through translation mode) or disable
    // compression on the upstream.
    const heartbeatInterval = contentEncoding ? 0 : (config.server.sseHeartbeatMs ?? 0);
    const heartbeat = createSseHeartbeatTransform(heartbeatInterval);
    return passthroughResponse(upstreamResp, upstreamResp.body.pipeThrough(stats.transform).pipeThrough(heartbeat));
  }

  // Non-streaming anthropic passthrough — try to extract usage from the response
  // body for stats. We read the body once, parse usage, then reconstruct the
  // Response for passthrough. (Response.clone() doesn't work reliably with all
  // mock implementations, so we read-once-and-rebuild instead.)
  let passthroughInputTokens = 0;
  let passthroughOutputTokens = 0;
  let passthroughBody: ReadableStream<Uint8Array> | string | null = null;
  const ct = upstreamResp.headers.get("content-type") ?? "";
  let passthroughCacheReadTokens = 0;
  if (ct.includes("application/json") && upstreamResp.body) {
    try {
      const raw = await upstreamResp.text();
      passthroughBody = raw;
      const usage = JSON.parse(raw)?.usage;
      if (usage) {
        passthroughInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
        passthroughOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
        // v0.2.0.6: extract cache_read_input_tokens for accurate input total
        passthroughCacheReadTokens = usage.cache_read_input_tokens ?? 0;
      }
    } catch { /* non-JSON or parse error — leave as 0, fall back to original body */ }
  }
  printRow(reqId, format, meta, upstreamResp.status, started, headersAt, passthroughOutputTokens, 0, 0, false, passthroughInputTokens, maskApiKey(cred.apiKey), totalCaptchaMs, passthroughCacheReadTokens);
  // Reconstruct the response with the read body so passthrough still has content.
  //
  // v0.2.2+ note: passthrough mode uses `decompress: false` on the upstream
  // fetch, so `upstreamResp.text()` returns the RAW bytes (still gzip/br/
  // deflate compressed if the upstream sent them that way). The original
  // `content-encoding` header correctly describes the body, so we MUST
  // preserve it — stripping it would make the client receive compressed
  // bytes with no encoding hint, breaking decompression.
  //
  // The translation-format pipeline (body-transformer.ts alignZCodeRequestFormat)
  // is NOT touched here — this only affects the OUTBOUND response back to
  // the client, not the inbound request translation.
  if (passthroughBody !== null) {
    return new Response(passthroughBody, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: upstreamResp.headers,
    });
  }
  return passthroughResponse(upstreamResp);
}

/** Read the request body as a string, returning undefined for empty bodies. */
async function readBody(req: Request): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const text = await req.text();
  if (text.length === 0) return undefined;
  return text;
}

/**
 * Recursively strip fields whose value is exactly the string "[undefined]".
 *
 * Some clients (notably Cherry Studio) serialize JavaScript `undefined` as
 * the literal STRING "[undefined]" instead of omitting the field. These
 * pass through JSON.parse as string values, get forwarded to z.ai as
 * bogus request parameters (`temperature: "[undefined]"` etc.), and are
 * a strong WAF fingerprint — no legitimate client would ever send them.
 *
 * Returns the count of removed fields for diagnostic logging.
 */
function stripUndefinedStringFields(node: unknown): number {
  if (Array.isArray(node)) {
    let removed = 0;
    for (const item of node) {
      if (item && typeof item === "object") {
        removed += stripUndefinedStringFields(item);
      }
    }
    return removed;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    let removed = 0;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v === "[undefined]") {
        delete obj[key];
        removed++;
      } else if (v && typeof v === "object") {
        removed += stripUndefinedStringFields(v);
      }
    }
    return removed;
  }
  return 0;
}

/**
 * Detect Aliyun WAF block responses.
 *
 * z.ai / zcode.z.ai use Aliyun WAF. When an IP is blacklisted, the WAF
 * returns a non-standard response:
 *   - HTTP 405 / 403 / 200 (NOT a typical API error status)
 *   - content-type: text/html (NOT application/json or text/event-stream)
 *   - body is an Aliyun HTML error page containing `errors.aliyun.com`
 *   - server: Tengine (Alibaba's nginx fork)
 *
 * We peek at the body to confirm it's actually a WAF page (not some other
 * html response) — the `errors.aliyun.com` string is the reliable signal.
 *
 * Returns `{ wafBlocked: true }` if this is a WAF block. In that case the
 * response body has already been consumed (for inspection) and MUST NOT be
 * used further — the caller returns a synthetic error response.
 *
 * Returns `{ wafBlocked: false, response: <Response> }` if this is NOT a
 * WAF block. The returned Response has a FRESH readable body reconstructed
 * from the consumed text, so downstream code can read it normally (`.text()`,
 * `.json()`, `.body.tee()`, etc.) as if the inspection never happened.
 *
 * vceshi0.0.8+ bugfix: previously this function returned `false` after
 * consuming the body and stashed the text on the response object via
 * `(resp as any)._wafCheckBody = text`. But NO downstream code path ever
 * read `_wafCheckBody`, so for any 200 + HTML response that wasn't a WAF
 * block, `upstreamResp.body` was already locked/consumed and
 * `upstreamResp.body.tee()` would throw. Reconstructing a new Response
 * here is the clean fix — the Body mixin's constructor accepts a string
 * and produces a fresh, readable stream.
 */
export async function checkWafBlock(resp: Response): Promise<{ wafBlocked: true } | { wafBlocked: false; response: Response }> {
  // Fast path: status codes that the WAF typically uses.
  // 405 = Method Not Allowed (the classic WAF block)
  // 403 = Forbidden (captcha challenge or WAF block)
  // 200 = sometimes the WAF returns 200 + HTML instead of an error status
  const isSuspectStatus = resp.status === 405 || resp.status === 403 || resp.status === 200;
  if (!isSuspectStatus) return { wafBlocked: false, response: resp };

  const ct = resp.headers.get("content-type") ?? "";
  // WAF responses are HTML; legitimate API responses are JSON or SSE.
  // If content-type is JSON or SSE, this is NOT a WAF block — and we don't
  // need to consume the body to confirm, so we can return the original
  // response untouched.
  if (ct.includes("application/json") || ct.includes("text/event-stream")) {
    return { wafBlocked: false, response: resp };
  }
  // Strong signal: Tengine server header (Alibaba's nginx fork).
  // But not all WAF responses have it, so we don't require it.
  const server = resp.headers.get("server") ?? "";

  // v0.2.2+ PERF: stream the body peek with a hard size cap. Previously
  // `await resp.text()` read the ENTIRE body into memory — for a 1MB HTML
  // error page (some upstreams return verbose HTML) this would block the
  // event loop and spike memory. Now we read up to MAX_PEEK_BYTES (32KB,
  // more than enough to contain any Aliyun WAF page) and stop early as
  // soon as the WAF signature is found. If the body doesn't contain the
  // signature within the cap, we treat it as "not a WAF block" and
  // reconstruct the response with the peeked prefix.
  try {
    const MAX_PEEK = WAF_CONST.MAX_PEEK_BYTES;
    let text = "";
    let bodyDone = false;
    if (resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (text.length < MAX_PEEK) {
          const { done, value } = await reader.read();
          if (done) { bodyDone = true; break; }
          text += decoder.decode(value, { stream: true });
          // Early-exit: signature found, no need to keep reading.
          if (text.includes(WAF_CONST.SIGNATURE)) {
            bodyDone = false;  // there may be more body, but we don't need it
            break;
          }
        }
        if (text.length < MAX_PEEK && !bodyDone) {
          // Flush the decoder's internal buffer (final partial multi-byte
          // sequence) so the text is complete.
          text += decoder.decode();
        }
      } finally {
        try { await reader.cancel(); } catch { /* best-effort */ }
      }
    } else {
      // No body — nothing to peek. Treat as non-WAF.
      return { wafBlocked: false, response: resp };
    }
    // === Aliyun WAF standard block page ===
    // 已有指纹 1: errors.aliyun.com 字符串(图片 URL / 错误页链接)
    if (text.includes("errors.aliyun.com") || (text.includes("aliyun") && text.includes("WAF"))) {
      return { wafBlocked: true };
    }
    // 已有指纹 2: Tengine server + 405 + text/html
    if (resp.status === 405 && ct.includes("text/html") && server.toLowerCase().includes("tengine")) {
      return { wafBlocked: true };
    }
    // 新增指纹 3: 阿里云 WAF 拦截页更稳的特征(不依赖图片 URL 是否变化)
    //   - data-spm 是阿里云埋点属性,几乎所有阿里云系拦截页都带
    //   - block_message / block_traceid_tips 是阿里云 WAF 标准 JS 文案 key
    //   - 这些字段即使 errors.aliyun.com 域名换了也仍然存在
    if (ct.includes("text/html") &&
        text.includes("data-spm") &&
        (text.includes("block_message") || text.includes("block_traceid_tips"))) {
      return { wafBlocked: true };
    }

    // === Nginx 伪装 405 拦截页 (Render 日志观察到的形态) ===
    // 形态:`<html><head><title>405 Not Allowed</title></head>
    //        <body><center><h1>405 Not Allowed</h1></center>
    //        <hr><center>nginx/1.31.2</center></body></html>`
    //
    // 关键特征:
    //   - body 极短(<2KB),纯标准 nginx 默认错误页
    //   - server 头声称 nginx/1.31.x,但 nginx 实际不存在 1.31 mainline
    //     (2025 年 nginx mainline 是 1.27.x,stable 是 1.26.x)
    //     这种"未来版本号"几乎肯定是 WAF/网关伪装
    //   - z.ai / bigmodel 的 API 端点正常情况下绝不返回 HTML 405
    //
    // 新增指纹 4: nginx 不存在的版本号(1.31+ 都不存在)
    if (resp.status === 405 && ct.includes("text/html") &&
        /nginx\/1\.(3[1-9]|[4-9]\d|1\d{2}|[2-9]\d{2})/i.test(server)) {
      return { wafBlocked: true };
    }
    // 新增指纹 5: nginx 默认 405 错误页 + nginx 标志性 footer (`<hr><center>nginx`)
    // 即使 server 头丢失或被改成其他值,只要 body 是这个标准模板
    // 且来自一个 JSON API 上游(返回 text/html 本身就异常),就认定为 WAF
    if (resp.status === 405 && ct.includes("text/html") &&
        text.length < 2048 &&
        text.includes("<title>405 Not Allowed</title>") &&
        /<hr[^>]*>\s*<center>\s*nginx/i.test(text)) {
      return { wafBlocked: true };
    }

    // 新增兜底指纹 6: JSON API 上游(anthropic/openai)返回 405 + text/html
    // 正常的 API 405 应该是 JSON 格式错误;HTML 405 来自 nginx/Caddy 这类
    // 反向代理或 WAF 拦截。这个项目所有上游都是 JSON API,任何 HTML 405
    // 都是异常。为了保守,只匹配明显是网关默认错误页的(短 body + 标准
    // 标题),避免误伤偶发的 HTML 帮助页。
    if (resp.status === 405 && ct.includes("text/html") && text.length < 2048 &&
        (text.includes("<title>405") || text.includes("<h1>405"))) {
      return { wafBlocked: true };
    }
    // Not a WAF block — reconstruct a fresh Response with the peeked
    // body text. The new Response has the same status, headers, and a
    // brand-new readable body stream that downstream code can read freely.
    //
    // v0.2.2+ note: if we hit MAX_PEEK without finding the signature,
    // `text` is only the first 32KB of the body — the original stream
    // was cancelled, so the rest is lost. This is acceptable because:
    //   1. The only legitimate non-WAF response that's > 32KB + HTML
    //      + status 200/403/405 is an unusual upstream error page.
    //   2. We forward the (truncated) body to the client anyway — the
    //      client's HTML parser will render what it can.
    //   3. The alternative (reading the full body) has worse failure
    //      modes: OOM on huge responses, multi-second event-loop stalls.
    return {
      wafBlocked: false,
      response: new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      }),
    };
  } catch {
    // Body read failed — return original resp (body may still be readable
    // if the read threw before consuming; if not, downstream will error
    // anyway and there's nothing we can do here).
    return { wafBlocked: false, response: resp };
  }
}

/**
 * Count `thinking` / `redacted_thinking` content blocks across all messages.
 * Used for diagnostic logging so users can verify the strip-thinking-blocks
 * transform actually fired.
 */
function countThinkingBlocks(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as Record<string, unknown>).type;
        if (t === "thinking" || t === "redacted_thinking") count++;
      }
    }
  }
  return count;
}

/**
 * Count `tool_result` blocks that carry a `cache_control` field. These get
 * stripped by sanitizeContentBlocks() because ZCode's start-plan gateway
 * rejects them with 3001. Used for diagnostic logging.
 */
function countToolResultCacheControl(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result" && b.cache_control !== undefined) count++;
      }
    }
  }
  return count;
}

/**
 * Build a one-line summary of the transformed request body for diagnostic
 * logging on upstream 4xx. Shows top-level fields that GLM commonly rejects
 * (thinking, context_management, output_config), the message role/content-type
 * sequence (so role-alternation issues are visible), and the system block count.
 *
 * The full body can be 90KB+; this summary is <500 chars and surfaces exactly
 * the fields that cause GLM 3001 "parameter error".
 */
function summarizeBody(body: unknown): string {
  if (!body || typeof body !== "object") return "(empty)";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];

  // Top-level fields GLM cares about
  if (b.model) parts.push(`model=${b.model}`);
  parts.push(`thinking=${JSON.stringify(b.thinking)}`);
  if (b.context_management) parts.push("context_management=present");
  if (b.output_config) parts.push("output_config=present");
  if (b.metadata) parts.push(`metadata=${JSON.stringify(b.metadata).slice(0, 80)}`);

  // Messages — role + content block types per message, with cache_control flags
  // so we can see if cache_control is landing on tool_result blocks (which
  // triggers ZCode gateway 3001).
  const messages = b.messages;
  if (Array.isArray(messages)) {
    const msgSummary = messages.map((m: unknown, i: number) => {
      if (!m || typeof m !== "object") return `[${i}]?`;
      const msg = m as Record<string, unknown>;
      const role = msg.role ?? "?";
      const content = msg.content;
      if (typeof content === "string") return `[${i}]${role}/str`;
      if (!Array.isArray(content)) return `[${i}]${role}/?`;
      const types = content.map((c: unknown) => {
        if (!c || typeof c !== "object") return "?";
        const blk = c as Record<string, unknown>;
        const t = blk.type ?? "?";
        // Annotate cache_control presence so tool_result+cache_control is visible
        const cc = blk.cache_control ? "+cc" : "";
        // For tool_result blocks, show content format (str vs arr) and is_error
        // presence — these are common 3001 triggers on ZCode gateway.
        let suffix = "";
        if (t === "tool_result") {
          if (typeof blk.content === "string") suffix = "/str";
          else if (Array.isArray(blk.content)) suffix = "/arr";
          if ("is_error" in blk) suffix += "/+err";
        }
        return `${t}${cc}${suffix}`;
      });
      return `[${i}]${role}/{${types.join(",")}}`;
    });
    parts.push(`msgs[${msgSummary.join(",")}]`);
  }

  // System block count (relocation may have changed it)
  if (Array.isArray(b.system)) {
    parts.push(`system=${b.system.length} blocks`);
  } else if (typeof b.system === "string") {
    parts.push("system=string");
  }

  // Tool count
  if (Array.isArray(b.tools)) {
    parts.push(`tools=${b.tools.length}`);
  }

  return parts.join(" | ");
}

/**
 * Create a passthrough response that streams the upstream body to the client.
 * Preserves status, headers, and body stream.
 */
function passthroughResponse(upstream: Response, body?: ReadableStream<Uint8Array>): Response {
  const headers = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-encoding",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];

  for (const h of forwardHeaders) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(body ?? upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** True when the client request explicitly accepts gzip (and has not disabled it via q=0). */
function clientAcceptsGzip(req: Request): boolean {
  const ae = req.headers.get("accept-encoding");
  if (!ae) return false;
  return /\bgzip\b(?!\s*;\s*q=0(?:\.0+)?\s*(?:,|$))/i.test(ae);
}

/**
 * Gzip a fully-materialized payload as a non-blocking ReadableStream.
 *
 * v0.2.0.8: replaces `Bun.gzipSync(payload)`, which blocked the event loop
 * for ~5-20ms per 200KB response. Under batch concurrency this serialized
 * all responses. We now pipe the bytes through a `CompressionStream`
 * (web-standard, Bun/Node/Deno all implement it natively) so the compression
 * happens off the main thread. The output is a stream the Response can
 * consume directly.
 *
 * Falls back to `Bun.gzipSync` if `CompressionStream` is unavailable for any
 * reason (defensive — every modern runtime ships it). The fallback path keeps
 * the old sync behaviour so we never regress to "no compression".
 */
function gzipPayloadStream(payload: Uint8Array): ReadableStream<Uint8Array> {
  try {
    // Wrap the buffer in a single-chunk ReadableStream and pipe it through
    // gzip. The stream completes after one chunk + a flush.
    //
    // v0.2.0.8 type note: TS 5.9's stricter Uint8Array<ArrayBuffer> vs
    // Uint8Array<ArrayBufferLike> generics clash with CompressionStream's
    // ReadableWritablePair signature. The runtime behaviour is correct on
    // every supported platform; we cast through `as unknown as` to satisfy
    // tsc without changing semantics.
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    return readable.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  } catch {
    // Fallback: synchronous gzip, wrapped as a stream so the caller still
    // gets a ReadableStream<Uint8Array>. This path is only hit on very old
    // runtimes missing CompressionStream.
    const gz = Bun.gzipSync(payload as Uint8Array<ArrayBuffer>);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gz as Uint8Array);
        controller.close();
      },
    });
  }
}

/** Build a translated batch (non-streaming) OpenAI response. Gzip if client accepts. */
async function translatedBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
  credKey?: string,
  captchaMs: number = 0,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, model);
  const json = JSON.stringify(openaiResp);
  const payload = new TextEncoder().encode(json);
  // vceshi0.0.6+: capture input tokens from translated OpenAI response usage
  const inTok = openaiResp.usage?.prompt_tokens ?? 0;
  const outTok = openaiResp.usage?.completion_tokens ?? 0;
  // v0.2.0.6: capture cache-read tokens from upstream Anthropic usage
  const cacheReadTok = parsedAnthropic.usage?.cache_read_input_tokens ?? 0;

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey, captchaMs, cacheReadTok);
    // v0.2.0.8: stream the payload through CompressionStream instead of
    // Bun.gzipSync — avoids blocking the event loop for large responses.
    return new Response(gzipPayloadStream(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey, captchaMs, cacheReadTok);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

function forwardedUpstreamHeaders(): string[] {
  return [
    "x-request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
  ];
}

/**
 * Build a translated batch (non-streaming) Responses API response.
 * Saves the input+output to the in-memory store keyed by the new response id,
 * so subsequent requests with `previous_response_id` can replay the history.
 * Gzip if client accepts.
 */
async function translatedResponsesBatchResponse(
  clientReq: Request,
  upstream: Response,
  model: string,
  reqId: string,
  format: Format,
  meta: RequestMeta,
  started: number,
  headersAt: number,
  previousResponseId: string | undefined,
  clientInput: unknown,
  credKey?: string,
  captchaMs: number = 0,
): Promise<Response> {
  const raw = await upstream.text();
  let parsedAnthropic: AnthropicMessagesResponse;
  try {
    parsedAnthropic = JSON.parse(raw) as AnthropicMessagesResponse;
  } catch (err) {
    printRow(reqId, format, meta, 502, started, headersAt, 0, 0, 0);
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = translateResponseAnthropicToResponses(parsedAnthropic, model, previousResponseId ?? null);

  // Persist turn for previous_response_id chaining.
  const normalizedInput = typeof clientInput === "string"
    ? [{ type: "message", role: "user", content: clientInput }]
    : Array.isArray(clientInput) ? clientInput : [];
  saveTurn(responsesResp.id, normalizedInput as unknown[], responsesResp.output as unknown[]);

  const json = JSON.stringify(responsesResp);
  const payload = new TextEncoder().encode(json);
  // vceshi0.0.6+: capture input/output tokens from translated Responses API usage
  const inTok = responsesResp.usage?.input_tokens ?? 0;
  const outTok = responsesResp.usage?.output_tokens ?? 0;
  // v0.2.0.6: capture cache-read tokens from upstream Anthropic usage
  const cacheReadTok = parsedAnthropic.usage?.cache_read_input_tokens ?? 0;

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/json");
  for (const h of forwardedUpstreamHeaders()) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }

  if (clientAcceptsGzip(clientReq)) {
    respHeaders.set("content-encoding", "gzip");
    printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey, captchaMs, cacheReadTok);
    // v0.2.0.8: stream through CompressionStream (see gzipPayloadStream).
    return new Response(gzipPayloadStream(payload), {
      status: upstream.status,
      headers: respHeaders,
    });
  }
  printRow(reqId, format, meta, upstream.status, started, headersAt, outTok, 0, 0, false, inTok, credKey, captchaMs, cacheReadTok);
  return new Response(payload, {
    status: upstream.status,
    headers: respHeaders,
  });
}

function translatedSseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

interface RequestMeta {
  model: string;
  stream: boolean;
}

function peekParsedBody(parsed: unknown): RequestMeta {
  if (!parsed || typeof parsed !== "object") return { model: "-", stream: false };
  const p = parsed as Record<string, unknown>;
  return {
    model: typeof p.model === "string" ? p.model : "-",
    stream: p.stream === true,
  };
}

/**
 * Shell-glob style matcher supporting `*` (any chars) and `?` (single char).
 * Case-insensitive — model ids often differ only in case ("GLM-5" vs "glm-5").
 * Implemented as a non-backtracking DP so a pathological pattern like
 * "a*****b" against "aaaaaa...a" won't blow up.
 *
 * Examples:
 *   globMatch("glm-5*", "glm-5.1")      // true
 *   globMatch("glm-5?", "glm-5.1")      // true
 *   globMatch("glm-5", "glm-5")         // true (exact match)
 *   globMatch("glm-5", "glm-5.1")       // false (no wildcard)
 */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern) return false;
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  // Fast paths
  if (p === "*") return true;
  if (!p.includes("*") && !p.includes("?")) return p === v;

  // DP: dp[i] = true if v[0..i) matches the part of pattern processed so far.
  // Use Uint8Array (1 byte per cell) instead of Array<boolean> — slightly
  // less memory, faster to allocate (no .fill call needed since 0 is falsy).
  const dp = new Uint8Array(v.length + 1);
  dp[0] = 1;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    if (ch === "*") {
      // `*` matches zero or more chars: dp[j] = dp[j] || dp[j-1]
      for (let j = 1; j <= v.length; j++) dp[j] = dp[j]! || dp[j - 1]! ? 1 : 0;
    } else {
      // Single char (or `?`): must match exactly one char, shift right-to-left.
      for (let j = v.length; j >= 1; j--) {
        dp[j] = dp[j - 1]! && (ch === "?" || ch === v[j - 1]) ? 1 : 0;
      }
      dp[0] = 0; // any non-* char requires at least one input char
    }
  }
  return dp[v.length] === 1;
}

/**
 * Check if a model id is a known GLM model OR a plausible GLM variant (starts with "glm-").
 */
function isKnownGlmModel(model: string): boolean {
  if (!model) return false;
  if (model.startsWith("glm-")) return true;
  return knownGlmModelSet.has(model);
}

const knownGlmModelSet = new Set(listModelIds());

/**
 * Look up a model rewrite in the configured modelMappings.
 * Case-insensitive exact match on `from` (mappings are stored lowercased).
 * Returns the target model id, or undefined if no mapping matches.
 */
function lookupModelMapping(clientModel: string, mappings: { from: string; to: string }[] | undefined): string | undefined {
  if (!mappings || mappings.length === 0) return undefined;
  const lower = clientModel.toLowerCase();
  return mappings.find((m) => m.from === lower)?.to;
}

/** Translate a client request body object to Anthropic JSON. Returns error Response on failure. */
function translateClientBodyObj(parsed: unknown, format: Format, opts?: { forceThinkingModels?: string[] }): Response | unknown {
  if (parsed === undefined || parsed === null) {
    return errorResponse(400, "translation_failed", `${format} request body is empty; cannot translate.`);
  }
  try {
    if (format === "openai-responses") {
      return translateRequestResponsesToAnthropic(parsed as OpenAIResponseRequest, opts?.forceThinkingModels ? { forceThinkingModels: opts.forceThinkingModels } : undefined);
    }
    return translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
  } catch (err) {
    return errorResponse(400, "translation_failed", `${format}→Anthropic translation failed: ${(err as Error).message}`);
  }
}

let reqCounter = 0;
let headerPrinted = false;

function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

function printHeader(): void {
  if (headerPrinted) return;
  headerPrinted = true;
  console.log(
    "| #    | Time       | Fmt | Model       | Mode   | Stat |    TTFB | Captcha |   Tok |  tok/s |   Total |",
  );
  console.log(
    "|------|------------|-----|-------------|--------|------|---------|---------|-------|--------|---------|",
  );
}

function printRow(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  started: number,
  headersAt: number,
  tokens: number,
  avgTps: number,
  streamEndAt: number,
  retried: boolean = false,
  inputTokens: number = 0,
  credKey?: string,
  captchaMs: number = 0,
  cacheReadTokens: number = 0,
  thinkingTokens: number = 0,
): void {
  printHeader();
  const ts = new Date(started).toISOString().slice(11, 19);
  const tag = format === "anthropic" ? "ANT" : format === "openai-responses" ? "RSP" : "OAI";
  const mode = meta.stream ? "stream" : "batch";
  const ttfbMs = headersAt - started;
  const ttfb = `${ttfbMs}ms`;
  const captcha = captchaMs > 0 ? `${captchaMs}ms` : "-";
  const total = streamEndAt > started ? `${streamEndAt - started}ms` : "-";
  const tok = tokens > 0 ? String(tokens) : "-";
  // v0.2.0.6: input token display reflects the TOTAL input the model saw
  // (new input + cache_read + cache_creation). When cache is in play, also
  // show the cache-hit portion inline so users can see prompt caching is
  // working: "in: 41152 (c:40000) out: 4413".
  const totalInput = inputTokens + cacheReadTokens;
  const inTok = totalInput > 0 ? String(totalInput) : "-";
  const cacheMarker = cacheReadTokens > 0 ? `(c:${cacheReadTokens})` : "";
  const inField = `${inTok.padStart(5)}${cacheMarker}`.trim();
  // v0.2.0.7: when thinking is enabled, GLM streams thinking_delta events
  // before the final text output. Show thinking token count inline so users
  // can distinguish "model is thinking" from "model produced final answer".
  // Format: "out: 529 (th:1234)" means 529 output tokens + 1234 thinking tokens.
  const thinkMarker = thinkingTokens > 0 ? `(th:${thinkingTokens})` : "";
  const outField = `${tok.padStart(5)}${thinkMarker}`.trim();
  const tps = avgTps > 0 ? avgTps.toFixed(1) : "-";
  // When captcha took a significant portion of TTFB, show the breakdown
  if (captchaMs > 0 && ttfbMs > 0) {
    const netTtfb = ttfbMs - captchaMs;
    console.log(
      `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${captcha.padStart(7)} | in:${inField} out:${outField} | ${tps.padStart(6)} | ${total.padStart(7)} |  TTFB=${ttfbMs}ms (net ${netTtfb}ms + captcha ${captchaMs}ms)`,
    );
  } else {
    console.log(
      `| ${reqId.padEnd(4)} | ${ts.padEnd(10)} | ${tag} | ${meta.model.padEnd(11)} | ${mode.padEnd(6)} | ${String(status).padStart(4)} | ${ttfb.padStart(7)} | ${captcha.padStart(7)} | in:${inField} out:${outField} | ${tps.padStart(6)} | ${total.padStart(7)} |`,
    );
  }
  // Record stats for the admin dashboard
  recordStat({
    id: reqId,
    time: ts,
    model: meta.model,
    status,
    ttfb: String(ttfbMs),
    tokens: String(tokens),
    inputTokens: String(totalInput),
    cacheReadTokens: cacheReadTokens > 0 ? String(cacheReadTokens) : undefined,
    credentialKey: credKey,
    retried,
    captchaMs: String(captchaMs),
  });
}

/**
 * Build a TransformStream that observes an SSE/byte stream for stats while
 * passing every chunk through to the client unchanged.
 *
 * v0.2.0.8: replaces the `body.tee()` + parallel `observeStream()` reader
 * pattern. The tee() approach forced both branches to share one internal
 * buffer in Bun's whatwg implementation: the slow stats reader (fire-and-
 * forget async) held back the fast client branch, so on long LLM streams
 * (100K+ tokens) the entire response buffered in memory until the stats
 * reader caught up — doubling peak memory.
 *
 * This TransformStream parses each chunk inline during the `transform()`
 * callback, which runs on the same pump as the client response. No second
 * reader, no shared buffer, no back-pressure stall. Bytes flow through and
 * are parsed in-place.
 *
 * The stats state (tokens, inputTokens, sseBuffer, etc.) is captured in the
 * closure passed to `onComplete`. `parseSse` is the same parser used by the
 * standalone observeStream — kept in sync via the `parseSseChunk` export.
 */
function createStatsTransform(
  reqId: string,
  format: Format,
  meta: RequestMeta,
  status: number,
  requestSentAt: number,
  contentEncoding: string | null,
  credKey: string | undefined,
  captchaMs: number,
): { transform: TransformStream<Uint8Array, Uint8Array>; done: Promise<void> } {
  const compressed = contentEncoding !== null;
  const state = {
    tokens: 0,
    inputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    sseBuffer: "",
    firstChunkAt: 0,
  };

  let resolveDone: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (state.firstChunkAt === 0) state.firstChunkAt = Date.now();
      if (!compressed) {
        state.sseBuffer += new TextDecoder().decode(chunk, { stream: true });
        const idx = state.sseBuffer.lastIndexOf("\n");
        if (idx >= 0) {
          observeStreamParseSse(state.sseBuffer.slice(0, idx), state);
          state.sseBuffer = state.sseBuffer.slice(idx + 1);
        }
      }
      // Pass the chunk straight through to the client — no buffering.
      controller.enqueue(chunk);
    },
    flush() {
      if (!compressed && state.sseBuffer) {
        observeStreamParseSse(state.sseBuffer, state);
      }
      const endAt = Date.now();
      const ttfbMs = (state.firstChunkAt > 0 ? state.firstChunkAt : endAt) - requestSentAt;
      const totalMs = endAt - requestSentAt;
      const avgTps = state.tokens > 0 && totalMs > 0 ? state.tokens / (totalMs / 1000) : 0;
      printRow(reqId, format, meta, status, requestSentAt, requestSentAt + ttfbMs, state.tokens, avgTps, endAt, false, state.inputTokens, credKey, captchaMs, state.cacheReadTokens, state.thinkingTokens);
      resolveDone();
    },
  });

  return { transform, done };
}

/**
 * SSE heartbeat transform — keeps the client connection alive while the
 * upstream is slow to emit its first byte.
 *
 * Why this exists: Cloudflare (and other reverse proxies) impose a Proxy
 * Read Timeout (CF Free/Pro = 100s). GLM-5.2 thinking mode can sit silent
 * for 60-180s before the first SSE event. Without heartbeat, CF returns
 * 524 to the client and tears down the connection.
 *
 * Mechanism: while no real chunk has arrived from upstream yet, flush a
 * no-op SSE comment line (`: keepalive\n\n`) to the client every
 * `intervalMs`. SSE comment lines are spec-compliant and silently ignored
 * by every conformant client. The bytes keep TCP active, resetting CF's
 * idle timer.
 *
 * Once the first real chunk arrives, the heartbeat stops immediately and
 * never re-fires — zero overhead after TTFB.
 *
 * Pipeline order: this transform is placed BEFORE createStatsTransform
 * (i.e. closer to the client). Reason: stats parses SSE events to count
 * tokens; if heartbeat comment lines flowed through stats, they'd be
 * harmlessly ignored (stats only looks at `event:` / `data:` lines), but
 * it's cleaner to keep heartbeat bytes out of stats entirely. Putting
 * heartbeat upstream-of-stats means stats sees only real upstream bytes.
 *
 * Wait — actually the opposite order is better: stats should see what the
 * CLIENT sees (including heartbeat), so stats' TTFB measurement reflects
 * when the client first saw bytes. So we place heartbeat AFTER stats
 * (closer to client). stats' TTFB is then "time to first real upstream
 * chunk", which is what we want to measure; heartbeat bytes flow to the
 * client without stats seeing them. This is the chosen order.
 *
 * Cancellation: if the client disconnects mid-stream, the underlying
 * Response stream is cancelled, which propagates a cancel signal up the
 * pipeline. We also guard the interval with a `closed` flag and clear it
 * in cancel() to prevent timer leaks. As a belt-and-suspenders defense,
 * if enqueue throws (stream errored/closed), we clear the interval.
 *
 * @param intervalMs Heartbeat interval in ms. 0 or negative = disabled
 *                  (the transform becomes a pure passthrough).
 */
function createSseHeartbeatTransform(intervalMs: number): TransformStream<Uint8Array, Uint8Array> {
  // Disabled / invalid interval — pure passthrough, no timer.
  if (!intervalMs || intervalMs <= 0) {
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });
  }

  const commentBytes = new TextEncoder().encode(SSE_HEARTBEAT_CONST.COMMENT_LINE);
  let firstChunkSeen = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const flushHeartbeat = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (closed || firstChunkSeen) return;
    try {
      controller.enqueue(commentBytes);
    } catch {
      // Stream errored or closed — stop the timer to prevent leak.
      if (timer) { clearInterval(timer); timer = null; }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      // Kick off the heartbeat immediately. We use setInterval (not
      // setTimeout chain) because it's cheaper and Bun's timer impl
      // doesn't drift under load the way recursive setTimeout can.
      timer = setInterval(() => flushHeartbeat(controller), intervalMs);
      // Don't keep the event loop alive solely for heartbeat — if the
      // only thing pending is our timer, the process should be able to
      // exit. The real request pipeline (fetch response body) holds the
      // loop alive anyway.
      if (timer && typeof timer.unref === "function") timer.unref();
    },
    transform(chunk, controller) {
      // First real chunk from upstream — stop the heartbeat forever.
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (timer) { clearInterval(timer); timer = null; }
      }
      controller.enqueue(chunk);
    },
    flush() {
      // flush fires on normal stream end OR when the downstream cancels
      // (client disconnect) — both cases mean we should stop the timer.
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  });
}

/** Exported for testing — see handler.test.ts "SSE heartbeat" describe block. */
export const _testing = { createSseHeartbeatTransform };

/**
 * Inlined SSE parser for createStatsTransform — mirrors the logic in
 * observeStream.parseSse exactly. Kept as a standalone function (rather than
 * a closure) so it doesn't get re-created per chunk. Any change to the
 * parsing rules MUST be applied here AND in observeStream above.
 *
 * v0.2.2+ PERF: substring-based early-exit before JSON.parse. Each SSE
 * line is checked for at least one of the "interesting" markers; lines
 * without any marker (keepalive pings, unknown event types) are skipped
 * without paying the JSON.parse cost. On a long streaming response with
 * 1000+ events, this saves 100ms+ of CPU.
 */
function observeStreamParseSse(text: string, state: {
  tokens: number; inputTokens: number; thinkingTokens: number; cacheReadTokens: number;
}): void {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const dataStr = line.slice(5).trimStart();
    if (!dataStr || dataStr === "[DONE]") continue;
    // v0.2.2+ PERF: cheap substring check before JSON.parse. The markers
    // below cover every branch that actually updates state — anything
    // without one of these markers is guaranteed to be a no-op (the
    // try/catch below would parse and discard it).
    let hasMarker = false;
    for (const marker of SSE_CONST.STATS_INTERESTING_MARKERS) {
      if (dataStr.includes(marker)) { hasMarker = true; break; }
    }
    if (!hasMarker) continue;
    try {
      const j = JSON.parse(dataStr);
      if (j.type === "message_start" && j.message?.usage) {
        const u = j.message.usage;
        if (typeof u.input_tokens === "number" && u.input_tokens > 0) state.inputTokens = u.input_tokens;
        if (typeof u.cache_read_input_tokens === "number" && u.cache_read_input_tokens > 0) state.cacheReadTokens = u.cache_read_input_tokens;
      }
      if (j.usage?.completion_tokens) { state.tokens = j.usage.completion_tokens; }
      if (j.usage?.output_tokens) { state.tokens = j.usage.output_tokens; }
      if (j.usage?.prompt_tokens) { state.inputTokens = j.usage.prompt_tokens; }
      if (j.usage?.input_tokens) { state.inputTokens = j.usage.input_tokens; }
      if (j.usage?.cache_read_input_tokens) { state.cacheReadTokens = j.usage.cache_read_input_tokens; }
      const oai = j.choices?.[0]?.delta?.content;
      if (typeof oai === "string" && oai.length > 0) { state.tokens++; continue; }
      if (j.type === "content_block_delta" && j.delta?.type === "thinking_delta") {
        const t = j.delta?.thinking;
        if (typeof t === "string" && t.length > 0) state.thinkingTokens++;
        continue;
      }
      if (j.type === "content_block_delta" && j.delta?.type === "text_delta") {
        const t = j.delta?.text;
        if (typeof t === "string" && t.length > 0) state.tokens++;
        continue;
      }
      if (j.type === "response.output_text.delta") {
        const t = j.delta;
        if (typeof t === "string" && t.length > 0) state.tokens++;
        continue;
      }
      if (j.type === "response.completed" && j.response?.usage) {
        const u = j.response.usage;
        if (u.output_tokens) state.tokens = u.output_tokens;
        if (u.input_tokens) state.inputTokens = u.input_tokens;
        if (u.cache_read_input_tokens) state.cacheReadTokens = u.cache_read_input_tokens;
        // v0.2.0.10: Responses API carries thinking token count in
        // usage.output_tokens_details.reasoning_tokens. Prefer this
        // authoritative value over chunk counting when present.
        const rt = u.output_tokens_details?.reasoning_tokens;
        if (typeof rt === "number" && rt > 0) state.thinkingTokens = rt;
        continue;
      }
      if (j.type === "message_delta" && j.usage) {
        if (j.usage.output_tokens) state.tokens = j.usage.output_tokens;
        if (j.usage.input_tokens) state.inputTokens = j.usage.input_tokens;
        if (j.usage.cache_read_input_tokens) state.cacheReadTokens = j.usage.cache_read_input_tokens;
        // v0.2.0.10: GLM extension — message_delta.usage may carry an
        // authoritative reasoning_tokens count. Prefer it over chunk counting.
        if (typeof j.usage.reasoning_tokens === "number" && j.usage.reasoning_tokens > 0) state.thinkingTokens = j.usage.reasoning_tokens;
        continue;
      }
      // v0.2.0.10: Chat Completions streaming — the final chunk carries usage
      // with cache_read_input_tokens / reasoning_tokens as non-standard
      // extension fields (added by sse-translator.ts). OpenAI chunks don't
      // have a `type` field, so we match by the presence of `choices` +
      // `usage`. This must run AFTER the message_delta / response.completed
      // branches above so those take precedence on type collisions.
      if (j.choices && j.usage) {
        if (j.usage.cache_read_input_tokens) state.cacheReadTokens = j.usage.cache_read_input_tokens;
        if (typeof j.usage.reasoning_tokens === "number" && j.usage.reasoning_tokens > 0) state.thinkingTokens = j.usage.reasoning_tokens;
      }
    } catch {}
  }
}

/**
 * Debug log the upstream response — shows EXACTLY what the upstream returned.
 *
 * Uses `resp.clone()` to read a copy of the body without consuming the
 * original — the caller's retry / passthrough logic still sees the full
 * response. Response.clone() is supported by both Bun and the Fetch spec; it
 * internally buffers the body so both the clone and original can be read.
 *
 * Logs:
 *   - HTTP status + key headers (content-type, retry-after, empty-stream flag,
 *     ratelimit headers)
 *   - Body preview: first 1000 chars (for JSON) or first 2KB (for SSE streams)
 *
 * This is the "调试日志" the user requested: see what 529 / empty 200 / captcha
 * 403 actually returned, including the error JSON body. Enabled via
 * config.logging.debug or ZCODE_PROXY_DEBUG_LOGGING=1.
 *
 * MUST never throw — all operations wrapped in try/catch.
 */
async function logUpstreamResponseDebug(reqId: string, resp: Response, _isStream: boolean): Promise<void> {
  try {
    const status = resp.status;
    const ct = resp.headers.get("content-type") ?? "";
    const ce = resp.headers.get("content-encoding") ?? "";
    const retryAfter = resp.headers.get("retry-after") ?? "";
    const emptyStream = resp.headers.get("x-zcode-empty-stream") ?? "";
    const ratelimitRemaining = resp.headers.get("anthropic-ratelimit-requests-remaining")
      ?? resp.headers.get("x-ratelimit-remaining") ?? "";

    // Header summary — always logged
    const headerParts: string[] = [`status=${status}`, `ct=${ct || "(none)"}`];
    if (ce && ce !== "identity") headerParts.push(`encoding=${ce}`);
    if (retryAfter) headerParts.push(`retry-after=${retryAfter}`);
    if (emptyStream) headerParts.push(`empty-stream=${emptyStream}`);
    if (ratelimitRemaining) headerParts.push(`ratelimit-remaining=${ratelimitRemaining}`);
    console.log(`${reqId} [debug] upstream response: ${headerParts.join(" | ")}`);

    // Body preview via clone() — doesn't consume the original response.
    // clone() buffers the body internally; both the clone and original can
    // be read independently. This is the cleanest way to inspect a Response
    // without breaking downstream passthrough.
    let clone: Response;
    try {
      clone = resp.clone();
    } catch {
      // Some Response implementations (e.g. streaming with non-cloneable
      // bodies) may reject clone() — skip body preview in that case.
      console.log(`${reqId} [debug] (body preview unavailable — response not cloneable)`);
      return;
    }

    // Read the clone's body with a timeout so a hung stream doesn't block
    // the request forever.
    //
    // v0.2.0.6: For SSE streams, the AUTHORITATIVE usage (including cache
    // token counts) is in the `message_delta` event near the END of the
    // stream — the previous 2KB cap + "stop at first \n\n" logic always
    // captured only message_start (with 0/0 placeholder usage). We now
    // keep reading until we see `message_delta` (which carries the real
    // usage) or hit the 8KB / timeout limit. This lets users see real token
    // counts in the debug log without enabling full request logging.
    //
    // v0.2.0.7: timeout raised from 3s to 10s for SSE streams. When thinking
    // is enabled, GLM streams a long series of thinking_delta events BEFORE
    // producing any text output — the message_delta (carrying usage) only
    // arrives at the very end. A 3s timeout always cut off mid-thinking,
    // showing "(read timeout after 3s)" instead of the real usage. 10s is
    // enough for most thinking-enabled responses; very long thinking traces
    // (30s+) will still time out, but at least we capture the thinking_delta
    // prefix for diagnosis. JSON error responses stay at 3s (small bodies).
    const isSSE = ct.includes("text/event-stream");
    const PREVIEW_TIMEOUT_MS = isSSE ? 10_000 : 3_000;
    const previewPromise = (async () => {
      if (!clone.body) return "(no body)";
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let preview = "";
      const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
      const PREVIEW_CAP = isSSE ? 8192 : 2048;
      while (preview.length < PREVIEW_CAP && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        preview += decoder.decode(value, { stream: true });
        // For SSE: stop after we see message_delta (carries real usage)
        // — this is the event we care about for token diagnostics.
        if (isSSE && preview.includes('"type":"message_delta"')) break;
        // For JSON: stop when we likely have the full body (small error responses)
        if (ct.includes("application/json") && preview.length > 0 && preview.trim().endsWith("}")) break;
      }
      try { reader.cancel(); } catch {}
      return preview;
    })();

    let preview: string;
    try {
      preview = await Promise.race([
        previewPromise,
        new Promise<string>(r => setTimeout(() => r(`(read timeout after ${PREVIEW_TIMEOUT_MS / 1000}s)`), PREVIEW_TIMEOUT_MS)),
      ]);
    } catch {
      preview = "(body read failed)";
    }

    // v0.2.0.6: For SSE streams, allow up to 8KB of preview so the
    // message_delta event (carrying usage / cache tokens) is visible.
    // JSON responses stay at 1KB (small error bodies don't need more).
    const trimCap = ct.includes("text/event-stream") ? 8000 : 1000;
    const trimmed = preview.length > trimCap
      ? preview.slice(0, trimCap) + `...(truncated, total ${preview.length} chars)`
      : preview;
    console.log(`${reqId} [debug] body preview (${preview.length} chars): ${trimmed || "(empty body)"}`);
  } catch (err) {
    console.log(`${reqId} [debug] failed to log response: ${(err as Error).message}`);
  }
}

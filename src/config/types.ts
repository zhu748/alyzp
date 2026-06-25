/**
 * Configuration types for zcode-proxy.
 * @see .omo/plans/zcode-proxy.md Task 2
 */

/** Provider endpoint configuration (one per upstream provider). */
export interface ProviderEndpoints {
  /** Base URL for Anthropic-format API, e.g. "https://api.z.ai/api/anthropic". */
  anthropicBase: string;
  /** Base URL for OpenAI-format API, e.g. "https://api.z.ai/api/coding/paas/v4". */
  openaiBase: string;
  /** Provider-specific credential override. If absent, uses the global `auth.apiKey`. */
  credential?: string;
}

/** Auth section of the proxy configuration. */
export interface AuthConfig {
  /**
   * Key that clients must provide to use the proxy (via `Authorization: Bearer {proxyApiKey}`).
   * If unset, the proxy does not require client auth.
   */
  proxyApiKey?: string;
  /** How the proxy obtains the upstream credential. */
  mode: "apikey" | "oauth";
  /** Direct credential for `apikey` mode. Format: `{apiKey}` or `{apiKey}.{secret}` (Z.AI). */
  apiKey?: string;
  /** Path to stored OAuth credentials (for `oauth` mode). */
  oauthCredentialsPath?: string;
}

/**
 * Identity headers injected on every upstream request to mimic the ZCode
 * desktop client. Mirrors the `eYn` builder in the reverse-engineered bundle
 * (`_reverse/zcode.cjs`); see `_reverse/NOTEPAD.md` "How Credential is Used".
 *
 * Resolution: env var (matches ZCode's own convention) → YAML override → default.
 * `appVersion` must be printable ASCII (`/^[\x20-\x7e]+$/`); non-conforming
 * values are silently dropped and fall back to the default (current ZCode
 * release), exactly like `rYn` in the bundle.
 */
export interface ProxyIdentity {
  appVersion: string;
  sourceTitle: string;
  refererOrigin: string;
}

/** Retry configuration for upstream requests. */
export interface RetryConfig {
  /**
   * Maximum number of retry attempts for retryable status codes.
   * Set to 0 to disable retries entirely.
   * Default: 3
   */
  maxRetries: number;
  /**
   * Initial delay in milliseconds before the first retry.
   * Subsequent retries use exponential backoff: delay * backoffFactor^attempt.
   * Default: 1000
   */
  initialDelayMs: number;
  /**
   * Maximum delay cap in milliseconds. Even with exponential backoff,
   * the delay will never exceed this value.
   * Default: 8000
   */
  maxDelayMs: number;
  /**
   * Multiplier applied to the delay for each subsequent retry attempt.
   * A value of 2 means each retry waits twice as long as the previous.
   * Default: 2
   */
  backoffFactor: number;
  /**
   * HTTP status codes that should trigger a retry.
   * Common values: 429 (rate limited), 529 (site overloaded), 503 (service unavailable).
   * Default: [529]
   */
  retryableStatuses: number[];
  /**
   * Number of consecutive failed attempts (including the initial request) with
   * the same credential before automatically switching to another stored
   * credential. Set to 0 to disable credential switching entirely.
   *
   * When the threshold is reached mid-retry-loop, the proxy picks a different
   * stored credential (if any), rebuilds the request with the new credential's
   * auth headers + userId, and continues retrying. Already-tried credentials
   * are skipped in the same request to avoid cycling back to a known-bad one.
   *
   * Only effective when more than one credential is stored (multi-account mode)
   * and `retry.maxRetries` is greater than or equal to this threshold.
   * Default: 5
   */
  credentialSwitchThreshold: number;
  /**
   * Number of consecutive empty-stream 529 responses (HTTP 200 + text/event-stream
   * with zero SSE events — the typical "quota exhausted" signature) with the same
   * credential before automatically switching to another stored credential.
   *
   * This is separate from `credentialSwitchThreshold` because empty-stream is a
   * high-confidence "this credential is dead" signal — we don't want to wait
   * through 5 generic failures first. Set to 0 to disable (fall back to the
   * generic threshold). Set to 1 to switch immediately on the first empty stream.
   *
   * Only effective when more than one credential is stored (multi-account mode).
   * Default: 3
   *
   * Environment variable: ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD
   */
  emptyStreamSwitchThreshold: number;
}

/** Custom routing rule — overrides the default provider/endpoint for requests
 * whose model name matches `pattern` (shell-glob style, e.g. "glm-5*").
 */
export interface RoutingRule {
  /** Glob-style model pattern (matched against request body's `model` field). */
  pattern: string;
  /** Override provider for matched models. */
  provider: "zai" | "bigmodel";
  /** Optional endpoint override (full URL). If empty, the provider's default endpoint is used. */
  endpoint?: string;
  /** Optional note for the operator. */
  note?: string;
}

/**
 * Model mapping — rewrites the client-sent `model` field to a different id
 * before forwarding upstream. Used to make non-GLM model names (e.g. Codex CLI's
 * `gpt-5.5`) map to a real GLM model.
 *
 * Matching is case-insensitive exact match on `from`. The `to` value is used
 * verbatim — no validation against the model catalog (allows future GLM models
 * without code changes).
 */
export interface ModelMapping {
  /** Client-sent model id to rewrite (case-insensitive exact match). */
  from: string;
  /** Target model id to forward upstream. */
  to: string;
  /** Optional note for the operator. */
  note?: string;
}

/**
 * Responses-API thinking override.
 *
 * Codex CLI's `reasoning` field is frequently `null` in the wire payload
 * (the CLI drops it when local config doesn't force an effort level), so
 * the translator's "honor reasoning.effort" branch never fires and the
 * upstream GLM request goes out without `thinking`. This config lets the
 * operator force-enable thinking on `/v1/responses` for specific models
 * (matched against the *post-mapping* request model, i.e. the final GLM
 * model id) regardless of what the client sent.
 *
 * Matching is case-insensitive exact match. Empty array = disabled.
 */
export interface ResponsesThinkingConfig {
  /** Model ids (post-mapping) for which thinking is force-enabled on /v1/responses. */
  models: string[];
}

/** Top-level proxy configuration. */
export interface ProxyConfig {
  server: {
    port: number;
    host: string;
    /**
     * Upstream request timeout in milliseconds. If an upstream request takes
     * longer than this, it is aborted and a 504 Gateway Timeout is returned.
     * Set to 0 to disable (not recommended — a hung upstream connection would
     * leak resources indefinitely). Default: 300000 (5 minutes).
     */
    upstreamTimeoutMs?: number;
  };
  auth: AuthConfig;
  /** Active upstream provider. */
  provider: "zai" | "bigmodel";
  /** Which plan tier to use. "coding-plan" (default) uses direct upstream endpoints; "start-plan" routes through zcode.z.ai with JWT auth. */
  plan: "coding-plan" | "start-plan";
  /** Per-provider endpoint overrides. */
  providers: {
    zai: ProviderEndpoints;
    bigmodel: ProviderEndpoints;
  };
  /** Default model id used when client request omits `model`. */
  defaultModel: string;
  /** Whitelist of allowed model ids. */
  models: string[];
  /**
   * Force-enable streaming for Anthropic-format requests.
   *
   * When true, the proxy overrides `stream: false` (or missing stream field)
   * in Anthropic `/v1/messages` requests to `stream: true` before forwarding
   * upstream. This lets clients that default to non-streaming (e.g. some
   * Claude Code configurations) receive SSE responses instead of waiting for
   * the full batch response — providing real-time token-by-token output.
   *
   * OpenAI and Responses API formats are unaffected (they already default to
   * streaming in most clients). Only applies to the Anthropic passthrough path.
   *
   * Default: false (preserve original client's stream preference).
   */
  forceStreamAnthropic?: boolean;
  /**
   * CORS origin allowlist. When set, only origins in this list receive
   * `Access-Control-Allow-Origin` headers. When empty/unset, any origin
   * is allowed (legacy permissive behavior for backwards compatibility).
   *
   * Set via env var `ZCODE_PROXY_CORS_ALLOWLIST` (comma-separated).
   */
  corsAllowList?: string[];
  /**
   * Identity headers injected upstream. Always present after `loadConfig`;
   * defaults mirror the production ZCode desktop client.
   */
  identity: ProxyIdentity;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    /**
     * Verbose logging mode (vceshi0.0.6+).
     *
     * When true, each request logs:
     *   - The full set of upstream request headers (auth tokens masked)
     *   - The transformed request body sent to upstream (full JSON, truncated to 2000 chars)
     *
     * Default: false (simple mode — only logs request summary on 4xx, plus
     * the standard printRow table line per request).
     *
     * Toggleable via dashboard "日志配置" tab. Env var:
     * ZCODE_PROXY_VERBOSE_LOGGING=1 to enable at startup.
     */
    verbose?: boolean;
    /**
     * Debug response logging (this version).
     *
     * When true, logs the FULL upstream response details for every request:
     *   - HTTP status code
     *   - Key response headers (content-type, content-encoding, retry-after,
     *     x-zcode-empty-stream, ratelimit-* headers)
     *   - Response body preview (first 1000 chars for non-stream, or the
     *     first SSE event for streams)
     *
     * This is the "调试日志" for diagnosing quota-exhausted empty 200s, 529
     * errors with specific error JSON, captcha 403s, etc. — you see EXACTLY
     * what the upstream returned instead of just a status code.
     *
     * Default: false. Env var: ZCODE_PROXY_DEBUG_LOGGING=1 to enable at
     * startup. Also toggleable via dashboard "日志配置" tab (alongside verbose).
     */
    debug?: boolean;
  };
  /**
   * Retry configuration for upstream requests.
   * When absent, defaults are applied (3 retries, exponential backoff, 529 only).
   */
  retry: RetryConfig;
  /** Custom per-model routing rules. Empty by default. */
  routingRules?: RoutingRule[];
  /** Client model id → GLM model id rewrite table. Empty by default. */
  modelMappings?: ModelMapping[];
  /**
   * Force-enable thinking on /v1/responses for specific models. Empty by default.
   * @see ResponsesThinkingConfig
   */
  responsesThinking?: ResponsesThinkingConfig;
}

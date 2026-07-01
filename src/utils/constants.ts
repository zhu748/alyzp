/**
 * Centralized tunable constants.
 *
 * v0.2.2+: extracted from scattered magic numbers across the codebase so
 * they can be tuned from one place and discovered by new contributors.
 *
 * Each constant is also overridable via env var when the consuming module
 * supports it (see the consuming module's own env-var wiring).
 *
 * NOTE: keep this file dependency-free (only TypeScript types) so it can
 * be imported from anywhere without triggering side effects.
 */

/** Logging subsystem tunables. */
export const LOG = {
  /** Ring buffer size for in-memory log retention (SSE + batch endpoint). */
  BUFFER_SIZE: 2000,
  /** Maximum entries to replay when a new SSE client connects. */
  INITIAL_REPLAY_LIMIT: 200,
  /** Maximum entries in the lifetime-seen Set for stats dedup. */
  SEEN_IDS_LIMIT: 50_000,
  /** Number of entries to evict when SEEN_IDS_LIMIT is hit (LRU-style). */
  SEEN_IDS_EVICT_BATCH: 1_000,
  /** Heartbeat interval for SSE log streams (ms). */
  HEARTBEAT_MS: 30_000,
  /** Maximum SSE connection lifetime before forced reconnect (ms). */
  MAX_CONNECTION_MS: 120_000,
  /** File log flush interval (ms). */
  FILE_FLUSH_INTERVAL_MS: 500,
  /** Maximum pending entries in the file log buffer before drop. */
  FILE_BUFFER_MAX: 1000,
  /** Verbose log char limit (debug + [verbose] lines). */
  VERBOSE_MAX_CHARS: 3000,
  /** Regular log char limit. */
  REGULAR_MAX_CHARS: 500,
} as const;

/** Retry / backoff tunables. */
export const RETRY = {
  /** Hard ceiling on total retry attempts (including credential switches). */
  MAX_TOTAL_ATTEMPTS_CAP: 20,
  /** Multiplier applied to base maxRetries to compute the per-request cap. */
  MAX_TOTAL_ATTEMPTS_FACTOR: 4,
  /** Flat extra attempts allowed on top of the multiplier-based cap. */
  MAX_TOTAL_ATTEMPTS_FLAT: 10,
} as const;

/** Proxy pool tunables. */
export const PROXY_POOL = {
  /** TTL for `triedPoolProxies` entries within a single request (ms).
   *  After this cooldown, a previously-tried proxy becomes eligible again. */
  TRIED_TTL_MS: 60_000,
  /** Interval (ms) for debounced flush of in-memory `failures` counters. */
  FAILURE_FLUSH_DEBOUNCE_MS: 5_000,
  /** Cooldown (ms) after which a failed proxy becomes eligible for pickProxy
   *  again. Prevents immediately re-picking a just-failed proxy on the next
   *  request, while still allowing recovery after the cooldown expires. */
  FAILURE_COOLDOWN_MS: 60_000,
} as const;

/** Captcha solver tunables. */
export const CAPTCHA = {
  /** Hard cap on captcha config cache (ms). */
  CONFIG_CACHE_MS: 60_000,
} as const;

/** Admin API tunables. */
export const ADMIN = {
  /** Maximum request body size for admin JSON endpoints (bytes). */
  MAX_BODY_BYTES: 1 * 1024 * 1024,
} as const;

/** WAF detection tunables. */
export const WAF = {
  /** Maximum body size to peek when checking for Aliyun WAF signature (bytes). */
  MAX_PEEK_BYTES: 32 * 1024,
  /** Aliyun WAF signature string (always present in the WAF error page). */
  SIGNATURE: "errors.aliyun.com",
} as const;

/** SSE batch reassembler tunables. */
export const SSE = {
  /** Substring markers used to short-circuit JSON.parse in stats observer. */
  STATS_INTERESTING_MARKERS: [
    '"message_start"',
    '"message_delta"',
    '"response.completed"',
    '"content_block_delta"',
    '"response.output_text.delta"',
    '"choices"',
    '"usage"',
  ] as const,
} as const;

/**
 * SSE heartbeat tunables.
 *
 * Problem: Cloudflare (and other reverse proxies) impose a Proxy Read
 * Timeout — CF Free/Pro/Lite/Business = 100s, Enterprise up to 6000s.
 * When the upstream LLM takes longer than that to emit the FIRST byte
 * (common with GLM-5.2 thinking mode, which can sit silent for 60-180s
 * before the first SSE event), CF returns 524 to the client and tears
 * down the connection.
 *
 * Solution: while we're waiting for the upstream's first SSE chunk,
 * periodically flush a no-op SSE comment line (`: keepalive\n\n`) to
 * the client. SSE comment lines are part of the spec (RFC) and silently
 * ignored by every conformant SSE client (Anthropic SDK, OpenAI SDK,
 * Cherry Studio, Claude Code, Codex, curl). The bytes keep the TCP
 * connection active, which resets CF's idle timer.
 *
 * Once the upstream emits its first real chunk, the heartbeat stops
 * immediately and never re-fires for the rest of the stream — so it
 * adds zero overhead after TTFB.
 *
 * Tuning:
 *   - 15s default: well under CF's 100s limit, low overhead (~6 packets
 *     per minute of silence), and matches what OpenAI/Anthropic themselves
 *     use for their own SSE endpoints.
 *   - Set to 0 (or via env ZCODE_PROXY_SSE_HEARTBEAT_MS=0) to disable.
 *   - Lowering below ~5s is wasteful; raising above ~60s defeats the
 *     purpose if the upstream is behind CF.
 */
export const SSE_HEARTBEAT = {
  /** Default heartbeat interval in milliseconds. */
  DEFAULT_INTERVAL_MS: 15_000,
  /** SSE comment line flushed to the client on each tick. */
  COMMENT_LINE: ": keepalive\n\n",
} as const;

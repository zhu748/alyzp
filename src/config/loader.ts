/**
 * YAML config loader with env-var overrides and validation.
 * @see .omo/plans/zcode-proxy.md Task 2
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import type { ProxyConfig, ProviderEndpoints, ProxyIdentity, RetryConfig, RoutingRule, ModelMapping, ResponsesThinkingConfig } from "./types.js";

/** Environment variable keys that override YAML values. */
const ENV = {
  PORT: "ZCODE_PROXY_PORT",
  PROXY_API_KEY: "ZCODE_PROXY_API_KEY",
  PROVIDER: "ZCODE_PROVIDER",
  API_KEY: "ZCODE_API_KEY",
  AUTH_MODE: "ZCODE_AUTH_MODE",
  APP_VERSION: "ZCODE_APP_VERSION",
  SOURCE_TITLE: "ZCODE_SOURCE_TITLE",
  REFERER_ORIGIN: "ZCODE_REFERER_ORIGIN",
  RETRY_MAX: "ZCODE_RETRY_MAX",
  RETRY_INITIAL_DELAY_MS: "ZCODE_RETRY_INITIAL_DELAY_MS",
  RETRY_MAX_DELAY_MS: "ZCODE_RETRY_MAX_DELAY_MS",
  RETRY_BACKOFF_FACTOR: "ZCODE_RETRY_BACKOFF_FACTOR",
  RETRY_STATUSES: "ZCODE_RETRY_STATUSES",
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: "ZCODE_RETRY_CREDENTIAL_SWITCH_THRESHOLD",
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: "ZCODE_RETRY_EMPTY_STREAM_SWITCH_THRESHOLD",
  UPSTREAM_TIMEOUT_MS: "ZCODE_UPSTREAM_TIMEOUT_MS",
} as const;

const DEFAULTS = {
  PORT: 8080,
  HOST: "0.0.0.0",
  UPSTREAM_TIMEOUT_MS: 300_000,
  PROVIDER: "zai" as const,
  PLAN: "coding-plan" as const,
  DEFAULT_MODEL: "glm-4.6",
  LOG_LEVEL: "info" as const,
  ZAI_ANTHROPIC_BASE: "https://api.z.ai/api/anthropic",
  ZAI_OPENAI_BASE: "https://api.z.ai/api/coding/paas/v4",
  BIGMODEL_ANTHROPIC_BASE: "https://open.bigmodel.cn/api/anthropic",
  BIGMODEL_OPENAI_BASE: "https://open.bigmodel.cn/api/coding/paas/v4",
  APP_VERSION: "3.1.5",
  SOURCE_TITLE: "cli",
  REFERER_ORIGIN: "https://zcode.z.ai",
  RETRY_MAX_RETRIES: 3,
  RETRY_INITIAL_DELAY_MS: 1000,
  RETRY_MAX_DELAY_MS: 8000,
  RETRY_BACKOFF_FACTOR: 2,
  RETRY_STATUSES: [529],
  RETRY_CREDENTIAL_SWITCH_THRESHOLD: 5,
  RETRY_EMPTY_STREAM_SWITCH_THRESHOLD: 3,
};

/** Printable-ASCII gate copied from the ZCode bundle's `rYn` helper. */
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

/**
 * Load and validate proxy configuration from a YAML file, applying env overrides.
 * @throws Error if file not found or required fields are invalid.
 */
export function loadConfig(path: string): ProxyConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw) ?? {};

  // --- server ---
  const port = resolvePort(process.env[ENV.PORT] ?? parsed?.server?.port);
  const host = typeof parsed?.server?.host === "string" ? parsed.server.host : DEFAULTS.HOST;
  const upstreamTimeoutMs = resolveNonNegativeInt(
    process.env[ENV.UPSTREAM_TIMEOUT_MS] ?? parsed?.server?.upstreamTimeoutMs,
    DEFAULTS.UPSTREAM_TIMEOUT_MS,
  );

  // --- auth ---
  const proxyApiKey = process.env[ENV.PROXY_API_KEY] ?? parsed?.auth?.proxyApiKey;
  // ZCODE_AUTH_MODE env var overrides YAML. Lets Render users pick between
  // apikey and oauth modes without editing the bundled config.yaml.
  // Accepted values: "apikey" (default) | "oauth"
  const modeEnv = process.env[ENV.AUTH_MODE]?.toLowerCase().trim();
  const mode: "apikey" | "oauth" =
    modeEnv === "oauth" ? "oauth"
    : modeEnv === "apikey" ? "apikey"
    : (parsed?.auth?.mode === "oauth" ? "oauth" : "apikey");
  const apiKey = process.env[ENV.API_KEY] ?? parsed?.auth?.apiKey;
  const oauthCredentialsPath = parsed?.auth?.oauthCredentialsPath;

  // --- provider ---
  const provider = resolveProvider(process.env[ENV.PROVIDER] ?? parsed?.provider);
  const plan = resolvePlan(parsed?.plan);

  // --- providers ---
  const zai: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.zai?.anthropicBase ?? DEFAULTS.ZAI_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.zai?.openaiBase ?? DEFAULTS.ZAI_OPENAI_BASE,
    credential: parsed?.providers?.zai?.credential,
  };
  const bigmodel: ProviderEndpoints = {
    anthropicBase: parsed?.providers?.bigmodel?.anthropicBase ?? DEFAULTS.BIGMODEL_ANTHROPIC_BASE,
    openaiBase: parsed?.providers?.bigmodel?.openaiBase ?? DEFAULTS.BIGMODEL_OPENAI_BASE,
    credential: parsed?.providers?.bigmodel?.credential,
  };

  // --- models ---
  const defaultModel = typeof parsed?.defaultModel === "string" ? parsed.defaultModel : DEFAULTS.DEFAULT_MODEL;
  const models = Array.isArray(parsed?.models) ? parsed.models : [defaultModel];

  // --- logging ---
  const logLevel = resolveLogLevel(parsed?.logging?.level);

  // --- identity ---
  const identity = resolveIdentity({
    appVersionEnv: process.env[ENV.APP_VERSION],
    appVersionYaml: parsed?.identity?.appVersion,
    sourceTitleEnv: process.env[ENV.SOURCE_TITLE],
    sourceTitleYaml: parsed?.identity?.sourceTitle,
    refererEnv: process.env[ENV.REFERER_ORIGIN],
    refererYaml: parsed?.identity?.refererOrigin,
  });

  // --- retry ---
  const retry = resolveRetry(parsed?.retry);

  // --- routing rules ---
  const routingRules = resolveRoutingRules(parsed?.routingRules);

  // --- model mappings ---
  const modelMappings = resolveModelMappings(parsed?.modelMappings);

  // --- responses thinking override ---
  const responsesThinking = resolveResponsesThinking(parsed?.responsesThinking);

  // vceshi0.0.6+: verbose logging flag. Env var ZCODE_PROXY_VERBOSE_LOGGING=1
  // enables it at startup; YAML `logging.verbose: true` also works. Dashboard
  // can toggle at runtime via PUT /config (the field is hot-swappable).
  const verboseLogging = process.env.ZCODE_PROXY_VERBOSE_LOGGING === "1"
    || (typeof (parsed as any)?.logging === "object" && (parsed as any).logging?.verbose === true);

  // Debug response logging (this version). Env var
  // ZCODE_PROXY_DEBUG_LOGGING=1 enables it at startup; YAML
  // `logging.debug: true` also works. When true, logs the FULL upstream
  // response (status + headers + body preview) for every request — the
  // "调试日志" for diagnosing 529 / empty 200 / captcha 403 / etc.
  const debugLogging = process.env.ZCODE_PROXY_DEBUG_LOGGING === "1"
    || (typeof (parsed as any)?.logging === "object" && (parsed as any).logging?.debug === true);

  // --- CORS allowlist ---
  const corsAllowList = resolveCorsAllowList(process.env.ZCODE_PROXY_CORS_ALLOWLIST);

  // --- Force stream for Anthropic ---
  const forceStreamAnthropic = process.env.ZCODE_PROXY_FORCE_STREAM_ANTHROPIC === "1"
    || parsed?.anthropic?.forceStream === true;

  const config: ProxyConfig = {
    server: { port, host, upstreamTimeoutMs: upstreamTimeoutMs || undefined },
    auth: { proxyApiKey, mode, apiKey, oauthCredentialsPath },
    provider,
    plan,
    providers: { zai, bigmodel },
    defaultModel,
    models,
    forceStreamAnthropic,
    corsAllowList,
    identity,
    logging: { level: logLevel, verbose: verboseLogging, debug: debugLogging },
    retry,
    routingRules,
    modelMappings,
    responsesThinking,
  };

  validate(config);
  return config;
}

/** Resolve port from raw value (YAML or env), defaulting to 8080. */
function resolvePort(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULTS.PORT;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    throw new Error("server.port must be a valid number");
  }
  return n;
}

/** Resolve and validate provider string. */
function resolveProvider(raw: unknown): "zai" | "bigmodel" {
  const v = typeof raw === "string" ? raw : DEFAULTS.PROVIDER;
  if (v !== "zai" && v !== "bigmodel") {
    throw new Error(`Invalid provider "${v}": must be "zai" or "bigmodel"`);
  }
  return v;
}

function resolvePlan(raw: unknown): "coding-plan" | "start-plan" {
  if (raw === "start-plan") return "start-plan";
  return DEFAULTS.PLAN;
}

/** Resolve log level with fallback. */
function resolveLogLevel(raw: unknown): "debug" | "info" | "warn" | "error" {
  const levels = ["debug", "info", "warn", "error"] as const;
  if (typeof raw === "string" && levels.includes(raw as any)) {
    return raw as any;
  }
  return DEFAULTS.LOG_LEVEL;
}

interface IdentityInputs {
  appVersionEnv?: string;
  appVersionYaml?: string;
  sourceTitleEnv?: string;
  sourceTitleYaml?: string;
  refererEnv?: string;
  refererYaml?: string;
}

/** Resolve identity fields (env > YAML > default). Non-ASCII `appVersion` silently falls back to the default. */
function resolveIdentity(inp: IdentityInputs): ProxyIdentity {
  const rawVersion = (inp.appVersionEnv ?? inp.appVersionYaml ?? DEFAULTS.APP_VERSION).trim();
  const appVersion = ASCII_PRINTABLE.test(rawVersion) ? rawVersion : DEFAULTS.APP_VERSION;

  const sourceTitle = (inp.sourceTitleEnv ?? inp.sourceTitleYaml ?? DEFAULTS.SOURCE_TITLE).trim()
    || DEFAULTS.SOURCE_TITLE;

  const refererOrigin = (inp.refererEnv ?? inp.refererYaml ?? DEFAULTS.REFERER_ORIGIN).trim()
    || DEFAULTS.REFERER_ORIGIN;

  return { appVersion, sourceTitle, refererOrigin };
}

/** Resolve retry configuration with env-var overrides and defaults. */
function resolveRetry(raw?: unknown): RetryConfig {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};

  const maxRetries = resolveNonNegativeInt(
    process.env[ENV.RETRY_MAX] ?? r.maxRetries,
    DEFAULTS.RETRY_MAX_RETRIES,
  );
  const initialDelayMs = resolvePositiveInt(
    process.env[ENV.RETRY_INITIAL_DELAY_MS] ?? r.initialDelayMs,
    DEFAULTS.RETRY_INITIAL_DELAY_MS,
  );
  const maxDelayMs = resolvePositiveInt(
    process.env[ENV.RETRY_MAX_DELAY_MS] ?? r.maxDelayMs,
    DEFAULTS.RETRY_MAX_DELAY_MS,
  );
  const backoffFactor = resolvePositiveFloat(
    process.env[ENV.RETRY_BACKOFF_FACTOR] ?? r.backoffFactor,
    DEFAULTS.RETRY_BACKOFF_FACTOR,
  );

  // retryableStatuses: env var is comma-separated (e.g. "529,429,503"), YAML is array
  let retryableStatuses = DEFAULTS.RETRY_STATUSES;
  const envStatuses = process.env[ENV.RETRY_STATUSES];
  if (typeof envStatuses === "string" && envStatuses.trim().length > 0) {
    retryableStatuses = envStatuses.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  } else if (Array.isArray(r.retryableStatuses) && r.retryableStatuses.length > 0) {
    retryableStatuses = r.retryableStatuses.map((s: unknown) => {
      const n = typeof s === "number" ? s : parseInt(String(s), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }).filter((n: number | null): n is number => n !== null);
  }

  const credentialSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_CREDENTIAL_SWITCH_THRESHOLD] ?? r.credentialSwitchThreshold,
    DEFAULTS.RETRY_CREDENTIAL_SWITCH_THRESHOLD,
  );

  // emptyStreamSwitchThreshold (vceshi0.0.4+): number of consecutive
  // empty-stream 529s before forcing a credential switch. Defaults to 3.
  // Set to 0 to disable (fall back to the generic credentialSwitchThreshold).
  const emptyStreamSwitchThreshold = resolveNonNegativeInt(
    process.env[ENV.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD] ?? r.emptyStreamSwitchThreshold,
    DEFAULTS.RETRY_EMPTY_STREAM_SWITCH_THRESHOLD,
  );

  return { maxRetries, initialDelayMs, maxDelayMs, backoffFactor, retryableStatuses, credentialSwitchThreshold, emptyStreamSwitchThreshold };
}

/** Resolve a non-negative integer from a raw value, falling back to default. */
function resolveNonNegativeInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/** Resolve a positive integer (> 0) from a raw value, falling back to default. */
function resolvePositiveInt(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/** Resolve a positive float from a raw value, falling back to default. */
function resolvePositiveFloat(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve routing rules from YAML, validating each rule's shape. */
function resolveRoutingRules(raw: unknown): RoutingRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: RoutingRule[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.pattern !== "string" || r.pattern.trim() === "") continue;
    if (r.provider !== "zai" && r.provider !== "bigmodel") continue;
    rules.push({
      pattern: r.pattern.trim(),
      provider: r.provider,
      endpoint: typeof r.endpoint === "string" && r.endpoint.trim() ? r.endpoint.trim() : undefined,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined,
    });
  }
  return rules;
}

/** Resolve model mappings from YAML. `from` is lowercased for case-insensitive lookup. */
function resolveModelMappings(raw: unknown): ModelMapping[] {
  if (!Array.isArray(raw)) return [];
  const mappings: ModelMapping[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    if (typeof m.from !== "string" || m.from.trim() === "") continue;
    if (typeof m.to !== "string" || m.to.trim() === "") continue;
    mappings.push({
      from: m.from.trim().toLowerCase(),
      to: m.to.trim(),
      note: typeof m.note === "string" && m.note.trim() ? m.note.trim() : undefined,
    });
  }
  return mappings;
}

/**
 * Resolve responses-thinking override from YAML.
 *
 * Accepts either:
 *   - `{ models: ["glm-5.2", ...] }`  (canonical shape)
 *   - `["glm-5.2", ...]`               (shorthand array of model ids)
 *
 * Model ids are trimmed but kept as-is (case preserved for display;
 * matching at request time is case-insensitive). Duplicates are dropped.
 * Always returns a non-undefined object so downstream code can do
 * `config.responsesThinking?.models` without null-checking.
 */
function resolveResponsesThinking(raw: unknown): ResponsesThinkingConfig {
  const arr: unknown = Array.isArray(raw)
    ? raw
    : (typeof raw === "object" && raw !== null)
      ? (raw as Record<string, unknown>).models
      : undefined;
  if (!Array.isArray(arr)) return { models: [] };
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(id);
  }
  return { models };
}

/** Cross-field validation after all fields are resolved. */
function validate(config: ProxyConfig): void {
  if (config.server.port < 1 || config.server.port > 65535) {
    throw new Error(`server.port ${config.server.port} is out of range (1-65535)`);
  }

  if (config.auth.mode === "apikey") {
    const hasGlobal = typeof config.auth.apiKey === "string" && config.auth.apiKey.length > 0;
    const hasProvider = typeof config.providers[config.provider].credential === "string";
    if (!hasGlobal && !hasProvider) {
      throw new Error(
        `auth.apiKey is required when auth.mode is "apikey" (or set providers.${config.provider}.credential)`,
      );
    }
  }

  if (!config.models.includes(config.defaultModel)) {
    // defaultModel not in the models list — add it automatically
    config.models.push(config.defaultModel);
  }
}

/** Parse a comma-separated CORS allowlist from the env var. */
function resolveCorsAllowList(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

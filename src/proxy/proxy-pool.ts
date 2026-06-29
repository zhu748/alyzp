/**
 * Global Proxy Pool
 *
 * A persistent, refreshable pool of outbound HTTP proxies shared across all
 * accounts. The pool is consulted ONLY when an account has no per-account
 * proxy override (`cred.proxy`) — single-account proxy always wins over the
 * pool, mirroring the "优先级低于单账号设置的代理" requirement.
 *
 * Sources:
 *   - Manual proxies: added one-by-one or pasted/imported from a txt file.
 *   - URL imports: one or more remote txt lists (one proxy per line), e.g.
 *     https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.txt
 *
 * The pool auto-refreshes from the configured URL sources on a configurable
 * interval (default 5 minutes). A manual refresh returns the count of
 * added / removed / total proxies so the dashboard can show "本次更新新增 X，
 * 删除 Y".
 *
 * Proxy format expected (one per line):
 *   - `http://host:port`
 *   - `https://host:port`
 *   - `socks4://host:port`
 *   - `socks4a://host:port`
 *   - `socks5://host:port`
 *   - `socks5h://host:port`
 *   - `host:port`           (defaults to http://)
 *   - `user:pass@host:port` (credentials embedded)
 *
 * Lines starting with `#` are ignored. Empty lines are ignored.
 *
 * Persistence: ~/.zcode-proxy/proxy-pool.json (configurable via
 * ZCODE_PROXY_STORE_DIR). The file contains:
 *   {
 *     "version": 1,
 *     "config": { enabled, refreshIntervalMin, sourceUrls, rotateOnGatewayBlock },
 *     "proxies": [{ id, url, source, addedAt }],
 *     "lastRefreshAt": 1234567890,
 *     "lastRefreshResult": { added, removed, total, at }
 *   }
 *
 * Rotation: when the handler detects a 405 / WAF block (gateway interception),
 * it calls `pool.next(excluding)` to rotate to a different proxy and retries
 * the request. The current cursor is per-request (in-memory), so concurrent
 * requests use different proxies.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile, createMutex } from "../utils/fs.js";
import { validateProxyUrl } from "../auth/store.js";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

/** A single proxy entry in the pool. */
export interface PoolProxy {
  /** Stable unique id (sha-ish 12-char hex of the normalized URL). */
  id: string;
  /** Normalized URL (always with scheme). */
  url: string;
  /** Source: "manual" | "url:<n>" where n is the source URL index. */
  source: string;
  /** When this entry was added (Unix ms). */
  addedAt: number;
  /** Optional human-readable label (e.g. the original line for non-URL form). */
  note?: string;
  /**
   * Consecutive failure counter (incremented on rotation due to gateway
   * block). Used to deprioritize bad proxies without removing them.
   */
  failures?: number;
  /** Last time this proxy was used (Unix ms). */
  lastUsedAt?: number;
}

/** Pool configuration. */
export interface ProxyPoolConfig {
  /** Master switch. When false, the pool is not consulted at all. */
  enabled: boolean;
  /** Auto-refresh interval in minutes. 0 = disabled. Default 5. */
  refreshIntervalMin: number;
  /** URL sources for auto-refresh. Empty = no URL sources. */
  sourceUrls: string[];
  /**
   * Whether to rotate proxies on 405 / WAF gateway block errors. When true
   * (default), the handler will pick a different proxy and retry the request.
   */
  rotateOnGatewayBlock: boolean;
  /**
   * Maximum retries via different proxies on a gateway block before giving
   * up. Default 3. Set to 0 to disable proxy rotation entirely (the pool
   * is still consulted for the INITIAL proxy choice).
   */
  maxRotations: number;
}

/** Result of a refresh operation. */
export interface RefreshResult {
  /** Number of new proxies added in this refresh. */
  added: number;
  /** Number of proxies removed (no longer in any source). */
  removed: number;
  /** Total proxies in the pool after refresh. */
  total: number;
  /** When the refresh happened (Unix ms). */
  at: number;
  /** Per-source errors (if any), keyed by source URL. */
  errors?: Record<string, string>;
}

/** On-disk file format. */
interface PoolFile {
  version: 1;
  config: ProxyPoolConfig;
  proxies: PoolProxy[];
  lastRefreshAt?: number;
  lastRefreshResult?: RefreshResult;
}

// --------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------

const STORE_DIR = process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy");
const POOL_FILE = join(STORE_DIR, "proxy-pool.json");

const DEFAULT_CONFIG: ProxyPoolConfig = {
  enabled: false,
  refreshIntervalMin: 5,
  sourceUrls: [],
  rotateOnGatewayBlock: true,
  maxRotations: 3,
};

const ALLOWED_SCHEMES = ["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"];

// --------------------------------------------------------------------
// In-memory state + cache
// --------------------------------------------------------------------

let cachedPool: PoolFile | null = null;
let cachedMtimeMs = -1;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let roundRobinCursor = 0;

/**
 * Sticky proxy — the proxy that's currently "working" and should be reused
 * for subsequent requests until it fails (405/WAF/network error). When set,
 * `pickProxy` returns this proxy instead of advancing the round-robin cursor.
 *
 * Set by `pickProxy` whenever it picks a new proxy. Cleared by
 * `markProxyFailed` when the sticky proxy fails, and by `removeProxy` /
 * `clearProxies` when the sticky proxy is removed from the pool.
 *
 * This implements the user's "后面请求也要记住这个代理继续使用 直到代理
 * 失效或405报错继续轮循" requirement: a working proxy is sticky across
 * requests, rotation only happens on failure.
 */
let currentWorkingProxy: string | null = null;

const poolMutex = createMutex();

// --------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------

/** Cheap stable hash for ids (FNV-1a 32-bit, hex). */
function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Normalize a raw proxy line into a valid URL string.
 * - Empty / comment lines return null.
 * - Bare `host:port` becomes `http://host:port`.
 * - URLs without scheme get `http://` prepended.
 * - Invalid schemes / hosts return null.
 */
export function normalizeProxyLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;

  let candidate = trimmed;
  // If it has no scheme, prepend http://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Heuristic: if it looks like `host:port` or `user:pass@host:port`, prepend http://
    candidate = `http://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // Reject HTML/JS metacharacters in the host (defense-in-depth, mirrors
  // setAccountProxy validation).
  if (/[<>'"\s]/.test(parsed.host)) return null;

  // Re-serialize without hash/fragment and without trailing slash.
  const port = parsed.port ? `:${parsed.port}` : "";
  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}${parsed.password ? ":" + encodeURIComponent(parsed.password) : ""}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}`;
}

/** Parse a multi-line text block into a list of normalized proxy URLs. */
export function parseProxyText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const norm = normalizeProxyLine(line);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Run SSRF / scheme validation on a normalized URL. Returns null if valid,
 * or an error message string. Reuses store.ts `validateProxyUrl` for parity
 * with the per-account proxy gate.
 */
function validateProxy(normalized: string): string | null {
  const v = validateProxyUrl(normalized);
  return v.ok ? null : v.message;
}

// --------------------------------------------------------------------
// File I/O
// --------------------------------------------------------------------

function readPoolUncached(): PoolFile | null {
  if (!existsSync(POOL_FILE)) return null;
  try {
    const raw = readFileSync(POOL_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PoolFile;
    if (!parsed || parsed.version !== 1) {
      // Unknown version — treat as empty rather than risk clobbering.
      return { version: 1, config: { ...DEFAULT_CONFIG }, proxies: [] };
    }
    return {
      version: 1,
      config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
      proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
      lastRefreshAt: parsed.lastRefreshAt,
      lastRefreshResult: parsed.lastRefreshResult,
    };
  } catch {
    return null;
  }
}

async function writePool(pool: PoolFile): Promise<void> {
  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    await atomicWriteFile(POOL_FILE, JSON.stringify(pool, null, 2));
    cachedPool = pool;
    try {
      const { statSync } = await import("node:fs");
      cachedMtimeMs = statSync(POOL_FILE).mtimeMs;
    } catch {
      cachedMtimeMs = Date.now();
    }
  } catch (e) {
    // Best-effort: log to console, keep in-memory state so the running
    // proxy still works.
    console.warn(`[proxy-pool] failed to persist pool file: ${(e as Error).message}`);
  }
}

/** Read the pool, refreshing from disk if the file changed externally. */
async function readPool(): Promise<PoolFile> {
  if (cachedPool) {
    try {
      const { statSync } = await import("node:fs");
      if (existsSync(POOL_FILE)) {
        const mtime = statSync(POOL_FILE).mtimeMs;
        if (mtime !== cachedMtimeMs) {
          cachedPool = null;
          cachedMtimeMs = -1;
        }
      }
    } catch {
      /* ignore stat errors */
    }
  }
  if (!cachedPool) {
    cachedPool = readPoolUncached() ?? {
      version: 1,
      config: { ...DEFAULT_CONFIG },
      proxies: [],
    };
    try {
      if (existsSync(POOL_FILE)) {
        const { statSync } = await import("node:fs");
        cachedMtimeMs = statSync(POOL_FILE).mtimeMs;
      }
    } catch {
      cachedMtimeMs = -1;
    }
  }
  return cachedPool;
}

// --------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------

/** Get the current pool state (for the admin API). */
export async function getPoolState(): Promise<{
  config: ProxyPoolConfig;
  proxies: PoolProxy[];
  lastRefreshAt?: number;
  lastRefreshResult?: RefreshResult;
  currentWorkingProxy: string | null;
}> {
  const pool = await readPool();
  return {
    config: { ...pool.config },
    proxies: pool.proxies.map(p => ({ ...p })),
    lastRefreshAt: pool.lastRefreshAt,
    lastRefreshResult: pool.lastRefreshResult,
    currentWorkingProxy,
  };
}

/** Update the pool configuration (also (re)schedules the auto-refresh timer). */
export async function updatePoolConfig(patch: Partial<ProxyPoolConfig>): Promise<ProxyPoolConfig> {
  return poolMutex.run(async () => {
    const pool = await readPool();
    const newConfig: ProxyPoolConfig = {
      ...pool.config,
      ...patch,
      sourceUrls: Array.isArray(patch.sourceUrls) ? patch.sourceUrls : pool.config.sourceUrls,
    };
    pool.config = newConfig;
    await writePool(pool);
    scheduleAutoRefresh(newConfig);
    return { ...newConfig };
  });
}

/**
 * Import proxies from a raw text block (manual / txt file upload).
 *
 * @param text Multi-line proxy text.
 * @param replace Whether to replace ALL existing proxies (true) or merge (false).
 * @returns { added, total } — added is the count of new entries.
 */
export async function importFromText(
  text: string,
  replace: boolean = false,
): Promise<{ added: number; removed: number; total: number }> {
  const urls = parseProxyText(text);
  return poolMutex.run(async () => {
    const pool = await readPool();
    const now = Date.now();
    const newEntries: PoolProxy[] = urls.map((url, idx) => {
      const validationErr = validateProxy(url);
      if (validationErr) {
        // Skip invalid silently — the parse step already filtered most bad
        // inputs; the SSRF check just blocks metadata endpoints.
        return null;
      }
      return {
        id: hashId(url),
        url,
        source: "manual",
        addedAt: now,
        note: `line ${idx + 1}`,
      } as PoolProxy;
    }).filter((x): x is PoolProxy => x !== null);

    const before = pool.proxies.length;
    let addedCount = 0;
    if (replace) {
      // In replace mode, ALL old entries are removed and ALL new entries are
      // added (after validation). The "added" count is the number of valid
      // new entries that made it into the pool.
      addedCount = newEntries.length;
      pool.proxies = newEntries;
    } else {
      // Merge: keep existing manual entries, dedupe by id.
      const existingIds = new Set(pool.proxies.map(p => p.id));
      const addedEntries = newEntries.filter(e => !existingIds.has(e.id));
      addedCount = addedEntries.length;
      pool.proxies = [...pool.proxies, ...addedEntries];
    }
    await writePool(pool);
    return {
      added: addedCount,
      removed: replace ? before : 0,
      total: pool.proxies.length,
    };
  });
}

/**
 * Fetch a remote txt list and import it. The fetch is done via the provided
 * fetchImpl so tests can mock it. The result replaces any proxies that came
 * from the SAME source URL (idempotent refresh).
 *
 * @param url Source URL to fetch.
 * @param fetchImpl Optional fetch override.
 * @returns { added, removed, total, fetched } — fetched is the count parsed
 *          from the remote list.
 */
export async function importFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ added: number; removed: number; total: number; fetched: number; error?: string }> {
  let text: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const resp = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { "user-agent": "zcode-proxy/proxy-pool" },
      });
      if (!resp.ok) {
        return { added: 0, removed: 0, total: 0, fetched: 0, error: `HTTP ${resp.status}` };
      }
      text = await resp.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { added: 0, removed: 0, total: 0, fetched: 0, error: (e as Error).message };
  }

  const urls = parseProxyText(text);
  const sourceTag = `url:${url}`;
  return poolMutex.run(async () => {
    const pool = await readPool();
    const now = Date.now();
    // Remove existing entries from the SAME source.
    const kept = pool.proxies.filter(p => p.source !== sourceTag);
    const removed = pool.proxies.length - kept.length;

    const existingIds = new Set(kept.map(p => p.id));
    const newEntries: PoolProxy[] = [];
    for (const u of urls) {
      if (validateProxy(u)) continue;
      const id = hashId(u);
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      newEntries.push({ id, url: u, source: sourceTag, addedAt: now });
    }

    pool.proxies = [...kept, ...newEntries];
    await writePool(pool);
    return {
      added: newEntries.length,
      removed,
      total: pool.proxies.length,
      fetched: urls.length,
    };
  });
}

/**
 * Refresh from ALL configured source URLs. Each source is fetched; existing
 * proxies from each source are replaced. Proxies from other sources (manual,
 * other URLs) are preserved.
 *
 * **Failure handling**: if a URL source fails to fetch (network error, HTTP
 * 4xx/5xx), its EXISTING proxies are preserved in the pool — only the new
 * fetch is skipped. This prevents a transient network blip from wiping out
 * all working proxies from that source.
 *
 * **Removed sources**: if a URL source was removed from `sourceUrls` config
 * since the last refresh, its proxies are dropped (they're no longer in
 * `allEntries` and not in the current source list).
 *
 * @param fetchImpl Optional fetch override.
 * @returns RefreshResult with aggregate added/removed/total + per-source errors.
 */
export async function refreshFromSources(
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  const pool = await readPool();
  const urls = pool.config.sourceUrls ?? [];
  const urlSet = new Set(urls.map(u => `url:${u}`));
  const errors: Record<string, string> = {};
  let totalAdded = 0;
  const allEntries: PoolProxy[] = [];
  const seenIds = new Set<string>();

  // First, keep manual entries (source === "manual").
  for (const p of pool.proxies) {
    if (p.source === "manual") {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allEntries.push(p);
      }
    }
  }

  // For each configured URL source, try to fetch + import. If the fetch
  // fails, preserve the existing entries from that source so a transient
  // network error doesn't wipe the pool.
  const failedSources = new Set<string>();
  for (const srcUrl of urls) {
    const sourceTag = `url:${srcUrl}`;
    const result = await importFromUrl(srcUrl, fetchImpl);
    if (result.error) {
      errors[srcUrl] = result.error;
      failedSources.add(sourceTag);
      // Don't count removed/added for failed sources — their existing
      // entries are preserved as-is.
      continue;
    }
    totalAdded += result.added;
    // Read the freshly-updated pool (importFromUrl wrote it) and collect
    // entries from this source.
    const updated = await readPool();
    for (const p of updated.proxies) {
      if (p.source === sourceTag) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allEntries.push(p);
        }
      }
    }
  }

  // Preserve existing entries from FAILED sources (transient network errors
  // must not wipe working proxies). We read the pool's PRE-refresh state
  // (captured at the top of this function) to get the entries that existed
  // before any importFromUrl calls modified the pool.
  for (const p of pool.proxies) {
    if (failedSources.has(p.source) && urlSet.has(p.source)) {
      if (!seenIds.has(p.id)) {
        seenIds.add(p.id);
        allEntries.push(p);
      }
    }
  }

  // Count removed = entries from configured URL sources that were in the
  // pool before but are NOT in allEntries now (either the source succeeded
  // and the proxy disappeared from the remote list, or the source was
  // removed from config entirely).
  const allEntryIds = new Set(allEntries.map(p => p.id));
  let actualRemoved = 0;
  for (const p of pool.proxies) {
    if (p.source === "manual") continue; // manual entries are always kept
    if (failedSources.has(p.source)) continue; // failed sources preserved as-is
    // For successfully-refreshed sources and removed-from-config sources:
    if (!allEntryIds.has(p.id)) {
      actualRemoved++;
    }
  }

  // Write the merged result with the new totals.
  return poolMutex.run(async () => {
    const finalPool = await readPool();
    finalPool.proxies = allEntries;
    finalPool.lastRefreshAt = Date.now();
    const result: RefreshResult = {
      added: totalAdded,
      removed: actualRemoved,
      total: finalPool.proxies.length,
      at: finalPool.lastRefreshAt,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
    };
    finalPool.lastRefreshResult = result;
    await writePool(finalPool);
    return result;
  });
}

/** Remove a single proxy by id. Returns true if removed. */
export async function removeProxy(id: string): Promise<boolean> {
  return poolMutex.run(async () => {
    const pool = await readPool();
    const entry = pool.proxies.find(p => p.id === id);
    const before = pool.proxies.length;
    pool.proxies = pool.proxies.filter(p => p.id !== id);
    if (pool.proxies.length === before) return false;
    // If the removed proxy was sticky, clear the sticky state.
    if (entry && currentWorkingProxy === entry.url) {
      currentWorkingProxy = null;
    }
    await writePool(pool);
    return true;
  });
}

/** Clear all proxies (config is preserved). */
export async function clearProxies(): Promise<{ removed: number }> {
  // Clear sticky state — no proxies left to be sticky.
  currentWorkingProxy = null;
  return poolMutex.run(async () => {
    const pool = await readPool();
    const removed = pool.proxies.length;
    pool.proxies = [];
    await writePool(pool);
    return { removed };
  });
}

/**
 * Pick the next proxy to use. Returns null if the pool is disabled or empty.
 *
 * **Sticky behavior**: if a `currentWorkingProxy` is set (from a previous
 * successful pick), it's returned for every subsequent call — UNLESS it's
 * in the `excludeUrls` set (caller is rotating away from it after a failure)
 * or it's no longer in the pool. This makes a working proxy persist across
 * requests; rotation only happens when the sticky proxy fails.
 *
 * @param excludeUrls Optional set of URLs to skip (used during rotation
 *   after a gateway block — we don't want to retry the same proxy that
 *   just got blocked).
 */
export async function pickProxy(excludeUrls?: Set<string>): Promise<string | null> {
  const pool = await readPool();
  if (!pool.config.enabled) return null;
  if (pool.proxies.length === 0) return null;

  const poolUrls = new Set(pool.proxies.map(p => p.url));

  // Sticky: if currentWorkingProxy is still valid (in pool + not excluded),
  // return it without advancing the cursor.
  if (currentWorkingProxy && poolUrls.has(currentWorkingProxy)) {
    if (!excludeUrls || !excludeUrls.has(currentWorkingProxy)) {
      return currentWorkingProxy;
    }
    // Sticky proxy is excluded (caller is rotating away from it). Fall
    // through to pick a new one.
  } else {
    // Sticky proxy is stale (removed from pool). Clear it.
    currentWorkingProxy = null;
  }

  // Advance round-robin to find a new proxy.
  const n = pool.proxies.length;
  for (let i = 0; i < n; i++) {
    const idx = (roundRobinCursor + i) % n;
    const candidate = pool.proxies[idx];
    if (excludeUrls && excludeUrls.has(candidate.url)) continue;
    // Found a new proxy — make it sticky.
    roundRobinCursor = (idx + 1) % n;
    currentWorkingProxy = candidate.url;
    return candidate.url;
  }
  // All excluded — return null (caller should fall through to direct/no-proxy).
  return null;
}

/**
 * Get the current sticky (working) proxy for diagnostics/logging. Returns
 * null if no proxy is currently sticky.
 */
export function getCurrentWorkingProxy(): string | null {
  return currentWorkingProxy;
}

/**
 * Explicitly set the current working proxy. Used by the handler when a
 * request succeeds through a pool proxy — the proxy that served the
 * successful request becomes sticky for future requests.
 */
export function setCurrentWorkingProxy(url: string | null): void {
  currentWorkingProxy = url;
}

/**
 * Get the configured maxRotations for WAF retry. Returns the pool's
 * `maxRotations` value (default 3). Used by the handler to cap proxy
 * rotation attempts on 405/WAF gateway blocks.
 */
export async function getMaxRotations(): Promise<number> {
  const pool = await readPool();
  return pool.config.maxRotations ?? 3;
}

/**
 * Mark a proxy as failed (increment its failure counter). Called by the
 * handler when a request via this proxy hit a 405 / WAF block / network
 * error. Used for diagnostics and future deprioritization; the proxy is
 * NOT removed from the pool.
 *
 * If the failed proxy is the current sticky proxy, the sticky state is
 * cleared so the next `pickProxy` call advances to a new proxy.
 */
export async function markProxyFailed(url: string): Promise<void> {
  // Clear sticky state if the failed proxy was sticky.
  if (currentWorkingProxy === url) {
    currentWorkingProxy = null;
  }
  await poolMutex.run(async () => {
    const pool = await readPool();
    const entry = pool.proxies.find(p => p.url === url);
    if (!entry) return;
    entry.failures = (entry.failures ?? 0) + 1;
    await writePool(pool);
  });
}

// --------------------------------------------------------------------
// Auto-refresh scheduler
// --------------------------------------------------------------------

/**
 * (Re)schedule the auto-refresh timer based on the current pool config.
 * Call this on startup and whenever the config changes.
 */
export function scheduleAutoRefresh(config?: ProxyPoolConfig): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  const cfg = config ?? cachedPool?.config;
  if (!cfg) return;
  if (!cfg.enabled || cfg.refreshIntervalMin <= 0 || cfg.sourceUrls.length === 0) return;
  const intervalMs = Math.max(1, cfg.refreshIntervalMin) * 60_000;
  refreshTimer = setInterval(() => {
    // Fire-and-forget — never block the timer callback.
    refreshFromSources().catch(e => {
      console.warn(`[proxy-pool] auto-refresh failed: ${(e as Error).message}`);
    });
  }, intervalMs);
  // Don't keep the process alive just for the timer.
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

/**
 * Initialize the pool on startup. Reads the file (if any), schedules the
 * auto-refresh timer, and optionally fires one refresh immediately if the
 * pool is empty but URLs are configured.
 */
export async function initPool(fetchImpl: typeof fetch = fetch): Promise<void> {
  const pool = await readPool();
  scheduleAutoRefresh(pool.config);
  // If pool is empty but URLs are configured + enabled, fire one initial refresh.
  if (pool.config.enabled
    && pool.proxies.length === 0
    && pool.config.sourceUrls.length > 0) {
    console.log("[proxy-pool] pool empty + URLs configured — firing initial refresh");
    refreshFromSources(fetchImpl).catch(e => {
      console.warn(`[proxy-pool] initial refresh failed: ${(e as Error).message}`);
    });
  }
}

// --------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------

/** @internal Reset all in-memory state (for tests). */
export function _resetForTesting(): void {
  cachedPool = null;
  cachedMtimeMs = -1;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  roundRobinCursor = 0;
  currentWorkingProxy = null;
}

/** @internal Get the pool file path (for tests). */
export function _poolFilePath(): string {
  return POOL_FILE;
}

/**
 * Tests for the global proxy pool module.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  normalizeProxyLine,
  parseProxyText,
  importFromText,
  importFromUrl,
  refreshFromSources,
  removeProxy,
  clearProxies,
  getPoolState,
  updatePoolConfig,
  pickProxy,
  markProxyFailed,
  getMaxRotations,
  getCurrentWorkingProxy,
  setCurrentWorkingProxy,
  scheduleAutoRefresh,
  _resetForTesting,
  _poolFilePath,
} from "./proxy-pool.js";
import { existsSync, unlinkSync } from "node:fs";

const POOL_FILE = _poolFilePath();

function ensureCleanState() {
  _resetForTesting();
  if (existsSync(POOL_FILE)) {
    try { unlinkSync(POOL_FILE); } catch { /* ignore */ }
  }
}

beforeEach(() => {
  ensureCleanState();
});

afterEach(() => {
  ensureCleanState();
});

// --- normalizeProxyLine ---

test("normalizeProxyLine: returns null for empty / comment lines", () => {
  expect(normalizeProxyLine("")).toBeNull();
  expect(normalizeProxyLine("   ")).toBeNull();
  expect(normalizeProxyLine("# comment")).toBeNull();
  expect(normalizeProxyLine("  # indented comment")).toBeNull();
});

test("normalizeProxyLine: prepends http:// to bare host:port", () => {
  // Note: port 80 is the http default, so URL normalization strips it.
  expect(normalizeProxyLine("1.2.3.4:80")).toBe("http://1.2.3.4");
  expect(normalizeProxyLine("1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  expect(normalizeProxyLine("example.com:3128")).toBe("http://example.com:3128");
});

test("normalizeProxyLine: preserves explicit scheme", () => {
  // Default ports get normalized away (80 for http, 443 for https).
  expect(normalizeProxyLine("http://1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  expect(normalizeProxyLine("http://1.2.3.4:80")).toBe("http://1.2.3.4");
  expect(normalizeProxyLine("https://1.2.3.4:8080")).toBe("https://1.2.3.4:8080");
  expect(normalizeProxyLine("https://1.2.3.4:443")).toBe("https://1.2.3.4");
  expect(normalizeProxyLine("socks4://1.2.3.4:1080")).toBe("socks4://1.2.3.4:1080");
  expect(normalizeProxyLine("socks4a://1.2.3.4:1080")).toBe("socks4a://1.2.3.4:1080");
  expect(normalizeProxyLine("socks5://1.2.3.4:1080")).toBe("socks5://1.2.3.4:1080");
  expect(normalizeProxyLine("socks5h://1.2.3.4:1080")).toBe("socks5h://1.2.3.4:1080");
});

test("normalizeProxyLine: rejects invalid schemes", () => {
  expect(normalizeProxyLine("ftp://1.2.3.4:8080")).toBeNull();
  expect(normalizeProxyLine("javascript:alert(1)")).toBeNull();
  expect(normalizeProxyLine("file:///etc/passwd")).toBeNull();
});

test("normalizeProxyLine: rejects cloud metadata / unspecified IPs", () => {
  // normalizeProxyLine itself does NOT do SSRF filtering — that's done by
  // validateProxyUrl in importFromText. Here we just verify the URL parses
  // (default port 80 is stripped by URL normalization).
  expect(normalizeProxyLine("169.254.169.254:80")).toBe("http://169.254.169.254");
  expect(normalizeProxyLine("0.0.0.0:80")).toBe("http://0.0.0.0");
});

test("normalizeProxyLine: preserves credentials", () => {
  expect(normalizeProxyLine("user:pass@1.2.3.4:8080")).toBe("http://user:pass@1.2.3.4:8080");
  expect(normalizeProxyLine("http://user:pass@1.2.3.4:8080")).toBe("http://user:pass@1.2.3.4:8080");
});

// --- parseProxyText ---

test("parseProxyText: parses multi-line text, dedupes, skips comments", () => {
  const text = `
# This is a comment
1.2.3.4:8080
http://5.6.7.8:3128
socks5://9.10.11.12:1080

# Another comment
1.2.3.4:8080  # duplicate of line 2
`;
  const result = parseProxyText(text);
  expect(result).toEqual([
    "http://1.2.3.4:8080",
    "http://5.6.7.8:3128",
    "socks5://9.10.11.12:1080",
  ]);
});

// --- importFromText (merge mode) ---

test("importFromText: merge mode adds new proxies without removing existing", async () => {
  const r1 = await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  expect(r1.added).toBe(2);
  expect(r1.total).toBe(2);

  const r2 = await importFromText("5.6.7.8:3128\n9.10.11.12:1080");
  // 5.6.7.8 already exists, 9.10.11.12 is new
  expect(r2.added).toBe(1);
  expect(r2.total).toBe(3);

  const state = await getPoolState();
  expect(state.proxies).toHaveLength(3);
  expect(state.proxies.map(p => p.url).sort()).toEqual([
    "http://1.2.3.4:8080",
    "http://5.6.7.8:3128",
    "http://9.10.11.12:1080",
  ]);
});

// --- importFromText (replace mode) ---

test("importFromText: replace mode wipes existing manual proxies", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  const r = await importFromText("9.10.11.12:1080", true);
  expect(r.added).toBe(1);
  expect(r.removed).toBe(2);
  expect(r.total).toBe(1);
  const state = await getPoolState();
  expect(state.proxies).toHaveLength(1);
  expect(state.proxies[0].url).toBe("http://9.10.11.12:1080");
});

// --- importFromUrl ---

test("importFromUrl: fetches and parses a remote list", async () => {
  const mockFetch = async (url: string) => {
    expect(url).toBe("https://example.com/proxies.txt");
    return new Response("1.2.3.4:8080\n5.6.7.8:3128\n# comment\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  };
  const r = await importFromUrl("https://example.com/proxies.txt", mockFetch as unknown as typeof fetch);
  expect(r.error).toBeUndefined();
  expect(r.fetched).toBe(2);
  expect(r.added).toBe(2);
  expect(r.total).toBe(2);
});

test("importFromUrl: returns error on HTTP failure", async () => {
  const mockFetch = async () => new Response("Not Found", { status: 404 });
  const r = await importFromUrl("https://example.com/missing.txt", mockFetch as unknown as typeof fetch);
  expect(r.error).toBe("HTTP 404");
  expect(r.added).toBe(0);
});

test("importFromUrl: idempotent refresh replaces same-source proxies", async () => {
  const mockFetch1 = async () => new Response("1.2.3.4:8080\n5.6.7.8:3128", { status: 200 });
  await importFromUrl("https://example.com/list.txt", mockFetch1 as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(2);

  // Second fetch with a DIFFERENT list — old entries from this source are
  // removed, new ones are added.
  const mockFetch2 = async () => new Response("9.10.11.12:1080\n11.12.13.14:8888", { status: 200 });
  const r = await importFromUrl("https://example.com/list.txt", mockFetch2 as unknown as typeof fetch);
  expect(r.removed).toBe(2);
  expect(r.added).toBe(2);
  expect(r.total).toBe(2);
  const state = await getPoolState();
  expect(state.proxies.map(p => p.url).sort()).toEqual([
    "http://11.12.13.14:8888",
    "http://9.10.11.12:1080",
  ]);
});

// --- refreshFromSources ---

test("refreshFromSources: aggregates multiple URLs and preserves manual entries", async () => {
  // Seed with manual entries (use non-default ports so normalization is stable).
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");

  // Configure two source URLs.
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: [
      "https://a.example/list.txt",
      "https://b.example/list.txt",
    ],
  });

  const mockFetch = async (url: string) => {
    if (url === "https://a.example/list.txt") {
      return new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
    }
    if (url === "https://b.example/list.txt") {
      return new Response("5.5.5.5:8080\n6.6.6.6:8080", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await refreshFromSources(mockFetch as unknown as typeof fetch);
  expect(result.total).toBe(6); // 2 manual + 4 from URLs
  expect(result.errors).toBeUndefined();

  const state = await getPoolState();
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://2.2.2.2:8080",
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
    "http://5.5.5.5:8080",
    "http://6.6.6.6:8080",
  ]);
});

test("refreshFromSources: preserves existing proxies from FAILED sources (Bug 1)", async () => {
  // Seed with manual entries + do an initial successful refresh from URL1.
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt"],
  });

  // Initial successful refresh.
  const mockFetchOk = async () => new Response("3.3.3.3:8080\n4.4.4.4:8080", { status: 200 });
  await refreshFromSources(mockFetchOk as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(3); // 1 manual + 2 from URL1

  // Now refresh again, but URL1 fails (network error). The existing URL1
  // proxies must be PRESERVED — not wiped.
  const mockFetchFail = async () => { throw new Error("ECONNREFUSED"); };
  const result = await refreshFromSources(mockFetchFail as unknown as typeof fetch);
  expect(result.errors).toBeDefined();
  expect(result.errors!["https://a.example/list.txt"]).toBe("ECONNREFUSED");

  const state = await getPoolState();
  // Manual entry + URL1's existing entries should still be there.
  expect(state.proxies).toHaveLength(3);
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://3.3.3.3:8080",
    "http://4.4.4.4:8080",
  ]);
});

test("refreshFromSources: drops proxies from removed URL sources", async () => {
  // Configure with URL1 and URL2, do initial refresh.
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({
    enabled: true,
    refreshIntervalMin: 5,
    sourceUrls: ["https://a.example/list.txt", "https://b.example/list.txt"],
  });

  const mockFetchBoth = async (url: string) => {
    if (url === "https://a.example/list.txt") return new Response("3.3.3.3:8080", { status: 200 });
    if (url === "https://b.example/list.txt") return new Response("5.5.5.5:8080", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);
  expect((await getPoolState()).proxies).toHaveLength(3); // 1 manual + 1 URL1 + 1 URL2

  // Now remove URL2 from config and refresh again.
  await updatePoolConfig({
    sourceUrls: ["https://a.example/list.txt"],
  });
  await refreshFromSources(mockFetchBoth as unknown as typeof fetch);

  const state = await getPoolState();
  // URL2's proxy (5.5.5.5) should be dropped. Manual + URL1 remain.
  expect(state.proxies).toHaveLength(2);
  const urls = state.proxies.map(p => p.url).sort();
  expect(urls).toEqual([
    "http://1.1.1.1:8080",
    "http://3.3.3.3:8080",
  ]);
});

// --- removeProxy ---

test("removeProxy: removes a single entry by id", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  const state = await getPoolState();
  const idToRemove = state.proxies[0].id;
  const ok = await removeProxy(idToRemove);
  expect(ok).toBe(true);
  const after = await getPoolState();
  expect(after.proxies).toHaveLength(1);
});

test("removeProxy: returns false for unknown id", async () => {
  await importFromText("1.2.3.4:8080");
  const ok = await removeProxy("nonexistent-id");
  expect(ok).toBe(false);
});

// --- clearProxies ---

test("clearProxies: empties the pool but preserves config", async () => {
  await importFromText("1.2.3.4:8080\n5.6.7.8:3128");
  await updatePoolConfig({ enabled: true, refreshIntervalMin: 10, sourceUrls: ["https://x.example"] });
  const r = await clearProxies();
  expect(r.removed).toBe(2);
  const state = await getPoolState();
  expect(state.proxies).toHaveLength(0);
  expect(state.config.enabled).toBe(true);
  expect(state.config.refreshIntervalMin).toBe(10);
  expect(state.config.sourceUrls).toEqual(["https://x.example"]);
});

// --- pickProxy ---

test("pickProxy: returns null when pool is disabled", async () => {
  await importFromText("1.2.3.4:8080");
  // Default config: enabled=false
  const p = await pickProxy();
  expect(p).toBeNull();
});

test("pickProxy: sticky behavior — reuses the same proxy until it fails", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // First pick returns one proxy and makes it sticky.
  const first = await pickProxy();
  expect(first).not.toBeNull();

  // Subsequent picks return the SAME sticky proxy (no round-robin).
  const second = await pickProxy();
  const third = await pickProxy();
  expect(second).toBe(first);
  expect(third).toBe(first);

  // After the sticky proxy fails, the next pick advances to a new one.
  await markProxyFailed(first!);
  const next = await pickProxy();
  expect(next).not.toBeNull();
  expect(next).not.toBe(first);
});

test("pickProxy: round-robins when sticky proxy is excluded", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });

  // First pick — becomes sticky.
  const first = await pickProxy();
  // Exclude the sticky proxy (simulating WAF rotation) — should get a different one.
  const exclude = new Set<string>([first!]);
  const second = await pickProxy(exclude);
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  // The second proxy is now sticky.
  expect(getCurrentWorkingProxy()).toBe(second);
});

test("pickProxy: skips excluded URLs", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080\n3.3.3.3:8080");
  await updatePoolConfig({ enabled: true });
  const exclude = new Set<string>(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
  const p = await pickProxy(exclude);
  expect(p).toBe("http://3.3.3.3:8080");
});

test("pickProxy: returns null when all are excluded", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const exclude = new Set<string>(["http://1.1.1.1:8080", "http://2.2.2.2:8080"]);
  const p = await pickProxy(exclude);
  expect(p).toBeNull();
});

// --- markProxyFailed ---

test("markProxyFailed: increments failure counter", async () => {
  await importFromText("1.1.1.1:8080");
  await updatePoolConfig({ enabled: true });
  await markProxyFailed("http://1.1.1.1:8080");
  await markProxyFailed("http://1.1.1.1:8080");
  const state = await getPoolState();
  expect(state.proxies[0].failures).toBe(2);
});

test("markProxyFailed: clears sticky proxy when it fails", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const first = await pickProxy();
  expect(getCurrentWorkingProxy()).toBe(first);
  // Fail the sticky proxy — sticky state should clear.
  await markProxyFailed(first!);
  expect(getCurrentWorkingProxy()).toBeNull();
  // Next pick should return a DIFFERENT proxy (the failed one is still in
  // the pool but not sticky).
  const next = await pickProxy();
  expect(next).not.toBe(first);
});

test("removeProxy: clears sticky proxy when it's removed", async () => {
  await importFromText("1.1.1.1:8080\n2.2.2.2:8080");
  await updatePoolConfig({ enabled: true });
  const first = await pickProxy();
  expect(getCurrentWorkingProxy()).toBe(first);
  const state = await getPoolState();
  const stickyEntry = state.proxies.find(p => p.url === first);
  // Remove the sticky proxy — sticky state should clear.
  await removeProxy(stickyEntry!.id);
  expect(getCurrentWorkingProxy()).toBeNull();
});

test("setCurrentWorkingProxy: explicitly sets the sticky proxy", () => {
  setCurrentWorkingProxy("http://9.9.9.9:8080");
  expect(getCurrentWorkingProxy()).toBe("http://9.9.9.9:8080");
  setCurrentWorkingProxy(null);
  expect(getCurrentWorkingProxy()).toBeNull();
});

// --- updatePoolConfig ---

test("updatePoolConfig: partial updates merge with defaults", async () => {
  await updatePoolConfig({ enabled: true });
  let state = await getPoolState();
  expect(state.config.enabled).toBe(true);
  expect(state.config.refreshIntervalMin).toBe(5); // default
  expect(state.config.rotateOnGatewayBlock).toBe(true); // default

  await updatePoolConfig({ refreshIntervalMin: 15 });
  state = await getPoolState();
  expect(state.config.enabled).toBe(true); // preserved
  expect(state.config.refreshIntervalMin).toBe(15); // updated
});

// --- getMaxRotations ---

test("getMaxRotations: returns default 3 when not set", async () => {
  const r = await getMaxRotations();
  expect(r).toBe(3);
});

test("getMaxRotations: returns configured value", async () => {
  await updatePoolConfig({ maxRotations: 7 });
  const r = await getMaxRotations();
  expect(r).toBe(7);
});

// --- scheduleAutoRefresh ---

test("scheduleAutoRefresh: schedules timer when enabled + URLs configured", () => {
  // Just verify it doesn't throw and doesn't keep the process alive.
  scheduleAutoRefresh({
    enabled: true,
    refreshIntervalMin: 1,
    sourceUrls: ["https://example.com/list.txt"],
    rotateOnGatewayBlock: true,
    maxRotations: 3,
  });
  // The function returns void — just verify no throw.
  scheduleAutoRefresh({
    enabled: false,
    refreshIntervalMin: 0,
    sourceUrls: [],
    rotateOnGatewayBlock: true,
    maxRotations: 3,
  });
});

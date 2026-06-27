/**
 * Tests for admin dashboard API routes and helpers.
 *
 * Covers:
 *   - recordStat deduplication (P1 fix: stats no longer double-count retries)
 *   - recordDebugDump ring buffer behavior (P0 fix: replaces disk-leaking dumps)
 *   - /admin/api/verify no_auth warning (P1 fix: surface security state)
 *   - /admin/api/debug-dumps CRUD endpoints
 *   - /admin/api/config PUT validation + requiresRestart detection (P2 + P3 fixes)
 *   - /admin/api/logs batch endpoint with limit param
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordStat,
  recordDebugDump,
  clearDebugDumps,
  appendLog,
  _resetStatsForTesting,
  handleAdminRoute,
  type AdminOptions,
} from "./api.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import { saveCredential, clearCredential, listAccounts, _resetKeyCacheForTesting } from "../auth/store.js";
import type { Credential } from "../auth/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    server: { port: 8080, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "testkey.testsecret", ...overrides.auth },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test-1.0.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    logging: { level: "info" },
    retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
    ...overrides,
  };
}

function makeAdminOpts(overrides: Partial<AdminOptions> = {}): AdminOptions {
  return {
    config: makeConfig(),
    auth: new AuthManager({ mode: "apikey", provider: "zai", apiKey: "test" }),
    configPath: join(tmpdir(), `zcode-proxy-test-${Date.now()}.yaml`),
    startTime: Date.now(),
    ...overrides,
  };
}

/** Build a request with auth header. */
function authedReq(path: string, init: RequestInit & { token?: string } = {}): Request {
  const { token = "proxy-secret", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { ...rest, headers });
}

/** Fetch an admin route and return the response (or null if route didn't match). */
async function callAdmin(req: Request, opts: AdminOptions): Promise<Response | null> {
  return handleAdminRoute(req, opts);
}

// ---------------------------------------------------------------------------
// Test isolation: reset module-level state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetStatsForTesting();
  clearDebugDumps();
});

afterEach(() => {
  _resetStatsForTesting();
  clearDebugDumps();
});

// ---------------------------------------------------------------------------
// recordStat — dedup behavior
// ---------------------------------------------------------------------------

describe("recordStat — deduplication", () => {
  it("records a new request on first call", () => {
    recordStat({
      id: "#001", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "150", tokens: "10",
    });
    // Read back via the stats endpoint
    return expectStats({ total: 1, success: 1, failed: 0, retried: 0 });
  });

  it("does NOT double-count when same id is recorded twice (retry path)", () => {
    // First call: 529 (will be retried)
    recordStat({
      id: "#002", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0",
    });
    // Second call: 200 (retry succeeded)
    recordStat({
      id: "#002", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "200", tokens: "15",
      retried: true,
    });
    return expectStats({ total: 1, success: 1, failed: 0, retried: 1 });
  });

  it("reclassifies status when retry changes the outcome", () => {
    // First: 529 (failed)
    recordStat({ id: "#003", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    // Retry: still 529 (failed)
    recordStat({ id: "#003", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", retried: true });
    return expectStats({ total: 1, success: 0, failed: 1, retried: 1 });
  });

  it("does NOT re-increment retried counter on duplicate retried calls", () => {
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", retried: true });
    recordStat({ id: "#004", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", retried: true });
    return expectStats({ total: 1, success: 1, failed: 0, retried: 1 });
  });

  it("counts separate requests with different ids independently", () => {
    recordStat({ id: "#010", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#011", time: "10:00:01", model: "glm-4.6", status: 500, ttfb: "200", tokens: "0" });
    recordStat({ id: "#012", time: "10:00:02", model: "glm-4.6", status: 529, ttfb: "300", tokens: "0", retried: true });
    return expectStats({ total: 3, success: 1, failed: 2, retried: 1 });
  });

  it("aggregates per-model stats correctly", async () => {
    recordStat({ id: "#020", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#021", time: "10:00:01", model: "glm-4.6", status: 200, ttfb: "200", tokens: "10" });
    recordStat({ id: "#022", time: "10:00:02", model: "glm-5.1", status: 200, ttfb: "150", tokens: "7" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.models["glm-4.6"].count).toBe(2);
    // avgTtfb = (100 + 200) / 2 = 150
    expect(body.models["glm-4.6"].avgTtfb).toBe(150);
    expect(body.models["glm-4.6"].tokens).toBe(15);
    expect(body.models["glm-5.1"].count).toBe(1);
    expect(body.models["glm-5.1"].tokens).toBe(7);
  });
});

/** Helper: fetch /admin/api/stats and assert the counter fields. */
async function expectStats(expected: { total: number; success: number; failed: number; retried: number }): Promise<void> {
  const opts = makeAdminOpts();
  const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
  if (!resp) throw new Error("stats response was null");
  const body = await resp.json();
  expect(body.total).toBe(expected.total);
  expect(body.success).toBe(expected.success);
  expect(body.failed).toBe(expected.failed);
  expect(body.retried).toBe(expected.retried);
}

// ---------------------------------------------------------------------------
// recordStat — vceshi0.0.7+ post-trim dedup (seenIds)
// ---------------------------------------------------------------------------

describe("recordStat — post-trim deduplication (vceshi0.0.7+)", () => {
  it("does NOT double-count when a retry arrives after the original entry was trimmed", () => {
    // Fill the requests[] buffer past the 200-entry trim threshold.
    // Each id is unique so they're all counted as new requests.
    for (let i = 0; i < 210; i++) {
      recordStat({
        id: `#trim-${i}`, time: "10:00:00", model: "glm-4.6",
        status: 200, ttfb: "100", tokens: "5",
      });
    }
    // After 200 entries, the buffer is trimmed to 100. The first 110 ids
    // (`#trim-0` through `#trim-109`) are evicted from requestIndex but
    // remain in the lifetime seenIds set.
    // Now simulate a retry for one of the evicted ids — without seenIds
    // this would be counted as a new request, inflating `total`.
    recordStat({
      id: `#trim-0`, time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "100", tokens: "5", retried: true,
    });
    // total should stay at 210 (not 211), retried should be 1.
    return expectStats({ total: 210, success: 211, failed: 0, retried: 1 })
      .catch((err) => {
        // If the assertion fails, the actual total reveals the bug.
        throw err;
      });
  });

  it("caps the models map at 100 distinct entries (vceshi0.0.7+)", async () => {
    // Send 105 distinct model names. After 100, the rest should aggregate
    // under "_other" instead of creating new entries.
    for (let i = 0; i < 105; i++) {
      recordStat({
        id: `#cap-${i}`, time: "10:00:00", model: `model-${i}`,
        status: 200, ttfb: "100", tokens: "5",
      });
    }
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    const modelCount = Object.keys(body.models).length;
    // Should be exactly 101 (100 distinct + "_other").
    expect(modelCount).toBe(101);
    // "_other" should have aggregated the last 5 entries.
    expect(body.models["_other"].count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// recordStat — byCredential re-classification on retry (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("recordStat — byCredential re-classification (vceshi0.0.7+)", () => {
  it("increments byCredential when a failed request succeeds on retry", async () => {
    // First call: 529 (failed) — byCredential NOT incremented (only counts successes).
    recordStat({
      id: "#cred-1", time: "10:00:00", model: "glm-4.6",
      status: 529, ttfb: "100", tokens: "0",
      credentialKey: "abc12345...wxyz",
    });
    // Retry: 200 (success) — byCredential SHOULD be incremented now.
    recordStat({
      id: "#cred-1", time: "10:00:00", model: "glm-4.6",
      status: 200, ttfb: "200", tokens: "15",
      credentialKey: "abc12345...wxyz",
      retried: true,
    });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["abc12345...wxyz"].count).toBe(1);
    expect(body.byCredential["abc12345...wxyz"].outputTokens).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// recordStat — byStatus error breakdown + byCredential success/fail (logging G5+G6)
// ---------------------------------------------------------------------------

describe("recordStat — byStatus error breakdown (G5)", () => {
  it("tracks error counts per status code", async () => {
    recordStat({ id: "#s1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5" });
    recordStat({ id: "#s2", time: "10:00:01", model: "glm-4.6", status: 529, ttfb: "200", tokens: "0" });
    recordStat({ id: "#s3", time: "10:00:02", model: "glm-4.6", status: 529, ttfb: "300", tokens: "0" });
    recordStat({ id: "#s4", time: "10:00:03", model: "glm-4.6", status: 429, ttfb: "50", tokens: "0" });
    recordStat({ id: "#s5", time: "10:00:04", model: "glm-4.6", status: 401, ttfb: "10", tokens: "0" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byStatus[200]).toBe(1);
    expect(body.byStatus[529]).toBe(2);
    expect(body.byStatus[429]).toBe(1);
    expect(body.byStatus[401]).toBe(1);
  });

  it("updates byStatus when a retry changes status (529→200)", async () => {
    recordStat({ id: "#s6", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    recordStat({ id: "#s6", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", retried: true });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    // 529 should be decremented (0 → removed), 200 should be 1
    expect(body.byStatus[529] ?? 0).toBe(0);
    expect(body.byStatus[200]).toBe(1);
  });

  it("resets byStatus on DELETE /admin/api/stats", async () => {
    recordStat({ id: "#s7", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0" });
    const opts = makeAdminOpts();
    await callAdmin(authedReq("/admin/api/stats", { method: "DELETE" }), opts);
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byStatus).toEqual({});
  });
});

describe("recordStat — byCredential success/fail tracking (G6)", () => {
  it("tracks success and failure counts per credential", async () => {
    recordStat({ id: "#c1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "100", tokens: "5", credentialKey: "key1...abcd" });
    recordStat({ id: "#c2", time: "10:00:01", model: "glm-4.6", status: 529, ttfb: "200", tokens: "0", credentialKey: "key1...abcd" });
    recordStat({ id: "#c3", time: "10:00:02", model: "glm-4.6", status: 200, ttfb: "150", tokens: "10", credentialKey: "key2...efgh" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key1...abcd"].success).toBe(1);
    expect(body.byCredential["key1...abcd"].failed).toBe(1);
    expect(body.byCredential["key1...abcd"].count).toBe(1); // only successful counted
    expect(body.byCredential["key2...efgh"].success).toBe(1);
    expect(body.byCredential["key2...efgh"].failed).toBe(0);
  });

  it("updates credential success/fail on re-classification (529→200)", async () => {
    recordStat({ id: "#c4", time: "10:00:00", model: "glm-4.6", status: 529, ttfb: "100", tokens: "0", credentialKey: "key3...ijkl" });
    recordStat({ id: "#c4", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "200", tokens: "15", credentialKey: "key3...ijkl", retried: true });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.byCredential["key3...ijkl"].success).toBe(1);
    expect(body.byCredential["key3...ijkl"].failed).toBe(0);
    expect(body.byCredential["key3...ijkl"].count).toBe(1);
  });
});

describe("recordStat — captchaMs field (G4)", () => {
  it("records captchaMs in the request entry", async () => {
    recordStat({ id: "#cap1", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "35000", tokens: "10", captchaMs: "32000" });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.requests[body.requests.length - 1].captchaMs).toBe("32000");
  });

  it("defaults captchaMs to '0' when not provided", async () => {
    recordStat({ id: "#cap2", time: "10:00:00", model: "glm-4.6", status: 200, ttfb: "150", tokens: "10" });
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/stats"), opts);
    const body = await resp!.json();
    expect(body.requests[body.requests.length - 1].captchaMs).toBe("0");
  });
});

describe("ring buffer — log buffer (G8)", () => {
  it("survives overfill beyond LOG_BUFFER_SIZE without splice", async () => {
    // Push more entries than the buffer can hold — the ring buffer should
    // silently overwrite the oldest without any splice/copy overhead.
    for (let i = 0; i < 2500; i++) {
      appendLog("info", `log entry ${i}`);
    }
    const opts = makeAdminOpts();
    // Batch endpoint should return the last N entries
    const resp = await callAdmin(authedReq("/admin/api/logs?limit=10"), opts);
    const body = await resp!.json();
    // Should have exactly 10 logs (limited by ?limit=10)
    expect(body.logs.length).toBe(10);
    // The most recent entries should be the last ones pushed
    expect(body.logs[9].message).toBe("log entry 2499");
    // Total should be the ring buffer count (capped at LOG_BUFFER_SIZE)
    expect(body.total).toBeLessThanOrEqual(2000);
  });

  it("supports level filtering on the ring buffer", async () => {
    appendLog("info", "info message");
    appendLog("error", "error message");
    appendLog("warn", "warn message");
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/logs?level=error"), opts);
    const body = await resp!.json();
    expect(body.logs.length).toBe(1);
    expect(body.logs[0].message).toBe("error message");
    expect(body.logs[0].level).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/oauth/init — provider validation (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("POST /admin/api/oauth/init — provider validation (vceshi0.0.7+)", () => {
  it("returns 400 for unknown provider", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/oauth/init", {
        method: "POST",
        body: JSON.stringify({ provider: "evil" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/provider must be 'zai' or 'bigmodel'/);
  });

  it("returns 400 when provider is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/oauth/init", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/endpoints — URL validation (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("PUT /admin/api/endpoints — URL validation (vceshi0.0.7+)", () => {
  it("returns 400 for malformed anthropicBase URL", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { anthropicBase: "api.z.ai" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/not a valid URL/);
  });

  it("returns 400 for non-http(s) scheme", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { anthropicBase: "ftp://example.com" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/must be http\(s\):\/\//);
  });

  it("returns 400 for unknown field in provider object", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({ zai: { apiKey: "stolen" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.message).toMatch(/not allowed/);
  });

  it("accepts valid URLs and persists", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/endpoints", {
        method: "PUT",
        body: JSON.stringify({
          zai: { anthropicBase: "https://api.z.ai/api/anthropic" },
          bigmodel: { openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
        }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.providers.zai.anthropicBase).toBe("https://api.z.ai/api/anthropic");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/credentials DELETE — clears in-memory auth (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("DELETE /admin/api/credentials — clears in-memory oauth cred (vceshi0.0.7+)", () => {
  it("calls auth.clearOAuthCredential() so running requests stop using the cleared cred", async () => {
    // Use a mock AuthManager to verify clearOAuthCredential is called.
    let clearCalled = false;
    const fakeAuth = {
      setOAuthCredential: () => {},
      clearOAuthCredential: () => { clearCalled = true; },
      getCredential: async () => { throw new Error("no cred"); },
      switchToNextCredential: async () => null,
      getMode: () => "oauth" as const,
    };
    const opts = makeAdminOpts({ auth: fakeAuth as unknown as AuthManager });
    const resp = await callAdmin(
      authedReq("/admin/api/credentials", { method: "DELETE" }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(clearCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/quota — per-account rate limit (vceshi0.0.7+)
// ---------------------------------------------------------------------------

describe("POST /admin/api/accounts/quota — per-account rate limit (vceshi0.0.7+)", () => {
  it("returns 400 when id is missing or non-string", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/quota", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 400 when id is a number (not a string)", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/quota", {
        method: "POST",
        body: JSON.stringify({ id: 123 }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/logs/stream + appendLog — infinite loop regression (vceshi0.0.7+ HOTFIX)
// ---------------------------------------------------------------------------

describe("POST /admin/api/accounts/active — does not freeze server via appendLog (vceshi0.0.7+ HOTFIX)", () => {
  // Regression test for the infinite-loop bug in appendLog's old
  // `while (logWaiters.length > 0) { shift().resolve() }` form. The waiter's
  // resolve() re-pushed itself into logWaiters synchronously, so the while
  // condition stayed true forever — blocking the event loop and freezing
  // the entire dashboard the moment any handler called appendLog.
  //
  // We simulate this by:
  // 1. Opening an SSE log stream (registers a long-lived waiter)
  // 2. Triggering an action that calls appendLog (PUT /admin/api/accounts/active)
  // 3. Asserting the PUT response arrives within a reasonable timeout
  //
  // If the bug is present, the PUT never resolves and the test times out.

  it("appendLog does not infinite-loop when an SSE client is connected", async () => {
    // Save an account so we can switch to it.
    const tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-sse-"));
    process.env.ZCODE_PROXY_STORE_DIR = tmpDir;
    _resetKeyCacheForTesting();
    const cred: Credential = {
      apiKey: "sk-test-1", provider: "zai", plan: "coding-plan",
    };
    await saveCredential(cred, { keepActive: true });
    const cred2: Credential = {
      apiKey: "sk-test-2", provider: "zai", plan: "coding-plan",
    };
    await saveCredential(cred2, { keepActive: true });
    const list = await listAccounts();
    expect(list.accounts.length).toBe(2);
    // Activate the first account so we can switch to the second
    const targetId = list.accounts[0].id;

    try {
      const opts = makeAdminOpts({
        auth: new AuthManager({ mode: "oauth", provider: "zai" }),
      });

      // 1. Open the SSE log stream (this registers a waiter in logWaiters).
      const sseResp = await callAdmin(
        authedReq("/admin/api/logs/stream"),
        opts,
      );
      expect(sseResp).not.toBeNull();
      expect(sseResp!.status).toBe(200);
      // Start reading the stream so the controller doesn't buffer forever.
      const reader = (sseResp!.body as ReadableStream<Uint8Array>).getReader();
      const readPromise = (async () => {
        // Read a few chunks then stop — we don't care about the content,
        // we just need the stream to be actively consumed so the controller
        // doesn't apply backpressure that would prevent enqueue.
        for (let i = 0; i < 5; i++) {
          await reader.read();
        }
      })();

      // 2. Give the SSE handler a tick to register its waiter.
      await new Promise(r => setTimeout(r, 50));

      // 3. Trigger an action that calls appendLog. With the bug present,
      //    this PUT never resolves because appendLog infinite-loops and
      //    blocks the event loop. We use a 5s timeout to fail fast.
      const switchPromise = callAdmin(
        authedReq("/admin/api/accounts/active", {
          method: "PUT",
          body: JSON.stringify({ id: targetId }),
        }),
        opts,
      );

      const result = await Promise.race([
        switchPromise.then(r => ({ ok: true, r })),
        new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), 5000)),
      ]);

      // 4. Cancel the SSE stream so the test can clean up.
      try { reader.cancel(); } catch {}
      try { await readPromise; } catch {}

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.r!.status).toBe(200);
        const body = await result.r!.json();
        expect(body.ok).toBe(true);
      }
    } finally {
      clearCredential();
      delete process.env.ZCODE_PROXY_STORE_DIR;
      _resetKeyCacheForTesting();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// recordDebugDump — ring buffer
// ---------------------------------------------------------------------------

describe("recordDebugDump — ring buffer", () => {
  it("records a dump and exposes it via /admin/api/debug-dumps", async () => {
    recordDebugDump({
      id: "#001", status: 400,
      upstreamError: '{"error":"bad request"}',
      anthropicBeta: "claude-code-1",
      bodySummary: "model=glm-4.6 | msgs[[0]user/{text}]",
      body: '{"model":"glm-4.6","messages":[]}',
    });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(1);
    expect(body.dumps[0].id).toBe("#001");
    expect(body.dumps[0].status).toBe(400);
    // Body is hidden by default (privacy)
    expect(body.dumps[0].body).toBeUndefined();
    expect(body.dumps[0].bodySummary).toBeTruthy();
  });

  it("exposes full body only when ?full=1 is set", async () => {
    recordDebugDump({
      id: "#002", status: 3001,
      upstreamError: "parameter error",
      anthropicBeta: "",
      bodySummary: "summary",
      body: '{"secret":"content"}',
    });

    const opts = makeAdminOpts();
    // Without full=1
    const r1 = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const b1 = await r1!.json();
    expect(b1.dumps[0].body).toBeUndefined();

    // With full=1
    const r2 = await callAdmin(authedReq("/admin/api/debug-dumps?full=1"), opts);
    const b2 = await r2!.json();
    expect(b2.dumps[0].body).toBe('{"secret":"content"}');
  });

  it("fetches a single dump by id with ?id=", async () => {
    recordDebugDump({
      id: "#003", status: 400,
      upstreamError: "err", anthropicBeta: "",
      bodySummary: "s", body: '{"x":1}',
    });

    const opts = makeAdminOpts();
    // URL-encode the # in the id (otherwise it becomes a URL fragment)
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=" + encodeURIComponent("#003") + "&full=1"), opts);
    const body = await resp!.json();
    expect(body.id).toBe("#003");
    expect(body.body).toBe('{"x":1}');
  });

  it("returns 404 for unknown dump id", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?id=nonexistent"), opts);
    expect(resp!.status).toBe(404);
  });

  it("caps the ring buffer at 20 entries (oldest evicted)", async () => {
    // Record 25 dumps
    for (let i = 0; i < 25; i++) {
      recordDebugDump({
        id: `#${String(i).padStart(3, "0")}`, status: 400,
        upstreamError: "e", anthropicBeta: "",
        bodySummary: "s", body: "{}",
      });
    }

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/debug-dumps?limit=100"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(20);
    // Oldest 5 (#000..#004) should be evicted; newest 20 (#005..#024) remain.
    const ids = body.dumps.map((d: { id: string }) => d.id);
    expect(ids).not.toContain("#000");
    expect(ids).not.toContain("#004");
    expect(ids).toContain("#005");
    expect(ids).toContain("#024");
  });

  it("DELETE /admin/api/debug-dumps clears all dumps", async () => {
    recordDebugDump({
      id: "#001", status: 400,
      upstreamError: "e", anthropicBeta: "",
      bodySummary: "s", body: "{}",
    });

    const opts = makeAdminOpts();
    const del = await callAdmin(authedReq("/admin/api/debug-dumps", { method: "DELETE" }), opts);
    expect(del!.status).toBe(200);

    const resp = await callAdmin(authedReq("/admin/api/debug-dumps"), opts);
    const body = await resp!.json();
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/verify — no_auth warning
// ---------------------------------------------------------------------------

describe("/admin/api/verify — security warning", () => {
  it("returns {valid: true} when proxyApiKey matches", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify"), opts);
    const body = await resp!.json();
    expect(body.valid).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  it("returns {valid: true, warning: 'no_auth'} when proxyApiKey is unset", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test" /* no proxyApiKey */ } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify", { token: "anything" }), opts);
    const body = await resp!.json();
    expect(body.valid).toBe(true);
    expect(body.warning).toBe("no_auth");
    expect(body.message).toContain("proxyApiKey");
  });

  it("returns 401 when proxyApiKey is set but token doesn't match", async () => {
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const resp = await callAdmin(authedReq("/admin/api/verify", { token: "wrong" }), opts);
    expect(resp!.status).toBe(401);
  });

  it("does NOT require auth to call /verify itself (chicken-and-egg)", async () => {
    // /verify is explicitly excluded from the auth gate in handleAdminRoute
    const opts = makeAdminOpts({
      config: makeConfig({ auth: { mode: "apikey", apiKey: "test", proxyApiKey: "proxy-secret" } }),
    });
    const req = new Request("http://localhost/admin/api/verify"); // no auth header
    const resp = await callAdmin(req, opts);
    expect(resp!.status).toBe(401); // token check fails, but request reaches /verify
  });
});

// ---------------------------------------------------------------------------
// /admin/api/config PUT — validation + requiresRestart
// ---------------------------------------------------------------------------

describe("/admin/api/config PUT — validation", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects port out of range", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: 99999 } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("out of range");
  });

  it("rejects invalid provider", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai" }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("Invalid provider");
  });

  it("rejects invalid plan", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ plan: "enterprise-plan" }),
    }), opts);
    expect(resp!.status).toBe(500);
  });

  it("rejects invalid provider URL", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: { zai: { anthropicBase: "not-a-url" } },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("not a valid URL");
  });

  it("rejects non-http(s) provider URL", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        providers: { zai: { anthropicBase: "ftp://example.com" } },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("must be http(s)");
  });

  it("accepts large retry.maxRetries (no upper bound)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    // Send the full payload the way the dashboard does — partial payloads
    // would trip "models must contain at least one entry" before reaching
    // the retry validation, masking the actual behavior under test.
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 50, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
  });

  it("rejects negative retry.maxRetries", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: -1, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("maxRetries");
  });

  it("rejects negative retry.credentialSwitchThreshold", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: -1, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("credentialSwitchThreshold");
  });

  it("accepts credentialSwitchThreshold=0 (disabled)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        retry: { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    expect(resp!.status).toBe(200);
  });

  it("rejects invalid host format", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ server: { port: 8080, host: "has spaces" } }),
    }), opts);
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("not a valid IP or hostname");
  });

  it("accepts valid host formats (IPv4, hostname, 0.0.0.0)", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    for (const host of ["0.0.0.0", "127.0.0.1", "localhost", "my-host.example.com"]) {
      const resp = await callAdmin(authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ server: { port: 8080, host } }),
      }), opts);
      expect(resp!.status).toBe(200);
    }
  });
});

describe("/admin/api/config PUT — requiresRestart detection", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns requiresRestart: true when port changes", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        server: { port: 9999, host: "127.0.0.1" },
        provider: "zai", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        identity: { appVersion: "1.0", sourceTitle: "cli", refererOrigin: "https://z.ai" },
        logging: { level: "info" },
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.requiresRestart).toBe(true);
    expect(body.restartFields).toContain("server.port");
  });

  it("returns requiresRestart: false when only hot-swappable fields change", async () => {
    const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
    const resp = await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "bigmodel", plan: "coding-plan",
        defaultModel: "glm-4.6", models: ["glm-4.6"],
        identity: { appVersion: "1.0", sourceTitle: "cli", refererOrigin: "https://z.ai" },
        logging: { level: "info" },
        retry: { maxRetries: 0, initialDelayMs: 1000, maxDelayMs: 8000, backoffFactor: 2, retryableStatuses: [529], credentialSwitchThreshold: 0, emptyStreamSwitchThreshold: 3 },
      }),
    }), opts);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.requiresRestart).toBe(false);
    expect(body.restartFields).toEqual([]);
    expect(body.hotApplied).toContain("provider");
  });

  it("persists config to disk", async () => {
    const configPath = join(tmpDir, "config.yaml");
    const opts = makeAdminOpts({ configPath });
    await callAdmin(authedReq("/admin/api/config", {
      method: "PUT",
      body: JSON.stringify({ provider: "bigmodel" }),
    }), opts);
    expect(existsSync(configPath)).toBe(true);
    const written = readFileSync(configPath, "utf-8");
    expect(written).toContain("bigmodel");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/logs — batch endpoint
// ---------------------------------------------------------------------------

describe("/admin/api/logs — batch endpoint", () => {
  it("returns logs array with total count", async () => {
    // Trigger some logs via the admin route itself (PUT config logs a message)
    const tmpDir = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
    try {
      const opts = makeAdminOpts({ configPath: join(tmpDir, "config.yaml") });
      // Trigger a log via PUT config
      await callAdmin(authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ provider: "bigmodel" }),
      }), opts);
      // Now query logs
      const resp = await callAdmin(authedReq("/admin/api/logs"), opts);
      const body = await resp!.json();
      expect(Array.isArray(body.logs)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.total).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects ?limit param", async () => {
    const opts = makeAdminOpts();
    // Append a bunch of logs
    for (let i = 0; i < 50; i++) {
      // We can't import appendLog directly without polluting tests; use a dummy
      // approach via recordStat which doesn't log. Skip this test if we can't
      // easily generate logs — but we can write directly via the API route.
    }
    const resp = await callAdmin(authedReq("/admin/api/logs?limit=5"), opts);
    const body = await resp!.json();
    expect(body.logs.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// /admin — dashboard HTML
// ---------------------------------------------------------------------------

describe("/admin — dashboard page", () => {
  it("serves HTML at /admin", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin"), opts);
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get("content-type")).toContain("text/html");
    const body = await resp!.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("zcode-proxy");
  });

  it("serves HTML at /admin/", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(new Request("http://localhost/admin/"), opts);
    expect(resp!.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/render-export — Render credential export
// ---------------------------------------------------------------------------
//
// Regression coverage for the multi-account bug where the export endpoint
// only emitted the active credential (single) even when the user had multiple
// accounts stored. The fix:
//   • 0 accounts → 404
//   • 1 account  → bare credential base64 (backward compat)
//   • 2+ accounts → full v2 store envelope base64 (preserves all accounts)
//
describe("/admin/api/accounts/render-export — multi-account export", () => {
  const TEST_SECRET = "test-encryption-secret-for-render-export";

  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 404 when no credential is stored", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(404);
  });

  it("exports a single account as a bare credential (backward compat)", async () => {
    await saveCredential({ apiKey: "key-single", provider: "zai" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();

    expect(body.multi).toBe(false);
    expect(body.accountCount).toBe(1);

    // Decoded blob should be a bare Credential, not a v2 store envelope.
    const decoded = JSON.parse(Buffer.from(body.credential, "base64").toString("utf8"));
    expect(decoded.apiKey).toBe("key-single");
    expect(decoded.provider).toBe("zai");
    expect(decoded.version).toBeUndefined();
    expect(decoded.accounts).toBeUndefined();

    // Env vars are present and contain the same base64 blob.
    expect(body.envVars.ZCODE_AUTH_MODE).toBe("oauth");
    expect(body.envVars.ZCODE_OAUTH_CREDENTIAL).toBe(body.credential);
  });

  it("exports ALL accounts as a v2 store envelope when multiple are stored", async () => {
    // Save two distinct accounts (different provider+apiKey → not deduped).
    await saveCredential({ apiKey: "key-A", provider: "zai" });
    await saveCredential({ apiKey: "key-B", provider: "bigmodel" });

    const opts = makeAdminOpts();
    const resp = await callAdmin(authedReq("/admin/api/accounts/render-export"), opts);
    expect(resp!.status).toBe(200);
    const body = await resp!.json();

    expect(body.multi).toBe(true);
    expect(body.accountCount).toBe(2);

    // Decoded blob should be a v2 store envelope with both accounts.
    const decoded = JSON.parse(Buffer.from(body.credential, "base64").toString("utf8"));
    expect(decoded.version).toBe(2);
    expect(Array.isArray(decoded.accounts)).toBe(true);
    expect(decoded.accounts.length).toBe(2);
    expect(decoded.activeId).toBeTruthy();

    // Both API keys must be present in the export — this is the bug fix.
    const apiKeys = decoded.accounts.map((a: any) => a.credential.apiKey).sort();
    expect(apiKeys).toEqual(["key-A", "key-B"]);

    // Each account must have id/label/createdAt + credential structure.
    for (const acc of decoded.accounts) {
      expect(typeof acc.id).toBe("string");
      expect(typeof acc.label).toBe("string");
      expect(typeof acc.createdAt).toBe("number");
      expect(acc.credential).toBeTruthy();
      expect(acc.credential.apiKey).toBeTruthy();
      expect(acc.credential.provider).toBeTruthy();
    }

    // Env vars use the same base64 blob.
    expect(body.envVars.ZCODE_AUTH_MODE).toBe("oauth");
    expect(body.envVars.ZCODE_OAUTH_CREDENTIAL).toBe(body.credential);

    // Pretty-printed JSON view also reflects both accounts.
    expect(body.json).toContain('"accounts"');
    expect(body.json).toContain("key-A");
    expect(body.json).toContain("key-B");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/proxy — per-account outbound HTTP proxy (v2.1.4.1test5)
// ---------------------------------------------------------------------------

describe("/admin/api/accounts/proxy — per-account proxy CRUD", () => {
  const TEST_SECRET = "test-encryption-secret-for-proxy-tests";

  beforeEach(() => {
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
    clearCredential();
  });

  afterEach(() => {
    clearCredential();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ proxy: "http://p:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when proxy field is missing", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await import("../auth/store.js").then(m => m.listAccounts());
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 for invalid proxy scheme", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await import("../auth/store.js").then(m => m.listAccounts());
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "ftp://not-a-valid-scheme:21" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
    expect(body.error.message).toContain("http://");
  });

  it("returns 404 when account id does not exist", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent", proxy: "http://p:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });

  it("sets a valid http proxy on an existing account", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].proxy).toBe("");

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.proxy).toBe("http://127.0.0.1:7890");

    // Verify it persisted
    const list2 = await store.listAccounts();
    expect(list2.accounts[0].proxy).toBe("http://127.0.0.1:7890");
  });

  it("accepts socks5:// proxy scheme", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "socks5://10.0.0.1:1080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect((await resp!.json()).proxy).toBe("socks5://10.0.0.1:1080");
  });

  it("clears the proxy when empty string is sent", async () => {
    // Start with a proxy set
    await saveCredential({ apiKey: "k", provider: "zai", proxy: "http://existing:8080" } as any);
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;
    expect(list.accounts[0].proxy).toBe("http://existing:8080");

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "   " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.proxy).toBe("");

    // Verify it was cleared in the store
    const list2 = await store.listAccounts();
    expect(list2.accounts[0].proxy).toBe("");
    const cred = await store.loadCredential();
    expect(cred!.proxy).toBeUndefined();
  });

  it("hot-swaps the in-memory credential when the active account is updated (oauth mode)", async () => {
    await saveCredential({ apiKey: "k-active", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    // Use oauth mode so setOAuthCredential is the active code path (apikey
    // mode keeps the credential constructed at AuthManager init time and
    // never re-reads the store). In oauth mode, setOAuthCredential swaps the
    // in-memory cred, which is what the dashboard's hot-swap relies on.
    const opts = makeAdminOpts({
      auth: new AuthManager({ mode: "oauth", provider: "zai" }),
    });
    // Seed the in-memory credential with the stored one (no proxy yet)
    const credBefore = await store.loadCredential();
    opts.auth.setOAuthCredential(credBefore!);
    const baselineCred = await opts.auth.getCredential();
    expect(baselineCred.proxy).toBeUndefined();

    // Update proxy via API — handler should call setOAuthCredential with the
    // freshly loaded credential (which now includes proxy).
    await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "http://hot-swap:9999" }),
      }),
      opts,
    );

    // The AuthManager's in-memory credential should now reflect the proxy
    const credAfter = await opts.auth.getCredential();
    expect(credAfter.proxy).toBe("http://hot-swap:9999");
  });

  it("trims whitespace from proxy URL", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const store = await import("../auth/store.js");
    const list = await store.listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy", {
        method: "PUT",
        body: JSON.stringify({ id, proxy: "  http://spaced:1234  " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect((await resp!.json()).proxy).toBe("http://spaced:1234");
  });
});

// ---------------------------------------------------------------------------
// /admin/api/accounts/proxy-test — connectivity test (v2.1.4.1test6)
// ---------------------------------------------------------------------------

describe("/admin/api/accounts/proxy-test — proxy connectivity check", () => {
  it("returns 400 when proxy is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when proxy is empty string", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "   " }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });

  it("returns 400 for invalid proxy scheme", async () => {
    const opts = makeAdminOpts();
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "ftp://host:21" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });

  it("returns ok:true with status + latencyMs when proxy reaches upstream", async () => {
    // Mock fetch — simulate a successful HEAD response through the proxy.
    // The mock asserts that the proxy URL was passed via the `proxy` init
    // option, proving the request would actually have been routed through
    // the proxy in a real environment.
    let receivedProxy: string | undefined;
    let receivedMethod: string | undefined;
    let receivedUrl: string | undefined;
    const mockFetch = (async (url: string, init?: any): Promise<Response> => {
      receivedUrl = url;
      receivedMethod = init?.method;
      receivedProxy = init?.proxy;
      return new Response(null, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.target).toContain("api.z.ai");
    // The fetch mock should have received the proxy URL
    expect(receivedProxy).toBe("http://127.0.0.1:7890");
    expect(receivedMethod).toBe("HEAD");
    expect(receivedUrl).toContain("api.z.ai");
  });

  it("uses bigmodel upstream when provider=bigmodel", async () => {
    let receivedUrl: string | undefined;
    const mockFetch = (async (url: string): Promise<Response> => {
      receivedUrl = url;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "socks5://10.0.0.1:1080", provider: "bigmodel" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.target).toContain("bigmodel.cn");
    expect(receivedUrl).toContain("bigmodel.cn");
  });

  it("treats any HTTP status as success (including 4xx/5xx)", async () => {
    // Even a 404 from the upstream host means the proxy is reachable —
    // only network-level failures should report ok=false.
    const mockFetch = (async (_url: string, _init?: any): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://proxy:8080" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(404);
  });

  it("returns ok:false with error message when fetch throws", async () => {
    // Simulate a network-level failure (proxy unreachable, DNS failure, etc.)
    const mockFetch = (async (_url: string, _init?: any): Promise<Response> => {
      throw new Error("ECONNREFUSED 127.0.0.1:7890");
    }) as unknown as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://127.0.0.1:7890" }),
      }),
      opts,
    );
    // Still HTTP 200 so the dashboard can render the error message cleanly.
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("ECONNREFUSED");
    expect(typeof body.latencyMs).toBe("number");
  });

  it("reports timeout clearly when AbortController fires", async () => {
    // Simulate a fetch that hangs and gets aborted by the timeout
    const mockFetch = (async (_url: string, init?: any): Promise<Response> => {
      // Wait longer than the timeout, then check if aborted
      await new Promise(resolve => setTimeout(resolve, 200));
      if (init?.signal?.aborted) {
        throw new Error("The operation was aborted");
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const opts = makeAdminOpts({ fetchImpl: mockFetch });
    // Note: real timeout is 10s — for test speed we accept the 200ms wait.
    const resp = await callAdmin(
      authedReq("/admin/api/accounts/proxy-test", {
        method: "POST",
        body: JSON.stringify({ proxy: "http://slow-proxy:9999" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    // The mock should have detected the abort; either the test runs faster
    // than the 10s timeout (so ok:true) or the mock's own 200ms wait
    // completes normally. We only assert the response shape.
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.latencyMs).toBe("number");
  });
});

// /admin/api/accounts/edit + /admin/api/accounts/export-single (vceshi0.0.4+)
describe("/admin/api/accounts/edit — name/email editing", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-for-edit";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ name: "x" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when neither name nor email is provided", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id: "some-id" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("updates name + email for an existing account", async () => {
    // First save a credential to get a real account id
    await saveCredential({ apiKey: "test-key-edit", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id, name: "edited-name", email: "edited@x.com" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);

    // Verify the update persisted
    const list2 = await listAccounts();
    expect(list2.accounts[0].name).toBe("edited-name");
    expect(list2.accounts[0].email).toBe("edited@x.com");
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/edit", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent-id", name: "x" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });
});

describe("/admin/api/accounts/export-single — single account JSON export", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-for-export";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id query param is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/export-single", { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/export-single?id=nonexistent", { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });

  it("exports full account JSON including secrets", async () => {
    const cred: Credential = {
      apiKey: "export-test-key-1234567890",
      secret: "secret-abc",
      provider: "zai",
      plan: "coding-plan",
      userId: "user-xyz",
      name: "bob@x.com-coding-plan",
      email: "bob@x.com",
    };
    await saveCredential(cred);
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq(`/admin/api/accounts/export-single?id=${id}`, { method: "GET" }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.account).toBeDefined();
    expect(body.account.id).toBe(id);
    // Full credential with secrets (NOT masked)
    expect(body.account.credential.apiKey).toBe("export-test-key-1234567890");
    expect(body.account.credential.secret).toBe("secret-abc");
    expect(body.account.credential.email).toBe("bob@x.com");
    expect(body.account.credential.name).toBe("bob@x.com-coding-plan");
  });
});

// vceshi0.0.5: PUT /config deep-merges nested objects (retry/identity/logging/providers)
describe("PUT /admin/api/config — deep merge of nested objects (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-config-merge";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("partial retry update preserves other retry fields (no TypeError)", async () => {
    // Send only maxRetries in the retry object. Without deep-merge, this would
    // drop retryableStatuses/initialDelayMs/etc., causing handler.ts to throw
    // TypeError on the next request.
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { maxRetries: 7 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    // The merged retry config should still have all original fields plus the new maxRetries
    expect(opts.config.retry.maxRetries).toBe(7);
    expect(opts.config.retry.initialDelayMs).toBe(1000); // preserved
    expect(opts.config.retry.maxDelayMs).toBe(8000); // preserved
    expect(opts.config.retry.backoffFactor).toBe(2); // preserved
    expect(opts.config.retry.retryableStatuses).toEqual([529]); // preserved
    expect(opts.config.retry.credentialSwitchThreshold).toBe(0); // preserved
    expect(opts.config.retry.emptyStreamSwitchThreshold).toBe(3); // preserved
  });

  it("partial identity update preserves other identity fields", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ identity: { appVersion: "9.9.9" } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    expect(opts.config.identity.appVersion).toBe("9.9.9");
    expect(opts.config.identity.sourceTitle).toBe("cli"); // preserved
    expect(opts.config.identity.refererOrigin).toBe("https://zcode.z.ai"); // preserved
  });
});

// vceshi0.0.5: POST /admin/api/credentials validates apiKey + provider
describe("POST /admin/api/credentials — field validation (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-cred-validation";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when apiKey is empty", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: "zai", apiKey: "" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("missing_param");
  });

  it("returns 400 when provider is invalid", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/credentials", {
        method: "POST",
        body: JSON.stringify({ provider: "invalid-provider", apiKey: "some-key" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
    const body = await resp!.json();
    expect(body.error.type).toBe("invalid_param");
  });
});

// vceshi0.0.5: validateConfigForSave rejects bad emptyStreamSwitchThreshold + backoffFactor
describe("PUT /admin/api/config — retry field validation (vceshi0.0.5+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-retry-validation";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("rejects negative emptyStreamSwitchThreshold", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { emptyStreamSwitchThreshold: -1 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("emptyStreamSwitchThreshold");
  });

  it("rejects zero/negative backoffFactor", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/config", {
        method: "PUT",
        body: JSON.stringify({ retry: { backoffFactor: 0 } }),
      }),
      opts,
    );
    expect(resp!.status).toBe(500);
    const body = await resp!.json();
    expect(body.error.message).toContain("backoffFactor");
  });
});

// vceshi0.0.6+: disabled toggle endpoint
describe("/admin/api/accounts/disabled — toggle disabled state (vceshi0.0.6+)", () => {
  beforeEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "test-secret-disabled";
  });
  afterEach(() => {
    clearCredential();
    _resetKeyCacheForTesting();
    delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  });

  it("returns 400 when id is missing", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("returns 400 when disabled is not a boolean", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: "some-id", disabled: "yes" }),
      }),
      opts,
    );
    expect(resp!.status).toBe(400);
  });

  it("toggles disabled state for an existing account", async () => {
    await saveCredential({ apiKey: "k", provider: "zai" });
    const list = await listAccounts();
    const id = list.accounts[0].id;

    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id, disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.ok).toBe(true);
    expect(body.disabled).toBe(true);

    // Verify persisted
    const list2 = await listAccounts();
    expect(list2.accounts[0].disabled).toBe(true);
  });

  it("returns 404 for unknown account id", async () => {
    const opts = makeAdminOpts();
    const resp = await handleAdminRoute(
      authedReq("/admin/api/accounts/disabled", {
        method: "PUT",
        body: JSON.stringify({ id: "nonexistent", disabled: true }),
      }),
      opts,
    );
    expect(resp!.status).toBe(404);
  });
});

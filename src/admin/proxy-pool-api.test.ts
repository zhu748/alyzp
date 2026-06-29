/**
 * Integration tests for the proxy pool admin API endpoints.
 *
 * These tests exercise the full HTTP route path (server → admin/api.ts →
 * proxy-pool.ts) for the new /admin/api/proxy-pool/* endpoints.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { createFetchHandler } from "../server/server.js";
import { loadConfig } from "../config/loader.js";
import { AuthManager } from "../auth/manager.js";
import { _resetForTesting, _poolFilePath } from "../proxy/proxy-pool.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Use a temp store dir for tests so we don't touch the user's real store.
const TEST_STORE_DIR = mkdtempSync(join(tmpdir(), "zcode-proxy-test-"));
process.env.ZCODE_PROXY_STORE_DIR = TEST_STORE_DIR;

// Build a minimal config for the test server.
const config = loadConfig("./config.example.yaml");
config.auth.proxyApiKey = "test-key";
const auth = new AuthManager({
  mode: "apikey",
  apiKey: "test-api-key.test-secret",
  provider: "zai",
});

const handler = createFetchHandler({
  config,
  auth,
  configPath: TEST_STORE_DIR + "/config.yaml",
});

const authHeaders = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

function cleanupPoolFile() {
  const poolFile = _poolFilePath();
  if (existsSync(poolFile)) {
    try { unlinkSync(poolFile); } catch { /* ignore */ }
  }
  _resetForTesting();
}

beforeEach(() => {
  cleanupPoolFile();
});

afterEach(() => {
  cleanupPoolFile();
});

test("GET /admin/api/proxy-pool returns default config + empty pool", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.config.enabled).toBe(false);
  expect(data.config.refreshIntervalMin).toBe(5);
  expect(data.config.sourceUrls).toEqual([]);
  expect(data.proxies).toEqual([]);
});

test("PUT /admin/api/proxy-pool/config updates config", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      enabled: true,
      refreshIntervalMin: 10,
      sourceUrls: ["https://example.com/list.txt"],
    }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.config.enabled).toBe(true);
  expect(data.config.refreshIntervalMin).toBe(10);
  expect(data.config.sourceUrls).toEqual(["https://example.com/list.txt"]);
});

test("PUT /admin/api/proxy-pool/config rejects invalid source URL", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/config", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      sourceUrls: ["not-a-url"],
    }),
  }));
  expect(resp.status).toBe(400);
});

test("POST /admin/api/proxy-pool/import-text imports proxies", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      // "not a url" is rejected (contains space). Comment is skipped.
      text: "1.2.3.4:8080\n5.6.7.8:3128\n# comment\nnot a valid url with space",
    }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.added).toBe(2);
  expect(data.total).toBe(2);
});

test("POST /admin/api/proxy-pool/import-text requires text field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({}),
  }));
  expect(resp.status).toBe(400);
});

test("POST /admin/api/proxy-pool/clear empties the pool", async () => {
  // First add some proxies.
  await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080\n5.6.7.8:3128" }),
  }));
  // Then clear.
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/clear", {
    method: "POST",
    headers: authHeaders,
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);
  expect(data.removed).toBe(2);

  // Verify the pool is empty.
  const state = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  expect(stateData.proxies).toEqual([]);
});

test("DELETE /admin/api/proxy-pool/proxy removes a single entry", async () => {
  // Add 2 proxies.
  await handler(new Request("http://x/admin/api/proxy-pool/import-text", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: "1.2.3.4:8080\n5.6.7.8:3128" }),
  }));
  // Get the pool state to find an id.
  const state = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData = await state.json();
  const idToRemove = stateData.proxies[0].id;

  // Delete it.
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/proxy", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ id: idToRemove }),
  }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.ok).toBe(true);

  // Verify the pool now has 1 entry.
  const state2 = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  const stateData2 = await state2.json();
  expect(stateData2.proxies).toHaveLength(1);
});

test("DELETE /admin/api/proxy-pool/proxy returns 404 for unknown id", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/proxy", {
    method: "DELETE",
    headers: authHeaders,
    body: JSON.stringify({ id: "nonexistent" }),
  }));
  expect(resp.status).toBe(404);
});

test("Proxy pool endpoints require auth", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool"));
  // Without auth (and with proxyApiKey configured), should be 401.
  expect(resp.status).toBe(401);
});

test("POST /admin/api/proxy-pool/test-one returns 404 for unknown id", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ id: "nonexistent" }),
  }));
  expect(resp.status).toBe(404);
});

test("POST /admin/api/proxy-pool/test-one requires id field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool/test-one", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({}),
  }));
  expect(resp.status).toBe(400);
});

test("GET /admin/api/proxy-pool returns currentWorkingProxy field", async () => {
  const resp = await handler(new Request("http://x/admin/api/proxy-pool", { headers: authHeaders }));
  expect(resp.status).toBe(200);
  const data = await resp.json();
  expect(data.currentWorkingProxy).toBeNull(); // no proxy picked yet
});

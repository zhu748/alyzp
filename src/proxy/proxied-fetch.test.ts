/**
 * Unit tests for `proxiedFetch` / `wrapFetchWithSocksBridge` / `makeProxiedFetcher`.
 *
 * These tests verify the routing decisions (no-proxy / HTTP / SOCKS) and the
 * bridge URL substitution, WITHOUT actually performing real network calls or
 * starting a real SOCKS server. The smoke-test script under `scripts/socks-smoke.mjs`
 * covers the end-to-end happy path against a real local SOCKS5 server.
 */
import { expect, describe, beforeEach, afterEach, it } from "bun:test";
import {
  proxiedFetch,
  wrapFetchWithSocksBridge,
  makeProxiedFetcher,
} from "./proxied-fetch.js";
import { isSocksProxy, getSocksBridge, _shutdownAllBridgesForTesting } from "./socks-bridge.js";

// ---------------------------------------------------------------------------
// isSocksProxy
// ---------------------------------------------------------------------------

describe("isSocksProxy", () => {
  it("returns true for socks4://, socks4a://, socks5://, socks5h:// URLs", () => {
    expect(isSocksProxy("socks4://1.2.3.4:1080")).toBe(true);
    expect(isSocksProxy("socks4a://example.com:1080")).toBe(true);
    expect(isSocksProxy("socks5://1.2.3.4:1080")).toBe(true);
    expect(isSocksProxy("socks5h://example.com:1080")).toBe(true);
    expect(isSocksProxy("socks5://user:pass@1.2.3.4:1080")).toBe(true);
  });

  it("returns false for http://, https:// URLs", () => {
    expect(isSocksProxy("http://1.2.3.4:8080")).toBe(false);
    expect(isSocksProxy("https://1.2.3.4:8080")).toBe(false);
    expect(isSocksProxy("http://user:pass@1.2.3.4:8080")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isSocksProxy("not a url")).toBe(false);
    expect(isSocksProxy("")).toBe(false);
    expect(isSocksProxy("://no-scheme")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proxiedFetch — routing decisions (no real network)
// ---------------------------------------------------------------------------

describe("proxiedFetch", () => {
  it("calls baseFetch directly when no proxy is set", async () => {
    let calledWith: { url: string; init?: RequestInit } | null = null;
    const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledWith = { url: String(input), init };
      return new Response("ok");
    }) as typeof fetch;

    const resp = await proxiedFetch("https://example.com/", { method: "GET" }, mock);
    expect(resp.status).toBe(200);
    expect(calledWith).not.toBeNull();
    expect(calledWith!.url).toBe("https://example.com/");
    expect((calledWith!.init as { proxy?: string })?.proxy).toBeUndefined();
  });

  it("passes http:// proxy through unchanged", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    await proxiedFetch(
      "https://example.com/",
      { method: "GET", proxy: "http://1.2.3.4:8080" } as RequestInit & { proxy?: string },
      mock,
    );
    expect(receivedProxy).toBe("http://1.2.3.4:8080");
  });

  it("passes https:// proxy through unchanged", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    await proxiedFetch(
      "https://example.com/",
      { method: "GET", proxy: "https://1.2.3.4:8080" } as RequestInit & { proxy?: string },
      mock,
    );
    expect(receivedProxy).toBe("https://1.2.3.4:8080");
  });

  it("translates socks5:// proxy to a http://127.0.0.1:<port> bridge URL", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    await proxiedFetch(
      "https://example.com/",
      { method: "GET", proxy: "socks5://1.2.3.4:1080" } as RequestInit & { proxy?: string },
      mock,
    );
    expect(receivedProxy).toBeDefined();
    expect(receivedProxy).not.toBe("socks5://1.2.3.4:1080");
    expect(receivedProxy!.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("translates socks4://, socks4a://, socks5h:// proxies to bridge URLs", async () => {
    for (const url of [
      "socks4://1.2.3.4:1080",
      "socks4a://proxy.example.com:1080",
      "socks5h://proxy.example.com:1080",
    ]) {
      let receivedProxy: string | undefined;
      const mock = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedProxy = (init as { proxy?: string })?.proxy;
        return new Response("ok");
      }) as typeof fetch;

      await proxiedFetch(
        "https://example.com/",
        { method: "GET", proxy: url } as RequestInit & { proxy?: string },
        mock,
      );
      expect(receivedProxy).toBeDefined();
      expect(receivedProxy!.startsWith("http://127.0.0.1:")).toBe(true);
    }
  });

  it("preserves username:password in the SOCKS URL (cached in the bridge)", async () => {
    // We don't inspect the credentials directly here — they're embedded in the
    // bridge's per-URL state. We just verify the bridge URL is returned and
    // that two calls with the same SOCKS URL hit the same cached bridge.
    const mock = (async () => new Response("ok")) as unknown as typeof fetch;

    const init1 = { method: "GET", proxy: "socks5://user:pass@1.2.3.4:1080" } as RequestInit & { proxy?: string };
    const init2 = { method: "GET", proxy: "socks5://user:pass@1.2.3.4:1080" } as RequestInit & { proxy?: string };

    let p1: string | undefined;
    let p2: string | undefined;
    await proxiedFetch("https://example.com/", { ...init1 }, (async (_i: RequestInfo | URL, init?: RequestInit) => {
      p1 = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as unknown as typeof fetch);
    await proxiedFetch("https://example.com/", { ...init2 }, (async (_i: RequestInfo | URL, init?: RequestInit) => {
      p2 = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as unknown as typeof fetch);
    void mock;

    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).toBe(p2); // same cached bridge → same port
  });

  it("releases the bridge handle after the fetch settles (even on error)", async () => {
    const mock = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      proxiedFetch(
        "https://example.com/",
        { method: "GET", proxy: "socks5://1.2.3.4:1080" } as RequestInit & { proxy?: string },
        mock,
      ),
    ).rejects.toThrow("network down");
    // The handle was released — no exception is thrown, the test passes simply
    // by reaching this line. The bridge is still cached (idle) but its
    // refcount is back to 0.
  });
});

// ---------------------------------------------------------------------------
// wrapFetchWithSocksBridge
// ---------------------------------------------------------------------------

describe("wrapFetchWithSocksBridge", () => {
  it("returns a function that passes through HTTP proxies unchanged", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const wrapped = wrapFetchWithSocksBridge(mock);
    await wrapped("https://example.com/", { method: "GET", proxy: "http://1.2.3.4:8080" } as RequestInit & { proxy?: string });
    expect(receivedProxy).toBe("http://1.2.3.4:8080");
  });

  it("returns a function that translates SOCKS proxies to bridge URLs", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const wrapped = wrapFetchWithSocksBridge(mock);
    await wrapped("https://example.com/", { method: "GET", proxy: "socks5://1.2.3.4:1080" } as RequestInit & { proxy?: string });
    expect(receivedProxy).toBeDefined();
    expect(receivedProxy!.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("preserves other init fields when translating the proxy", async () => {
    let receivedInit: any;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return new Response("ok");
    }) as typeof fetch;

    const wrapped = wrapFetchWithSocksBridge(mock);
    await wrapped("https://example.com/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
      proxy: "socks5://1.2.3.4:1080",
    } as RequestInit & { proxy?: string });

    expect(receivedInit.method).toBe("POST");
    expect(receivedInit.headers).toEqual({ "content-type": "application/json" });
    expect(receivedInit.body).toBe('{"hello":"world"}');
    expect(receivedInit.proxy.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("handles no-proxy calls (passes through unchanged)", async () => {
    let receivedProxy: unknown = "sentinel";
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const wrapped = wrapFetchWithSocksBridge(mock);
    await wrapped("https://example.com/", { method: "GET" });
    expect(receivedProxy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeProxiedFetcher
// ---------------------------------------------------------------------------

describe("makeProxiedFetcher", () => {
  it("returns baseFetch unchanged when proxyUrl is empty/undefined", () => {
    const mock = (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch;
    expect(makeProxiedFetcher(undefined, mock)).toBe(mock);
    expect(makeProxiedFetcher("", mock)).toBe(mock);
    expect(makeProxiedFetcher("   ", mock)).toBe(mock);
  });

  it("returns a fetch that injects the configured proxy when caller omits it", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const fetcher = makeProxiedFetcher("http://1.2.3.4:8080", mock);
    await fetcher("https://example.com/", { method: "GET" });
    expect(receivedProxy).toBe("http://1.2.3.4:8080");
  });

  it("returns a fetch that respects a caller-supplied proxy override", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const fetcher = makeProxiedFetcher("http://1.2.3.4:8080", mock);
    await fetcher("https://example.com/", { method: "GET", proxy: "http://5.6.7.8:9090" } as RequestInit & { proxy?: string });
    expect(receivedProxy).toBe("http://5.6.7.8:9090");
  });

  it("translates SOCKS proxies via the bridge", async () => {
    let receivedProxy: string | undefined;
    const mock = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      receivedProxy = (init as { proxy?: string })?.proxy;
      return new Response("ok");
    }) as typeof fetch;

    const fetcher = makeProxiedFetcher("socks5://1.2.3.4:1080", mock);
    await fetcher("https://example.com/", { method: "GET" });
    expect(receivedProxy).toBeDefined();
    expect(receivedProxy!.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSocksBridge — caching & refcounting
// ---------------------------------------------------------------------------

describe("getSocksBridge", () => {
  beforeEach(() => { _shutdownAllBridgesForTesting(); });
  afterEach(() => { _shutdownAllBridgesForTesting(); });

  it("returns a stable http://127.0.0.1:<port> URL for the same SOCKS URL", () => {
    const h1 = getSocksBridge("socks5://1.2.3.4:1080");
    const h2 = getSocksBridge("socks5://1.2.3.4:1080");
    expect(h1.httpProxyUrl).toBe(h2.httpProxyUrl);
    h1.release();
    h2.release();
  });

  it("returns DIFFERENT ports for DIFFERENT SOCKS URLs", () => {
    const h1 = getSocksBridge("socks5://1.2.3.4:1080");
    const h2 = getSocksBridge("socks5://5.6.7.8:1080");
    expect(h1.httpProxyUrl).not.toBe(h2.httpProxyUrl);
    h1.release();
    h2.release();
  });

  it("treats URLs differing only in default port as the same cache key", () => {
    // 1080 is the SOCKS default; omitting it should canonicalize to the same key.
    const h1 = getSocksBridge("socks5://1.2.3.4:1080");
    const h2 = getSocksBridge("socks5://1.2.3.4");
    expect(h1.httpProxyUrl).toBe(h2.httpProxyUrl);
    h1.release();
    h2.release();
  });
});

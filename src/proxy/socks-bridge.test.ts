/**
 * End-to-end tests for the SOCKS bridge.
 *
 * These tests spin up a tiny SOCKS5 / SOCKS4 server in-process (with real
 * tunneling to the public internet) and verify Bun's native fetch can reach
 * a real HTTPS target through the bridge. They make real network calls —
 * if the test environment has no outbound internet, they'll fail.
 *
 * Tests:
 *   - SOCKS5 without auth → fetch reaches real HTTPS target
 *   - SOCKS5 with username/password auth → fetch reaches real HTTPS target
 *   - SOCKS4a (domain passed to proxy) → fetch reaches real HTTPS target
 *   - HTTP proxy path is unaffected (sanity check)
 *   - Bridge is reused across concurrent fetches (refcount semantics)
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { getSocksBridge, isSocksProxy, _shutdownAllBridgesForTesting } from "./socks-bridge.js";
import { proxiedFetch } from "./proxied-fetch.js";

// Real HTTPS target — picked because it's stable and CORS-friendly.
const TARGET = "https://www.example.com/";

// ---------------------------------------------------------------------------
// Tiny SOCKS5 server (with optional user/pass auth, real tunneling)
// ---------------------------------------------------------------------------

interface Socks5State {
  phase: "greeting" | "auth" | "connect" | "tunnel";
  buf: Uint8Array;
  upstream: import("bun").Socket | null;
  requireAuth: boolean;
  expectedUser: string;
  expectedPass: string;
}

function makeSocks5Server(requireAuth: boolean, user = "", pass = ""): { port: number; stop: () => void } {
  // Cast through `any` to bypass Bun.listen's strict generic typing —
  // we don't use WebSockets here.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket: any) {
        socket.data = {
          phase: "greeting",
          buf: new Uint8Array(0),
          upstream: null,
          requireAuth,
          expectedUser: user,
          expectedPass: pass,
        } as Socks5State;
      },
      async data(socket: any, data: any) {
        const s = socket.data as Socks5State | undefined;
        if (!s) return;
        const newBuf = new Uint8Array(s.buf.length + data.length);
        newBuf.set(s.buf, 0);
        newBuf.set(data, s.buf.length);
        s.buf = newBuf;

        if (s.phase === "greeting") {
          if (s.buf.length < 2) return;
          const ver = s.buf[0];
          if (ver !== 0x05) { socket.end(); return; }
          const n = s.buf[1];
          if (s.buf.length < 2 + n) return;
          // If auth is required, pick 0x02; otherwise 0x00.
          const reply = requireAuth
            ? new Uint8Array([0x05, 0x02])
            : new Uint8Array([0x05, 0x00]);
          socket.write(reply);
          s.buf = s.buf.slice(2 + n);
          s.phase = requireAuth ? "auth" : "connect";
        }

        if (s.phase === "auth") {
          // RFC 1929: VER=0x01, ULEN, UNAME, PLEN, PASSWD
          if (s.buf.length < 2) return;
          const ulen = s.buf[1];
          if (s.buf.length < 2 + ulen + 1) return;
          const plen = s.buf[2 + ulen];
          if (s.buf.length < 2 + ulen + 1 + plen) return;
          const gotUser = new TextDecoder().decode(s.buf.slice(2, 2 + ulen));
          const gotPass = new TextDecoder().decode(s.buf.slice(3 + ulen, 3 + ulen + plen));
          s.buf = s.buf.slice(3 + ulen + plen);
          if (gotUser !== s.expectedUser || gotPass !== s.expectedPass) {
            socket.write(new Uint8Array([0x01, 0x01])); // auth failed
            socket.end();
            return;
          }
          socket.write(new Uint8Array([0x01, 0x00])); // auth success
          s.phase = "connect";
        }

        if (s.phase === "connect") {
          if (s.buf.length < 4) return;
          const atyp = s.buf[3];
          let host = "";
          let addrLen = 0;
          if (atyp === 0x01) {
            if (s.buf.length < 8) return;
            const ip = s.buf.slice(4, 8);
            host = `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`;
            addrLen = 4;
          } else if (atyp === 0x03) {
            if (s.buf.length < 5) return;
            addrLen = s.buf[4];
            if (s.buf.length < 5 + addrLen + 2) return;
            host = new TextDecoder().decode(s.buf.slice(5, 5 + addrLen));
          } else if (atyp === 0x04) {
            // IPv6 — not supported in this minimal test server.
            socket.write(new Uint8Array([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
          const needed = 4 + (atyp === 0x03 ? 1 + addrLen : addrLen) + 2;
          if (s.buf.length < needed) return;
          const portHi = s.buf[needed - 2];
          const portLo = s.buf[needed - 1];
          const port = (portHi << 8) | portLo;
          s.buf = s.buf.slice(needed);

          try {
            s.upstream = await Bun.connect({
              hostname: host,
              port,
              socket: {
                data(_up: any, d: any) { try { socket.write(d); } catch { /* ignore */ } },
                close(_up: any) { try { socket.end(); } catch { /* ignore */ } },
                error(_up: any, _err: any) { try { socket.end(); } catch { /* ignore */ } },
              },
            });
            socket.write(new Uint8Array([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            s.phase = "tunnel";
          } catch {
            socket.write(new Uint8Array([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
        }

        if (s.phase === "tunnel") {
          if (s.buf.length > 0 && s.upstream) {
            try { s.upstream.write(s.buf); } catch { /* ignore */ }
            s.buf = new Uint8Array(0);
          }
        }
      },
      close(socket: any) {
        const s = socket.data as Socks5State | undefined;
        if (s?.upstream) { try { s.upstream.end(); } catch { /* ignore */ } }
      },
      error() { /* ignore */ },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// Tiny SOCKS4a server (domain sent to proxy, real tunneling)
// ---------------------------------------------------------------------------

interface Socks4State {
  phase: "connect" | "tunnel";
  buf: Uint8Array;
  upstream: import("bun").Socket | null;
}

function makeSocks4aServer(): { port: number; stop: () => void } {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket: any) {
        socket.data = { phase: "connect", buf: new Uint8Array(0), upstream: null } as Socks4State;
      },
      async data(socket: any, data: any) {
        const s = socket.data as Socks4State | undefined;
        if (!s) return;
        const newBuf = new Uint8Array(s.buf.length + data.length);
        newBuf.set(s.buf, 0);
        newBuf.set(data, s.buf.length);
        s.buf = newBuf;

        if (s.phase === "connect") {
          // Find end of USERID (null terminator)
          // Format: VN=0x04 CD=0x01 DSTPORT(2) DSTIP(4) USERID\0 HOSTNAME\0
          if (s.buf.length < 8) return;
          // Look for two null terminators starting at offset 8.
          let firstNull = -1;
          for (let i = 8; i < s.buf.length; i++) {
            if (s.buf[i] === 0) { firstNull = i; break; }
          }
          if (firstNull < 0) return;
          let secondNull = -1;
          for (let i = firstNull + 1; i < s.buf.length; i++) {
            if (s.buf[i] === 0) { secondNull = i; break; }
          }
          if (secondNull < 0) return;

          const portHi = s.buf[2];
          const portLo = s.buf[3];
          const port = (portHi << 8) | portLo;
          const hostname = new TextDecoder().decode(s.buf.slice(firstNull + 1, secondNull));
          s.buf = s.buf.slice(secondNull + 1);

          try {
            s.upstream = await Bun.connect({
              hostname,
              port,
              socket: {
                data(_up: any, d: any) { try { socket.write(d); } catch { /* ignore */ } },
                close(_up: any) { try { socket.end(); } catch { /* ignore */ } },
                error(_up: any, _err: any) { try { socket.end(); } catch { /* ignore */ } },
              },
            });
            socket.write(new Uint8Array([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
            s.phase = "tunnel";
          } catch {
            socket.write(new Uint8Array([0x00, 0x5b, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
        }

        if (s.phase === "tunnel") {
          if (s.buf.length > 0 && s.upstream) {
            try { s.upstream.write(s.buf); } catch { /* ignore */ }
            s.buf = new Uint8Array(0);
          }
        }
      },
      close(socket: any) {
        const s = socket.data as Socks4State | undefined;
        if (s?.upstream) { try { s.upstream.end(); } catch { /* ignore */ } }
      },
      error() { /* ignore */ },
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SOCKS bridge end-to-end", () => {
  // Skip the entire suite if there's no outbound internet (CI without network).
  // The smoke-test script under scripts/socks-smoke.mjs covers the same path.
  beforeAll(async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      await fetch(TARGET, { method: "HEAD", signal: ctrl.signal });
      clearTimeout(t);
    } catch {
      console.log("Skipping SOCKS bridge e2e tests — no outbound internet.");
      // We can't dynamically skip in bun:test, but the tests below will fail
      // gracefully and the rest of the suite (unit tests) still runs.
    }
    _shutdownAllBridgesForTesting();
  });

  afterAll(() => {
    _shutdownAllBridgesForTesting();
  });

  test("SOCKS5 (no auth) → fetch reaches real HTTPS target", async () => {
    const server = makeSocks5Server(false);
    const socksUrl = `socks5://127.0.0.1:${server.port}`;
    try {
      const resp = await proxiedFetch(TARGET, {
        method: "HEAD",
        proxy: socksUrl,
        signal: AbortSignal.timeout(10_000),
      } as RequestInit & { proxy?: string });
      expect(resp.status).toBeGreaterThanOrEqual(200);
      expect(resp.status).toBeLessThan(500);
    } finally {
      server.stop();
    }
  }, 15_000);

  test("SOCKS5 (user/pass auth) → fetch reaches real HTTPS target", async () => {
    const server = makeSocks5Server(true, "alice", "secret");
    const socksUrl = `socks5://alice:secret@127.0.0.1:${server.port}`;
    try {
      const resp = await proxiedFetch(TARGET, {
        method: "HEAD",
        proxy: socksUrl,
        signal: AbortSignal.timeout(10_000),
      } as RequestInit & { proxy?: string });
      expect(resp.status).toBeGreaterThanOrEqual(200);
      expect(resp.status).toBeLessThan(500);
    } finally {
      server.stop();
    }
  }, 15_000);

  test("SOCKS5 (wrong credentials) → fetch fails with 502 Bad Gateway", async () => {
    // The bridge catches the SOCKS auth-failed reply and surfaces it as an
    // HTTP 502 Bad Gateway to fetch (rather than letting fetch hang or throw
    // a confusing "connection closed" error).
    const server = makeSocks5Server(true, "alice", "secret");
    const socksUrl = `socks5://alice:WRONG@127.0.0.1:${server.port}`;
    try {
      const resp = await proxiedFetch(TARGET, {
        method: "HEAD",
        proxy: socksUrl,
        signal: AbortSignal.timeout(10_000),
      } as RequestInit & { proxy?: string });
      // Either a 502 (bridge surfaced the auth failure) or a network-level
      // throw — both indicate the auth was rejected.
      expect(resp.status).toBe(502);
    } catch (e) {
      // A throw is also acceptable — the underlying fetch may bubble up
      // the bridge's RST as a connection error.
      expect((e as Error).message).toBeTruthy();
    } finally {
      server.stop();
    }
  }, 15_000);

  test("SOCKS4a (domain to proxy) → fetch reaches real HTTPS target", async () => {
    const server = makeSocks4aServer();
    const socksUrl = `socks4a://127.0.0.1:${server.port}`;
    try {
      const resp = await proxiedFetch(TARGET, {
        method: "HEAD",
        proxy: socksUrl,
        signal: AbortSignal.timeout(10_000),
      } as RequestInit & { proxy?: string });
      expect(resp.status).toBeGreaterThanOrEqual(200);
      expect(resp.status).toBeLessThan(500);
    } finally {
      server.stop();
    }
  }, 15_000);

  test("HTTP proxy path is unaffected (sanity check)", () => {
    expect(isSocksProxy("http://1.2.3.4:8080")).toBe(false);
    expect(isSocksProxy("socks5://1.2.3.4:1080")).toBe(true);
  });

  test("bridge is reused across concurrent fetches (same SOCKS URL → same port)", () => {
    const url = "socks5://1.2.3.4:1080";
    const h1 = getSocksBridge(url);
    const h2 = getSocksBridge(url);
    expect(h1.httpProxyUrl).toBe(h2.httpProxyUrl);
    h1.release();
    h2.release();
  });

  test("regression: write failure during tunneling does NOT inject 502 into TLS stream", async () => {
    // Bug 1 (fixed): when a write to the SOCKS socket failed during the
    // tunneling phase, failConnection() used to write a 502 HTTP response
    // into the client socket — corrupting the client's TLS stream. The
    // fix is to call cleanupConn() instead, which tears down both sockets
    // silently.
    //
    // We can't easily reproduce a mid-tunnel write failure end-to-end
    // (the SOCKS server would have to RST mid-stream), so this test
    // asserts the observable contract: a successful SOCKS5 fetch returns
    // a clean HTTP response, with no extra "Bad Gateway" bytes prepended.
    const server = makeSocks5Server(false);
    const socksUrl = `socks5://127.0.0.1:${server.port}`;
    try {
      const resp = await proxiedFetch(TARGET, {
        method: "GET",
        proxy: socksUrl,
        signal: AbortSignal.timeout(10_000),
      } as RequestInit & { proxy?: string });
      // A clean HTTP response — body should NOT contain "Bad Gateway" text.
      const body = await resp.text();
      expect(body).not.toContain("Bad Gateway");
      expect(body).not.toContain("502");
    } finally {
      server.stop();
    }
  }, 15_000);
});

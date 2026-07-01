/**
 * Local HTTP-CONNECT → SOCKS bridge.
 *
 * Background
 * ----------
 * Bun's native `fetch(url, { proxy })` ONLY supports HTTP/HTTPS proxies. For
 * `socks4://`, `socks4a://`, `socks5://`, `socks5h://` URLs Bun throws:
 *
 *     UnsupportedProxyProtocol fetching "https://api.z.ai/". For more
 *     information, pass `verbose: true` in the second argument to fetch()
 *
 * …which is exactly the error the operator saw when testing SOCKS proxies in
 * the dashboard. Without this bridge, the entire SOCKS4/SOCKS5 feature
 * surface (per-account `cred.proxy` AND the global proxy pool entries with
 * a SOCKS scheme) was effectively dead.
 *
 * How it works
 * ------------
 * We spawn a tiny local HTTP proxy (Bun.listen on 127.0.0.1, OS-assigned
 * port) that ONLY understands the CONNECT method. When fetch opens a
 * tunnel through it:
 *
 *   1. The bridge reads the client's `CONNECT host:port HTTP/1.1` request.
 *   2. It opens a TCP connection to the configured SOCKS proxy.
 *   3. It performs the SOCKS handshake (4 / 4a / 5 / 5h, optional auth).
 *   4. It replies `HTTP/1.1 200 Connection Established\r\n\r\n` to fetch.
 *   5. From that point it just pipes bytes — fetch itself does the TLS
 *      handshake against the target host and sends the real HTTP request
 *      inside the tunnel.
 *
 * This lets us reuse Bun's native fetch (with all its TLS / HTTP/2 / streaming
 * goodness) for SOCKS proxies with zero changes to call sites — they just
 * pass `http://127.0.0.1:<port>` as the `proxy` option instead of the
 * original `socks5://...` URL.
 *
 * Bridge reuse & lifecycle
 * ------------------------
 * Bridges are refcounted per SOCKS URL: 100 concurrent fetches through the
 * same SOCKS proxy share a single local listener. When the last caller
 * releases, the listener is kept alive for `IDLE_TIMEOUT_MS` (60s) so back-
 * to-back requests don't pay the listen/stop cost; after that it's stopped.
 *
 * The bridge is process-local (127.0.0.1) and binds to port 0 (random),
 * so it is never reachable from the network.
 */

// -------------------------------------------------------------------------------------------------
// Types & helpers
// -------------------------------------------------------------------------------------------------

/** A handle returned by `getSocksBridge` — call `release()` when done. */
export interface SocksBridgeHandle {
  /** The http://127.0.0.1:<port> URL to pass as `proxy` to Bun's fetch. */
  httpProxyUrl: string;
  /** Decrement the refcount; the listener is closed once it reaches 0 (after an idle grace period). */
  release: () => void;
}

interface BridgeEntry {
  // Typed loosely because Bun's Server/Socket generic signatures are tricky
  // to satisfy without pulling in websockets. The runtime API is what matters.
  server: any;
  port: number;
  refCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** Idle grace period before a zero-refcount bridge is closed. */
const IDLE_TIMEOUT_MS = 60_000;

/** Per-connection timeout for the SOCKS handshake (ms). */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Set to true via ZCODE_PROXY_SOCKS_DEBUG=1 to enable per-connection logging. */
const DEBUG = process.env.ZCODE_PROXY_SOCKS_DEBUG === "1";

/** Tiny namespaced logger — no-op in production. */
function dbg(msg: string): void {
  if (DEBUG) console.log(`[socks-bridge] ${msg}`);
}

const bridges = new Map<string, BridgeEntry>();

/** Returns true if `url` is a SOCKS proxy URL (any of socks4/4a/5/5h). */
export function isSocksProxy(url: string): boolean {
  try {
    const proto = new URL(url).protocol.toLowerCase();
    return proto === "socks4:" || proto === "socks4a:" || proto === "socks5:" || proto === "socks5h:";
  } catch {
    return false;
  }
}

/** Subset of `Uint8Array` that's compatible with both Node Buffer and Uint8Array (what Bun gives us). */
type Bytes = Uint8Array;

/** Combine two byte arrays. */
function concatBytes(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Find a subsequence `match` inside `buf`, returns its start index or -1. */
function indexOfBytes(buf: Bytes, match: number[]): number {
  if (match.length === 0) return 0;
  if (buf.length < match.length) return -1;
  outer: for (let i = 0; i <= buf.length - match.length; i++) {
    for (let j = 0; j < match.length; j++) {
      if (buf[i + j] !== match[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// -------------------------------------------------------------------------------------------------
// Promise-based socket reader (used during the SOCKS handshake only)
// -------------------------------------------------------------------------------------------------

/**
 * Wraps a Bun socket's `data`/`close`/`error` events into Promise-based reads.
 * Used ONLY during the SOCKS handshake; once tunneling starts we switch to
 * raw callback piping.
 */
class SocketReader {
  private buffer: Bytes = new Uint8Array(0);
  private waiter: (() => void) | null = null;
  private err: Error | null = null;
  private closed = false;

  feed(data: Bytes): void {
    this.buffer = concatBytes(this.buffer, data);
    this.poke();
  }

  feedError(err: Error): void {
    this.err = err;
    this.poke();
  }

  feedClose(): void {
    this.closed = true;
    this.poke();
  }

  private poke(): void {
    if (this.waiter) {
      const cb = this.waiter;
      this.waiter = null;
      cb();
    }
  }

  private async waitForChange(): Promise<void> {
    if (this.err) throw this.err;
    if (this.closed && this.buffer.length === 0) throw new Error("socket closed");
    if (this.buffer.length > 0) return;
    await new Promise<void>((resolve) => { this.waiter = resolve; });
    if (this.err) throw this.err;
    if (this.closed && this.buffer.length === 0) throw new Error("socket closed");
  }

  /** Read exactly `n` bytes. */
  async readExactly(n: number): Promise<Bytes> {
    while (this.buffer.length < n) {
      await this.waitForChange();
    }
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  /** Read until `match` is found; return all bytes up to and including the match. */
  async readUntilMatch(match: number[]): Promise<Bytes> {
    for (;;) {
      const idx = indexOfBytes(this.buffer, match);
      if (idx >= 0) {
        const end = idx + match.length;
        const out = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return out;
      }
      await this.waitForChange();
    }
  }

  /** Return and clear any buffered bytes. */
  drain(): Bytes {
    const out = this.buffer;
    this.buffer = new Uint8Array(0);
    return out;
  }
}

// -------------------------------------------------------------------------------------------------
// Per-connection state
// -------------------------------------------------------------------------------------------------

interface ConnState {
  /** The client socket (Bun fetch side). Typed loosely — see BridgeEntry note. */
  clientSocket: any | null;
  /** The SOCKS-side socket. Typed loosely — see BridgeEntry note. */
  socksSocket: any | null;
  /** Promise-based reader wrapping the SOCKS socket. */
  socksReader: SocketReader;
  /** Phase of the bridge state machine. */
  phase: "read-connect" | "socks-handshake" | "tunneling" | "closing";
  /** Buffer accumulating bytes from the client before the CONNECT line is complete. */
  clientPreBuffer: Bytes;
  /** Parsed target host (from CONNECT line). */
  targetHost: string;
  /** Parsed target port (from CONNECT line). */
  targetPort: number;
  /** The originating SOCKS URL (for logging). */
  socksUrlString: string;
  /** Per-connection handshake timeout. */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

// -------------------------------------------------------------------------------------------------
// Bun socket handlers
// -------------------------------------------------------------------------------------------------

/**
 * Open a SOCKS bridge listener for the given SOCKS URL. Returns a handle whose
 * `httpProxyUrl` should be passed to `fetch(url, { proxy })`.
 */
export function getSocksBridge(socksUrl: string): SocksBridgeHandle {
  // Normalize the URL for cache keying.
  const key = normalizeSocksUrl(socksUrl);
  const existing = bridges.get(key);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.refCount++;
    return {
      httpProxyUrl: `http://127.0.0.1:${existing.port}`,
      release: () => releaseBridge(key),
    };
  }

  // Parse the SOCKS URL once and stash it in the socket handler closures.
  const parsed = new URL(key);
  // We need a stable username/password for every connection through this bridge.
  const username = parsed.username ? decodeURIComponent(parsed.username) : "";
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  const scheme = parsed.protocol.replace(":", "").toLowerCase();

  // Bun.listen's socket handler is shared across all connections. Per-connection
  // state lives on `socket.data` (typed via the generic param).
  const server = Bun.listen<ConnState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const state: ConnState = {
          clientSocket: socket,
          socksSocket: null,
          socksReader: new SocketReader(),
          phase: "read-connect",
          clientPreBuffer: new Uint8Array(0),
          targetHost: "",
          targetPort: 0,
          socksUrlString: key,
          handshakeTimer: setTimeout(() => onHandshakeTimeout(state), HANDSHAKE_TIMEOUT_MS),
        };
        socket.data = state;
      },
      data(socket, data) {
        const state = socket.data;
        if (!state) return;
        onClientData(state, data, scheme, parsed.hostname, parsedPort(parsed), username, password);
      },
      close(socket) {
        const state = socket.data;
        if (!state) return;
        state.clientSocket = null;
        cleanupConn(state);
      },
      error(socket, _err) {
        const state = socket.data;
        if (!state) return;
        try { socket.end(); } catch { /* ignore */ }
        cleanupConn(state);
      },
    },
  });

  const entry: BridgeEntry = {
    server,
    port: server.port,
    refCount: 1,
    idleTimer: null,
  };
  bridges.set(key, entry);
  dbg(`bridge created for ${key} on 127.0.0.1:${server.port}`);

  return {
    httpProxyUrl: `http://127.0.0.1:${server.port}`,
    release: () => releaseBridge(key),
  };
}

/** Normalize a SOCKS URL for cache keying (strips nothing — just canonicalizes). */
function normalizeSocksUrl(url: string): string {
  const u = new URL(url);
  // Force default port 1080 if omitted (typical for SOCKS).
  if (!u.port) u.port = "1080";
  return u.toString();
}

/** Parse the port from a URL, defaulting to 1080 (typical SOCKS port). */
function parsedPort(u: URL): number {
  return u.port ? parseInt(u.port, 10) : 1080;
}

function releaseBridge(key: string): void {
  const entry = bridges.get(key);
  if (!entry) return;
  entry.refCount--;
  dbg(`release: ${key} refCount=${entry.refCount}`);
  if (entry.refCount <= 0) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const e = bridges.get(key);
      if (e && e.refCount <= 0) {
        try { e.server.stop(true); } catch { /* ignore */ }
        bridges.delete(key);
        dbg(`bridge idle-evicted for ${key}`);
      }
    }, IDLE_TIMEOUT_MS);
  }
}

/** Force-close all bridges (used by tests). */
export function _shutdownAllBridgesForTesting(): void {
  for (const [, entry] of bridges) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.server.stop(true); } catch { /* ignore */ }
  }
  bridges.clear();
}

// -------------------------------------------------------------------------------------------------
// Per-connection logic
// -------------------------------------------------------------------------------------------------

function onHandshakeTimeout(state: ConnState): void {
  if (state.phase === "tunneling") return;
  if (state.phase === "closing") return;
  failConnection(state, "SOCKS handshake timed out");
}

function onClientData(
  state: ConnState,
  data: Bytes,
  scheme: string,
  socksHost: string,
  socksPort: number,
  username: string,
  password: string,
): void {
  if (state.phase === "tunneling") {
    // After CONNECT has been acknowledged, all client bytes go straight to SOCKS.
    // NOTE: a write failure here must NOT call failConnection() — that would
    // write a 502 HTTP response into the already-established TLS tunnel,
    // corrupting the client's encrypted stream. Just tear down both sockets
    // silently.
    if (state.socksSocket) {
      try { state.socksSocket.write(data); } catch { cleanupConn(state); }
    } else {
      cleanupConn(state);
    }
    return;
  }

  if (state.phase === "read-connect") {
    // Accumulate until we see \r\n\r\n.
    state.clientPreBuffer = concatBytes(state.clientPreBuffer, data);
    // Cap the buffer at 8KB to prevent a malicious client from holding us in read-connect forever.
    if (state.clientPreBuffer.length > 8192) {
      failConnection(state, "CONNECT line too long");
      return;
    }
    const idx = indexOfBytes(state.clientPreBuffer, [13, 10, 13, 10]); // \r\n\r\n
    if (idx < 0) return;

    const head = state.clientPreBuffer.slice(0, idx);
    const leftover = state.clientPreBuffer.slice(idx + 4);
    state.clientPreBuffer = new Uint8Array(0);

    // Parse the CONNECT request.
    const headStr = new TextDecoder().decode(head);
    const lines = headStr.split("\r\n");
    const reqLine = lines[0] || "";
    // "CONNECT host:port HTTP/1.1"
    const m = /^CONNECT\s+(\S+)\s+HTTP\/\d\.\d$/i.exec(reqLine);
    if (!m) {
      failConnection(state, `bad CONNECT line: ${reqLine}`);
      return;
    }
    const target = m[1];
    // Strip surrounding brackets from IPv6 host.
    let host = target;
    let port = 443;
    if (target.startsWith("[")) {
      // [ipv6]:port
      const close = target.indexOf("]");
      if (close < 0) { failConnection(state, `bad IPv6 target: ${target}`); return; }
      host = target.slice(1, close);
      const rest = target.slice(close + 1);
      if (rest.startsWith(":")) port = parseInt(rest.slice(1), 10) || 443;
    } else {
      const colon = target.lastIndexOf(":");
      if (colon < 0) { failConnection(state, `bad target: ${target}`); return; }
      host = target.slice(0, colon);
      port = parseInt(target.slice(colon + 1), 10) || 443;
    }
    state.targetHost = host;
    state.targetPort = port;

    // Any bytes the client already sent after the CONNECT line (e.g. an
    // early TLS ClientHello) must be forwarded after the tunnel is up.
    state.clientPreBuffer = leftover;

    // Move to handshake phase and open the SOCKS connection.
    state.phase = "socks-handshake";
    dbg(`CONNECT ${host}:${port} → opening SOCKS tunnel via ${state.socksUrlString}`);
    openSocksTunnel(state, scheme, socksHost, socksPort, username, password);
    return;
  }

  // In socks-handshake phase: buffer client bytes — they'll be flushed once
  // the tunnel is up.
  state.clientPreBuffer = concatBytes(state.clientPreBuffer, data);
  // 8KB cap also applies here.
  if (state.clientPreBuffer.length > 8192) {
    failConnection(state, "client sent too much data before tunnel established");
  }
}

function openSocksTunnel(
  state: ConnState,
  scheme: string,
  socksHost: string,
  socksPort: number,
  username: string,
  password: string,
): void {
  try {
    Bun.connect<ConnState>({
      hostname: socksHost,
      port: socksPort,
      socket: {
        data(socket, data) {
          // socket.data should be `state` (set in open()). Feed the reader.
          const s = socket.data as ConnState | undefined;
          if (!s) return;
          if (s.phase === "tunneling") {
            // Forward to client.
            if (s.clientSocket) {
              try { s.clientSocket.write(data); } catch { /* ignore */ }
            }
            return;
          }
          s.socksReader.feed(data);
        },
        open(socket) {
          // Start the handshake. We attach `state` to socket.data so the
          // data handler can find it.
          socket.data = state;
          state.socksSocket = socket;
          runSocksHandshake(state, scheme, username, password).then(
            () => onHandshakeOk(state),
            (err) => failConnection(state, `SOCKS handshake failed: ${(err as Error).message}`),
          );
        },
        close(socket) {
          const s = socket.data as ConnState | undefined;
          if (!s) return;
          s.socksSocket = null;
          s.socksReader.feedClose();
          if (s.phase !== "tunneling") {
            failConnection(s, "SOCKS socket closed during handshake");
          } else {
            // Tunnel closed — close the client too.
            cleanupConn(s);
          }
        },
        error(socket, err) {
          const s = socket.data as ConnState | undefined;
          if (!s) return;
          s.socksReader.feedError(err);
          if (s.phase !== "tunneling") {
            failConnection(s, `SOCKS socket error: ${err.message}`);
          } else {
            cleanupConn(s);
          }
        },
      },
    }).catch((err: unknown) => {
      failConnection(state, `failed to connect to SOCKS proxy: ${(err as Error).message}`);
    });
  } catch (err) {
    failConnection(state, `failed to connect to SOCKS proxy: ${(err as Error).message}`);
  }
}

async function runSocksHandshake(
  state: ConnState,
  scheme: string,
  username: string,
  password: string,
): Promise<void> {
  switch (scheme) {
    case "socks5":
    case "socks5h":
      await socks5Handshake(state, username, password, scheme === "socks5h");
      break;
    case "socks4":
      await socks4Handshake(state, username, /* useDns */ false);
      break;
    case "socks4a":
      await socks4Handshake(state, username, /* useDns */ true);
      break;
    default:
      throw new Error(`unsupported SOCKS scheme: ${scheme}`);
  }
}

// -------------------------------------------------------------------------------------------------
// SOCKS5 handshake (RFC 1928 + RFC 1929 for user/pass auth)
// -------------------------------------------------------------------------------------------------

async function socks5Handshake(
  state: ConnState,
  username: string,
  password: string,
  useRemoteDns: boolean,
): Promise<void> {
  const hasAuth = username.length > 0 || password.length > 0;
  // Greeting: VER=0x05, NMETHODS, METHODS...
  //   0x00 = No authentication required
  //   0x02 = Username/password
  const greeting = hasAuth
    ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
    : new Uint8Array([0x05, 0x01, 0x00]);
  state.socksSocket!.write(greeting);

  // Response: VER=0x05, METHOD
  const resp = await state.socksReader.readExactly(2);
  if (resp[0] !== 0x05) throw new Error(`bad SOCKS5 version in greeting reply: ${resp[0]}`);
  const method = resp[1];
  if (method === 0xff) {
    throw new Error("SOCKS5 proxy rejected all authentication methods");
  }
  if (method === 0x02) {
    // Username/password auth (RFC 1929)
    if (!hasAuth) throw new Error("SOCKS5 proxy requires auth but none provided");
    const userBytes = new TextEncoder().encode(username);
    const passBytes = new TextEncoder().encode(password);
    if (userBytes.length > 255) throw new Error("SOCKS5 username too long (>255 bytes)");
    if (passBytes.length > 255) throw new Error("SOCKS5 password too long (>255 bytes)");
    const authReq = new Uint8Array(3 + userBytes.length + passBytes.length);
    authReq[0] = 0x01; // sub-negotiation version
    authReq[1] = userBytes.length;
    authReq.set(userBytes, 2);
    authReq[2 + userBytes.length] = passBytes.length;
    authReq.set(passBytes, 3 + userBytes.length);
    state.socksSocket!.write(authReq);
    const authResp = await state.socksReader.readExactly(2);
    if (authResp[0] !== 0x01) throw new Error(`bad SOCKS5 auth version: ${authResp[0]}`);
    if (authResp[1] !== 0x00) throw new Error("SOCKS5 auth failed (bad username/password)");
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 proxy selected unsupported method: ${method}`);
  }

  // CONNECT request.
  // ATYP: 0x01 = IPv4, 0x03 = domain, 0x04 = IPv6
  const req = buildSocks5ConnectRequest(state.targetHost, state.targetPort, useRemoteDns);
  state.socksSocket!.write(req);

  // Reply: VER, REP, RSV=0x00, ATYP, BND.ADDR, BND.PORT
  const repHead = await state.socksReader.readExactly(4);
  if (repHead[0] !== 0x05) throw new Error(`bad SOCKS5 version in connect reply: ${repHead[0]}`);
  if (repHead[1] !== 0x00) {
    throw new Error(`SOCKS5 connect failed: ${socks5ReplyCode(repHead[1])}`);
  }
  // Read BND.ADDR (variable length based on ATYP) + BND.PORT (2 bytes).
  const atyp = repHead[3];
  let addrLen: number;
  if (atyp === 0x01) addrLen = 4;          // IPv4
  else if (atyp === 0x04) addrLen = 16;    // IPv6
  else if (atyp === 0x03) {
    // Domain — first byte is length.
    const lenBuf = await state.socksReader.readExactly(1);
    addrLen = lenBuf[0];
  } else {
    throw new Error(`SOCKS5 reply had unknown ATYP: ${atyp}`);
  }
  await state.socksReader.readExactly(addrLen + 2); // discard BND.ADDR + BND.PORT
}

function buildSocks5ConnectRequest(host: string, port: number, useRemoteDns: boolean): Uint8Array {
  const portBytes = [(port >> 8) & 0xff, port & 0xff];
  // If useRemoteDns (socks5h) OR host is a domain (not an IP literal), use ATYP=0x03 (domain).
  // Otherwise, send the resolved IP literal via ATYP=0x01 (IPv4) or 0x04 (IPv6).
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.includes(":");
  if (!useRemoteDns && isIpv4) {
    const parts = host.split(".").map((p) => parseInt(p, 10));
    const out = new Uint8Array(4 + 4 + 2);
    out[0] = 0x05; out[1] = 0x01; out[2] = 0x00; out[3] = 0x01;
    out[4] = parts[0]; out[5] = parts[1]; out[6] = parts[2]; out[7] = parts[3];
    out[8] = portBytes[0]; out[9] = portBytes[1];
    return out;
  }
  if (!useRemoteDns && isIpv6) {
    // For IPv6, we'd need to parse the literal into 16 bytes. To keep this
    // simple (and since the common case is domain or IPv4), fall back to
    // domain encoding if the host contains ':' — Bun's fetch CONNECT will
    // only ever send `[ipv6]:port`, and most operators use domain or IPv4
    // proxies anyway.
    // Implementation: defer to remote DNS by sending as a domain.
  }
  // Domain encoding.
  const hostBytes = new TextEncoder().encode(host);
  if (hostBytes.length > 255) throw new Error("target host name too long (>255 bytes)");
  const out = new Uint8Array(4 + 1 + hostBytes.length + 2);
  out[0] = 0x05; out[1] = 0x01; out[2] = 0x00; out[3] = 0x03;
  out[4] = hostBytes.length;
  out.set(hostBytes, 5);
  out[5 + hostBytes.length] = portBytes[0];
  out[6 + hostBytes.length] = portBytes[1];
  return out;
}

function socks5ReplyCode(code: number): string {
  const map: Record<number, string> = {
    0x01: "general SOCKS server failure",
    0x02: "connection not allowed by ruleset",
    0x03: "network unreachable",
    0x04: "host unreachable",
    0x05: "connection refused",
    0x06: "TTL expired",
    0x07: "command not supported",
    0x08: "address type not supported",
  };
  return map[code] ?? `unknown error (0x${code.toString(16)})`;
}

// -------------------------------------------------------------------------------------------------
// SOCKS4 / SOCKS4a handshake
// -------------------------------------------------------------------------------------------------

async function socks4Handshake(
  state: ConnState,
  username: string,
  useRemoteDns: boolean,
): Promise<void> {
  // Request: VN=0x04, CD=0x01 (CONNECT), DSTPORT (2 bytes), DSTIP (4 bytes),
  //          USERID (null-terminated), [HOSTNAME (null-terminated, 4a only)]
  const portHi = (state.targetPort >> 8) & 0xff;
  const portLo = state.targetPort & 0xff;
  const userBytes = new TextEncoder().encode(username);
  const hostBytes = new TextEncoder().encode(state.targetHost);

  // Determine IP bytes. For SOCKS4, target must be an IPv4 literal. For
  // SOCKS4a, IP is 0.0.0.x (x != 0) and the hostname is sent after userid.
  let ipBytes: number[];
  if (useRemoteDns) {
    // SOCKS4a: send a fake IP 0.0.0.1 to signal "use hostname".
    ipBytes = [0, 0, 0, 1];
  } else {
    const isIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(state.targetHost);
    if (!isIpv4) {
      throw new Error(`SOCKS4 (not 4a) requires IPv4 target, got: ${state.targetHost}`);
    }
    const parts = state.targetHost.split(".").map((p) => parseInt(p, 10));
    ipBytes = parts;
  }

  // Assemble the request.
  const parts: Bytes[] = [
    new Uint8Array([0x04, 0x01, portHi, portLo, ipBytes[0], ipBytes[1], ipBytes[2], ipBytes[3]]),
    userBytes,
    new Uint8Array([0x00]), // null terminator for USERID
  ];
  if (useRemoteDns) {
    parts.push(hostBytes);
    parts.push(new Uint8Array([0x00])); // null terminator for HOSTNAME
  }
  for (const p of parts) state.socksSocket!.write(p);

  // Reply: VN=0x00, CD (status), DSTPORT (2), DSTIP (4) = 8 bytes total.
  const reply = await state.socksReader.readExactly(8);
  if (reply[0] !== 0x00) throw new Error(`bad SOCKS4 reply version: ${reply[0]}`);
  const status = reply[1];
  // 0x5A = granted; others = various failures.
  if (status !== 0x5a) {
    throw new Error(`SOCKS4 connect failed: ${socks4ReplyCode(status)}`);
  }
}

function socks4ReplyCode(code: number): string {
  const map: Record<number, string> = {
    0x5a: "granted",
    0x5b: "request rejected or failed",
    0x5c: "request failed: client not running identd",
    0x5d: "request failed: client identd could not confirm the user ID",
  };
  return map[code] ?? `unknown status (0x${code.toString(16)})`;
}

// -------------------------------------------------------------------------------------------------
// Post-handshake: switch to tunneling mode
// -------------------------------------------------------------------------------------------------

function onHandshakeOk(state: ConnState): void {
  // Send the "200 Connection Established" reply to fetch.
  if (!state.clientSocket) {
    // Client already gave up.
    cleanupConn(state);
    return;
  }
  const ok = new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n");
  try {
    state.clientSocket.write(ok);
  } catch {
    failConnection(state, "write to client failed");
    return;
  }

  // Switch to tunneling — from now on we just pipe bytes both ways.
  state.phase = "tunneling";
  if (state.handshakeTimer) {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
  }
  dbg(`tunnel established to ${state.targetHost}:${state.targetPort}`);

  // Flush any client data that was buffered during the handshake (e.g. early
  // TLS ClientHello bytes).
  if (state.clientPreBuffer.length > 0 && state.socksSocket) {
    try { state.socksSocket.write(state.clientPreBuffer); } catch { /* ignore */ }
    state.clientPreBuffer = new Uint8Array(0);
  }
}

function failConnection(state: ConnState, reason: string): void {
  if (state.phase === "closing") return;
  // Defensive: never write a 502 response into a tunnel that's already been
  // established — that would inject plaintext HTTP bytes into the client's
  // TLS stream. Only emit the 502 if we're still in the pre-tunnel phases.
  const canReply = state.phase === "read-connect" || state.phase === "socks-handshake";
  state.phase = "closing";

  if (canReply && state.clientSocket) {
    try {
      const body = new TextEncoder().encode(`Bad Gateway: ${reason}\r\n`);
      const head = new TextEncoder().encode(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n`,
      );
      state.clientSocket.write(head);
      state.clientSocket.write(body);
    } catch { /* ignore */ }
  }

  cleanupConn(state);
}

function cleanupConn(state: ConnState): void {
  // Idempotent: subsequent calls are no-ops. Multiple close/error callbacks
  // can fire for the same connection (e.g. SOCKS close + client error), and
  // calling .end() twice on a Bun socket is technically safe but wasteful.
  if (state.phase === "closing" && !state.clientSocket && !state.socksSocket) return;
  if (state.handshakeTimer) {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
  }
  state.phase = "closing";
  // Close both sockets.
  if (state.clientSocket) {
    try { state.clientSocket.end(); } catch { /* ignore */ }
    state.clientSocket = null;
  }
  if (state.socksSocket) {
    try { state.socksSocket.end(); } catch { /* ignore */ }
    state.socksSocket = null;
  }
}

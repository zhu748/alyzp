// End-to-end smoke test: spin up a SOCKS5 server that ACTUALLY tunnels to
// the real target, then verify the bridge lets Bun's fetch reach the target.
import { getSocksBridge, isSocksProxy } from "../src/proxy/socks-bridge.ts";

// ----- Tiny SOCKS5 server (no auth, real tunneling) -----
const server = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(socket) {
      console.log("[socks5] client connected");
      socket.data = { phase: "greeting", buf: Buffer.alloc(0), upstream: null };
    },
    async data(socket, data) {
      const s = socket.data;
      console.log(`[socks5] data: phase=${s.phase} len=${data.length}`);
      s.buf = Buffer.concat([s.buf, data]);

      if (s.phase === "greeting") {
        if (s.buf.length < 2) return;
        const n = s.buf[1];
        if (s.buf.length < 2 + n) return;
        socket.write(new Uint8Array([0x05, 0x00])); // no auth
        s.buf = s.buf.slice(2 + n);
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
          host = s.buf.slice(5, 5 + addrLen).toString("ascii");
        } else if (atyp === 0x04) {
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
        console.log(`[socks5] CONNECT ${host}:${port}`);

        try {
          s.upstream = await Bun.connect({
            hostname: host,
            port,
            socket: {
              data(up, d) { console.log(`[socks5] upstream→client: ${d.length}B`); try { socket.write(d); } catch {} },
              open(up) { console.log("[socks5] upstream open"); },
              close(up) { console.log("[socks5] upstream close"); try { socket.end(); } catch {} },
              error(up, e) { console.log("[socks5] upstream error:", e.message); try { socket.end(); } catch {} },
            },
          });
          console.log("[socks5] connected, sending 0x05 0x00");
          socket.write(new Uint8Array([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          s.phase = "tunnel";
        } catch (e) {
          console.log("[socks5] upstream connect failed:", e.message);
          socket.write(new Uint8Array([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }
      }

      if (s.phase === "tunnel") {
        if (s.buf.length > 0 && s.upstream) {
          try { s.upstream.write(s.buf); } catch {}
          s.buf = Buffer.alloc(0);
        }
      }
    },
    close(socket) {
      const s = socket.data;
      if (s?.upstream) { try { s.upstream.end(); } catch {} }
    },
    error() {},
  },
});

const socksUrl = `socks5://127.0.0.1:${server.port}`;
console.log("isSocksProxy:", isSocksProxy(socksUrl));
const bridge = getSocksBridge(socksUrl);
console.log("bridge URL:", bridge.httpProxyUrl);

// Test 1: HTTPS GET through SOCKS5 → real upstream
try {
  const resp = await fetch("https://www.example.com/", {
    proxy: bridge.httpProxyUrl,
    method: "HEAD",
    signal: AbortSignal.timeout(10_000),
  });
  console.log("HTTPS HEAD status:", resp.status);
} catch (e) {
  console.log("HTTPS HEAD error:", e.message);
}

// Test 2: use proxiedFetch wrapper
const { proxiedFetch } = await import("../src/proxy/proxied-fetch.ts");
try {
  const resp = await proxiedFetch("https://www.example.com/", {
    method: "HEAD",
    proxy: socksUrl,
    signal: AbortSignal.timeout(10_000),
  });
  console.log("proxiedFetch HEAD status:", resp.status);
} catch (e) {
  console.log("proxiedFetch error:", e.message);
}

bridge.release();
server.stop(true);
setTimeout(() => process.exit(0), 200);

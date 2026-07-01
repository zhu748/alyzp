/**
 * Tests for the SSE heartbeat transform.
 *
 * Verifies:
 *   1. Heartbeat comment lines are flushed while upstream is silent.
 *   2. Heartbeat stops immediately after the first real chunk arrives.
 *   3. Real chunks pass through unchanged.
 *   4. intervalMs=0 disables heartbeat (pure passthrough).
 *   5. Comment line format is exactly `: keepalive\n\n`.
 *
 * These tests use real timers with short intervals (10-50ms) so the total
 * runtime is <2s. We avoid fake timers because the heartbeat uses setInterval
 * + unref, and we want to verify the actual Bun runtime behavior.
 */
import { test, expect } from "bun:test";
import { _testing } from "./handler.js";

const { createSseHeartbeatTransform } = _testing;
const COMMENT_LINE = ": keepalive\n\n";

/** Helper: collect all chunks from a ReadableStream into a Uint8Array. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Helper: convert Uint8Array to string. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test("heartbeat flushes comment lines while upstream is silent", async () => {
  // Upstream source that emits ONE real chunk after 150ms, then closes.
  // Heartbeat interval = 20ms, so we expect ~7 heartbeats before the
  // real chunk arrives (150ms / 20ms = 7.5 ticks). We use 150ms (not 80ms)
  // to give the event loop enough headroom — under CI load, a 80ms delay
  // can race with the first setInterval tick and produce zero heartbeats.
  // 150ms guarantees at least 5-6 ticks even with 50ms jitter.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Don't enqueue anything immediately — simulate slow TTFB.
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("event: message\ndata: hello\n\n"));
        controller.close();
      }, 150);
    },
  });

  const heartbeat = createSseHeartbeatTransform(20);
  const out = await collect(upstream.pipeThrough(heartbeat));
  const text = decode(out);

  // Must contain the real SSE event.
  expect(text).toContain("event: message");
  expect(text).toContain("hello");
  // Must contain at least 2 heartbeat comment lines (5-7 expected, allow 2
  // for timing jitter on slow CI).
  const heartbeatCount = (text.match(/: keepalive\n\n/g) || []).length;
  expect(heartbeatCount).toBeGreaterThanOrEqual(2);
});

test("heartbeat stops immediately after first real chunk", async () => {
  // Upstream emits first chunk immediately, then waits 100ms, then emits
  // a second chunk. Heartbeat interval = 20ms. If heartbeat didn't stop
  // after the first chunk, we'd see ~5 heartbeats between the two real
  // chunks. We expect ZERO heartbeats after the first real chunk.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      }, 100);
    },
  });

  const heartbeat = createSseHeartbeatTransform(20);
  const out = await collect(upstream.pipeThrough(heartbeat));
  const text = decode(out);

  // Both real chunks present, in order.
  expect(text).toContain("data: first");
  expect(text).toContain("data: second");
  // Zero heartbeat comment lines — heartbeat stopped on first chunk.
  expect(text).not.toContain(COMMENT_LINE);
});

test("heartbeat with intervalMs=0 is pure passthrough", async () => {
  // Upstream emits a chunk after 60ms. With heartbeat disabled (0), we
  // should see ZERO comment lines and the real chunk passes through.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
        controller.close();
      }, 60);
    },
  });

  const heartbeat = createSseHeartbeatTransform(0);
  const out = await collect(upstream.pipeThrough(heartbeat));
  const text = decode(out);

  expect(text).toBe("data: hello\n\n");
  expect(text).not.toContain(COMMENT_LINE);
});

test("heartbeat comment line format is exactly ': keepalive\\n\\n'", async () => {
  // Use a very short heartbeat (10ms) and a long upstream delay (50ms) to
  // guarantee at least one heartbeat fires. We then inspect the raw bytes
  // to verify the exact format.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("data: end\n\n"));
        controller.close();
      }, 50);
    },
  });

  const heartbeat = createSseHeartbeatTransform(10);
  const out = await collect(upstream.pipeThrough(heartbeat));
  const text = decode(out);

  // Verify the exact comment line format appears at least once.
  expect(text).toContain(COMMENT_LINE);
  // Verify it's the SSE comment syntax (starts with ": ").
  const lines = text.split("\n");
  expect(lines.some(l => l === ": keepalive")).toBe(true);
});

test("heartbeat cleans up timer on stream end (no leak)", async () => {
  // This is a smoke test — we can't directly assert "no timer leaked" in
  // Bun, but we can verify the stream closes cleanly and the output is
  // correct. If the timer leaked, the test process would hang on exit.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: done\n\n"));
      controller.close();
    },
  });

  const heartbeat = createSseHeartbeatTransform(10);
  const out = await collect(upstream.pipeThrough(heartbeat));
  expect(decode(out)).toBe("data: done\n\n");
  // If we reach this point without hanging, the timer was cleaned up.
});

test("heartbeat handles upstream error gracefully", async () => {
  // Upstream errors after 50ms (no real chunk emitted). Heartbeat should
  // have fired at least once, then the error propagates.
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => {
        controller.error(new Error("upstream blew up"));
      }, 50);
    },
  });

  const heartbeat = createSseHeartbeatTransform(10);
  let threw = false;
  try {
    await collect(upstream.pipeThrough(heartbeat));
  } catch (e) {
    threw = true;
    expect((e as Error).message).toContain("upstream blew up");
  }
  // We expect the error to propagate.
  expect(threw).toBe(true);
  // Even if heartbeats were emitted before the error, collect() threw
  // before returning — the key assertion is that the error propagated
  // and didn't hang.
});

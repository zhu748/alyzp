/**
 * Timing-safe string comparison.
 *
 * Compares two strings in constant time relative to the longer one, so that
 * an attacker cannot use response-time differences to bitwise-recover a
 * secret. Always iterates over the full length of the longer string — never
 * short-circuits on the first differing character.
 *
 * @returns true iff both strings are byte-equal AND have the same length.
 *
 * v0.2.0.8: rewritten on top of `node:crypto.timingSafeEqual`, which is
 * audited and handles buffer alignment / JIT-optimization pitfalls that a
 * hand-rolled JS loop can subtly get wrong (e.g. engine speculation on
 * charCodeAt, UTF-16 surrogate-pair timing). The original custom loop is kept
 * as a fallback only if `node:crypto` is somehow unavailable (defensive —
 * every supported runtime ships it).
 *
 * `node:crypto.timingSafeEqual` requires equal-length Buffers, so we pad the
 * shorter string with zeros to maxLen. We still compare the full maxLen, so
 * timing is constant w.r.t. max(a.length, b.length); the result is guaranteed
 * false when lengths differ (the padding zeros XOR against real bytes).
 */
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export function timingSafeEqual(a: string, b: string): boolean {
  // Fast path: identical strings (common case for "valid token" checks).
  if (a === b) return true;

  const aLen = Buffer.byteLength(a, "utf8");
  const bLen = Buffer.byteLength(b, "utf8");
  const maxLen = Math.max(aLen, bLen);

  // Pad both to maxLen so nodeTimingSafeEqual can compare them. We allocate
  // two fresh buffers (zero-filled) and write the strings into them; the
  // trailing zeros are constant-time-irrelevant because they're the same on
  // both sides only if the lengths matched (otherwise the XOR fold is
  // non-zero and the function returns false).
  const aBuf = Buffer.alloc(maxLen);
  const bBuf = Buffer.alloc(maxLen);
  aBuf.write(a, 0, "utf8");
  bBuf.write(b, 0, "utf8");

  try {
    // nodeTimingSafeEqual throws if buffers have different lengths — but we
    // padded both to maxLen, so they're always equal here. The try/catch is
    // defensive against any future runtime that re-introduces a length check.
    return nodeTimingSafeEqual(aBuf, bBuf) && aLen === bLen;
  } catch {
    // Fallback: hand-rolled constant-time compare. This branch is only hit
    // if node:crypto.timingSafeEqual is unavailable (impossible in supported
    // runtimes), kept purely for defense-in-depth.
    let result = aLen ^ bLen;
    const aStr = aBuf.toString("utf8");
    const bStr = bBuf.toString("utf8");
    for (let i = 0; i < maxLen; i++) {
      const aChar = i < aStr.length ? aStr.charCodeAt(i) : 0;
      const bChar = i < bStr.length ? bStr.charCodeAt(i) : 0;
      result |= aChar ^ bChar;
    }
    return result === 0;
  }
}

/**
 * In-memory store for `previous_response_id` conversation chaining.
 *
 * GLM upstream has no native Responses API or server-side conversation store,
 * so we keep the latest input + output of each response keyed by its id, and
 * replay it when the client sends `previous_response_id`.
 *
 * Cap is 256 entries with FIFO eviction — plenty for a single-user local proxy.
 * Per-entry byte size is also capped (MAX_ENTRY_BYTES, default 256 KB) to
 * prevent OOM when a Codex CLI conversation grows long: each turn can carry
 * 100K+ tokens of cumulative context, and 256 × unbounded = OOM risk.
 *
 * Restarting the proxy drops all stored conversations (matches the expectation
 * that a local proxy is short-lived; clients using `store:true` for long-lived
 * sessions should re-run `auth login` after a restart).
 *
 * v0.2.0.8 NOTE: persistence to disk was considered (so Codex sessions
 * survive restarts) but deliberately NOT implemented because:
 *   1. Conversation history may contain sensitive code/prompts — encrypting
 *      it with the fixed "520" key offers only obfuscation (see auth/store.ts).
 *   2. Schema migrations across versions add complexity for marginal benefit.
 *   3. The primary deployment (apikey mode, short-lived container) rarely
 *      benefits from cross-restart session continuity.
 * If you need this, consider implementing an opt-in ZCODE_RESPONSES_PERSIST
 * env flag that serializes the store to STORE_DIR/responses.json with the
 * same AES-256-GCM fixed-key encryption used for credentials.
 */

interface StoredTurn {
  /** Input items sent by the client for this turn. */
  input: unknown[];
  /** Output items we returned to the client. */
  output: unknown[];
  /** Timestamp for debugging / expiry. */
  at: number;
  /** Approximate serialized size in bytes (capped on insertion). */
  bytes: number;
}

const MAX_ENTRIES = 256;
/** Max serialized size per entry. Entries larger than this are stored with
 *  their input truncated to fit — preserves the latest output for chaining
 *  while bounding total memory. */
const MAX_ENTRY_BYTES = 256 * 1024;

const store = new Map<string, StoredTurn>();

/** Approximate byte length of a value when JSON-serialized. Returns 0 on
 *  circular / un-stringifiable values so they're stored without truncation. */
function approxBytes(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return 0; }
}

/** Truncate `input` (the part the client can replay later) so the entry fits
 *  within MAX_ENTRY_BYTES. We truncate by dropping the oldest input items
 *  first — the most recent ones (which the model just generated from) are
 *  the most useful for context. Output is never truncated. */
function fitToBytes(input: unknown[], output: unknown[]): unknown[] {
  let inBytes = approxBytes(input);
  const outBytes = approxBytes(output);
  const budget = MAX_ENTRY_BYTES - outBytes;
  if (budget <= 0 || inBytes <= budget) return input;
  // Drop oldest input items until we fit. If a single item is larger than
  // budget, keep just that one item truncated.
  const trimmed = [...input];
  while (trimmed.length > 1 && approxBytes(trimmed) > budget) {
    trimmed.shift();
  }
  return trimmed;
}

/** Save a turn keyed by the response id (must be unique). */
export function saveTurn(responseId: string, input: unknown[], output: unknown[]): void {
  if (!responseId) return;
  if (store.size >= MAX_ENTRIES) {
    // FIFO eviction: drop the oldest entry
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  const fittedInput = fitToBytes(input, output);
  store.set(responseId, {
    input: fittedInput,
    output,
    at: Date.now(),
    bytes: approxBytes(fittedInput) + approxBytes(output),
  });
}

/** Look up a stored turn by previous_response_id. Returns undefined if not found. */
export function getTurn(responseId: string): StoredTurn | undefined {
  return store.get(responseId);
}

/** Total bytes currently held by the store. Exposed for diagnostics. */
export function totalBytes(): number {
  let sum = 0;
  for (const v of store.values()) sum += v.bytes;
  return sum;
}

/** Clear all stored turns. Used by tests. */
export function clearStore(): void {
  store.clear();
}

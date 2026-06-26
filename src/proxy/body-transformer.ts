/**
 * Request body transformer — applies ZCode-equivalent body mutations before
 * forwarding upstream. All transformations are no-ops on parse failure (the
 * original body is returned unchanged) so a malformed body never breaks the
 * proxy: it just loses the optimization.
 *
 * ⚠️⚠️⚠️ READ BEFORE MODIFYING — DO NOT BLINDLY REMOVE TRANSFORMS ⚠️⚠️⚠️
 *
 * This file is the result of ~10 iterations of debugging 3001 "parameter
 * error" from the ZCode start-plan gateway. Every transformation here exists
 * because the gateway REJECTED the request without it. Removing any of them
 * WILL reintroduce 3001 in some scenario. If you're tempted to "simplify"
 * or "clean up" this file, READ THE HISTORY BELOW FIRST.
 *
 * === WHY EACH TRANSFORM EXISTS ===
 *
 * 1. `transformUnsupportedAnthropicFields` — Claude Code sends
 *    `thinking:{type:"adaptive"}`, `context_management`, `output_config`.
 *    GLM only accepts `thinking:{type:"enabled"|"disabled"}` and has no
 *    equivalent for the other two. Sending them → 3001.
 *
 * 2. `relocateSystemMessages` — Claude Code puts system text in
 *    `messages[].role:"system"`. Anthropic API requires system in top-level
 *    `system` field. GLM rejects `role:"system"` in messages → 3001.
 *
 * 3. `stripThinkingBlocksFromMessages` — When thinking is enabled, GLM
 *    returns thinking_delta SSE events. Claude Code captures these and
 *    echoes them back as `thinking`/`redacted_thinking` content blocks in
 *    the NEXT turn's assistant message. GLM does NOT accept these as
 *    content blocks → 3001 on turn 2+. Without this, only turn 1 succeeds.
 *
 * 4. `ensureAssistantTextBlock` — After #3 strips thinking blocks, an
 *    assistant message may be left with ONLY tool_use blocks. ZCode gateway
 *    requires every assistant message to have at least one text block → 3001
 *    if missing. We insert `text:" "` (single space, NOT empty — empty text
 *    also 3001s) at the front.
 *
 * 5. `normalizeAllMessageContent` — Claude Code and the Responses API
 *    translator both produce `content: "string"` for simple text. ZCode
 *    gateway ONLY accepts array format `content:[{type:"text",text}]` → 3001
 *    on string content. EMPTY strings become empty text blocks → also 3001,
 *    so empty strings are converted to `text:" "` (non-empty placeholder).
 *
 * 6. `normalizeToolResultContent` — Same as #5 but for `tool_result.content`.
 *    Claude Code sends `content:"file1\nfile2"` (string). ZCode gateway
 *    requires array → 3001. Empty output → `text:" "`.
 *
 * 7. `sanitizeContentBlocks` — Strips two fields:
 *    a. `cache_control` — In start-plan mode, stripped from ALL blocks
 *       (including text). ZCode gateway rejects cache_control on ANY block.
 *       In coding-plan mode, stripped from non-text blocks only (direct GLM
 *       API accepts cache_control on text for prompt caching).
 *       DO NOT re-add cache_control in start-plan — it WILL 3001.
 *    b. `is_error` (tool_result only) — Claude Code adds `is_error:false`.
 *       ZCode gateway doesn't accept this field → 3001. Strip in both modes.
 *
 * 8. `applyAnthropicCacheControl` — In coding-plan mode, adds cache_control
 *    to the last text block of the last non-system message (for prompt
 *    caching). In start-plan mode, this is a NO-OP — see #7a above.
 *
 * 9. `applyAnthropicUserId` — In OAuth mode, injects `metadata.user_id`.
 *    ZCode gateway expects this for tracking. No-op in apikey mode.
 *
 * === TRANSFORM ORDER MATTERS ===
 *
 * The transforms run in a specific order (see `transformRequestBodyObj`):
 *   thinking fields → system relocation → thinking block strip →
 *   assistant text ensure → content normalize → tool_result normalize →
 *   sanitize (cc + is_error) → cache_control add
 *
 * Reordering will break things. For example, `sanitizeContentBlocks` MUST
 * run AFTER `applyAnthropicCacheControl` would have run (it's the safety
 * net), but since `applyAnthropicCacheControl` is no-op in start-plan,
 * `sanitizeContentBlocks` is the only cc authority there. In coding-plan,
 * `sanitizeContentBlocks` strips non-text cc first, then
 * `applyAnthropicCacheControl` adds cc to text only — so even if a future
 * edit accidentally adds cc to a non-text block, sanitize would catch it
 * on the NEXT request (but not this one, since sanitize runs before add).
 *
 * === DEBUGGING 3001 ===
 *
 * If 3001 still occurs:
 *   1. Check the proxy console for `transformed request summary:` line.
 *      It shows every message's role + block types + cc markers + tool_result
 *      content format. ANY `+cc` on non-text blocks, ANY `/str` on tool_result,
 *      ANY `/+err` on tool_result indicates a regression.
 *   2. Check the dumped `zcode-proxy-debug-<reqId>.json` file in the proxy's
 *      working directory — it contains the FULL transformed request body.
 *   3. The `anthropic-beta sent:` line should show ONLY `claude-code-*` flags
 *      in start-plan mode. Other flags reference features we strip from the
 *      body, causing header/body mismatch → 3001.
 *
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import type { Format } from "../translator/types.js";
import { buildStartPlanSystem, ZCODE_SYSTEM_BLOCKS } from "./system-prompt.js";
import type { SystemBlock } from "./system-prompt.js";

export interface TransformContext {
  format: Format;
  /** When set (OAuth mode), the Anthropic-format body gets `metadata.user_id` injected. */
  userId?: string;
  /** When true (start-plan), prepend ZCode gateway system blocks. */
  startPlan?: boolean;
  /**
   * ZCode thinking tier — controls the budget_tokens + effort injected when
   * the client sends `thinking.type=enabled`.
   *   - "max"  (default): budget_tokens=32000, effort="max"
   *   - "high"          : budget_tokens=16000, effort="high"
   * When the client does NOT send `thinking`, only max_tokens=64000 is
   * injected (ZCode "no thinking" wire shape) — thinking is never forced on.
   */
  thinkingLevel?: "high" | "max";
  /**
   * When true, restructure the request body to match the real ZCode desktop
   * client's wire format exactly:
   *   - Top-level field order: model → max_tokens → thinking → output_config → system → messages → tools → tool_choice → stream
   *   - Inject ZCode system blocks (both coding-plan AND start-plan)
   *   - Rewrite "You are Claude Code" → "You are ZCode model working in Claude Code"
   *   - Keep system role in messages (skip relocateSystemMessages)
   * Default: false.
   */
  alignZCodeFormat?: boolean;
}

/**
 * Apply body transformations. Returns the original `body` string when nothing
 * changed OR when parsing failed; otherwise returns the re-serialized body.
 */
export function transformRequestBody(body: string | undefined, ctx: TransformContext): string | undefined {
  if (body === undefined || body.length === 0) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null) return body;

  const result = transformRequestBodyObj(parsed, ctx);
  return result !== undefined ? JSON.stringify(result) : body;
}

/**
 * Apply body transformations on a pre-parsed object. Returns the transformed
 * object (mutated in place for efficiency), or undefined if nothing changed.
 */
export function transformRequestBodyObj(parsed: unknown, ctx: TransformContext): unknown | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;

  let modified = false;

  if (ctx.format === "openai") {
    modified = applyStreamOptionsIncludeUsage(parsed as Record<string, unknown>) || modified;
  }
  if (ctx.format === "anthropic") {
    const obj = parsed as Record<string, unknown>;
    if (ctx.startPlan) {
      modified = applyStartPlanSystem(obj) || modified;
    }
    modified = transformUnsupportedAnthropicFields(obj) || modified;
    // Inject ZCode thinking format (max_tokens + budget_tokens + output_config)
    // — runs UNCONDITIONALLY (default behavior since v0.1.9). Any Anthropic
    // request with thinking.type === "enabled" gets the EXACT thinking-format
    // fields the real ZCode desktop client sends. This aligns our request
    // body fingerprint with the real client at the WAF body-inspection layer.
    //
    // Runs AFTER transformUnsupportedAnthropicFields so we can detect the
    // simplified `thinking: { type: "enabled" }` shape. Must run BEFORE
    // any transform that might strip output_config.
    //
    // vceshi0.1.7+: thinkingLevel controls the tier (high/max). When client
    // doesn't send `thinking`, only max_tokens=64000 is injected (ZCode "no
    // thinking" mode) — thinking is NOT forced on.
    modified = injectZCodeThinkingFormat(obj, ctx.thinkingLevel ?? "max") || modified;
    // When alignZCodeFormat is ON, skip relocateSystemMessages — real ZCode
    // keeps role: "system" inside messages[] instead of moving to top-level
    // system field. The align function (called last) handles system injection.
    if (!ctx.alignZCodeFormat) {
      modified = relocateSystemMessages(obj) || modified;
    }
    modified = stripThinkingBlocksFromMessages(obj) || modified;
    // alignZCodeFormat: skip ensureAssistantTextBlock — real ZCode client
    // allows assistant messages with only tool_use blocks (no text). Sample
    // shows 18 such messages in real ZCode traffic. Inserting a placeholder
    // text:" " block creates a fingerprint mismatch.
    if (!ctx.alignZCodeFormat) {
      modified = ensureAssistantTextBlock(obj) || modified;
    }
    modified = normalizeAllMessageContent(obj) || modified;
    // alignZCodeFormat: skip normalizeToolResultContent — real ZCode client
    // sends tool_result.content as STRING (49/49 in sample). Converting to
    // array creates a fingerprint mismatch.
    if (!ctx.alignZCodeFormat) {
      modified = normalizeToolResultContent(obj) || modified;
    }
    modified = sanitizeContentBlocks(obj, ctx.startPlan, ctx.alignZCodeFormat) || modified;
    modified = applyAnthropicCacheControl(obj, ctx.startPlan, ctx.alignZCodeFormat) || modified;
    // start-plan: ZCode gateway is stricter than official Anthropic API and
    // rejects `metadata.user_id` (returns 200 + empty SSE stream — invisible
    // to the SSE error detector, surfaces as "empty/malformed response" in
    // Claude Code). Only inject for coding-plan, mirroring the
    // applyAnthropicCacheControl no-op pattern at line 196-200.
    // See: https://github.com/zhu748/lealll issue on OAuth-credential switch
    if (ctx.userId && !ctx.startPlan) {
      modified = applyAnthropicUserId(obj, ctx.userId) || modified;
    }
    // Align request structure to match real ZCode client (must run LAST so
    // all other transforms have settled). Rewrites top-level field order,
    // injects ZCode system blocks (both coding-plan AND start-plan), and
    // rewrites "You are Claude Code" → "You are ZCode model working in Claude Code".
    if (ctx.alignZCodeFormat) {
      const aligned = alignZCodeRequestFormat(obj);
      if (aligned) {
        // alignZCodeRequestFormat rebuilds the object with correct key order.
        // We need to replace parsed's keys in place — clear and re-assign.
        for (const k of Object.keys(parsed as Record<string, unknown>)) {
          delete (parsed as Record<string, unknown>)[k];
        }
        Object.assign(parsed as Record<string, unknown>, aligned);
        modified = true;
      }
    }
  }

  return modified ? parsed : undefined;
}

/** OpenAI streaming: ensure `stream_options.include_usage: true`. */
function applyStreamOptionsIncludeUsage(body: Record<string, unknown>): boolean {
  if (body.stream !== true) return false;
  const existing = body.stream_options;
  if (isPlainObject(existing) && existing.include_usage === true) {
    return false;
  }
  const merged: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  merged.include_usage = true;
  body.stream_options = merged;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Anthropic: add `cache_control: { type: "ephemeral" }` to the last content
 * block of the last non-system message. Mirrors ZCode's `HLr` algorithm.
 * Idempotent — skips if any block on that message already carries cache_control.
 *
 * IMPORTANT: In **start-plan mode**, this function is a no-op. The ZCode
 * gateway rejects `cache_control` on ALL block types — including `text`
 * blocks — with 3001 "parameter error". (v2.1.3.5/6/7beta0 incorrectly
 * assumed text-block cache_control was safe; v2.1.3.9beta0 corrected this
 * by stripping all cache_control in start-plan mode and not adding new ones.)
 *
 * In **coding-plan mode** (direct GLM API), the previous behavior is preserved:
 * cache_control is attached only to `text` blocks (skipping tool_use /
 * tool_result / image etc.). If no text block is found in the last non-system
 * message, the function walks backwards; if still none, it skips cache_control
 * entirely — better to miss the cache optimization than to risk 3001.
 *
 * The `sanitizeContentBlocks()` function runs BEFORE this and strips cache_control
 * from non-text blocks (coding-plan) or ALL blocks (start-plan), so even if this
 * function somehow attached to a disallowed block, sanitize would catch it.
 */
function applyAnthropicCacheControl(
  body: Record<string, unknown>,
  startPlan?: boolean,
  alignZCodeFormat?: boolean,
): boolean {
  // In start-plan mode WITHOUT alignZCodeFormat, do NOT add any cache_control.
  // The ZCode gateway is stricter than Anthropic's official API and rejects
  // cache_control on ALL block types, including text blocks.
  //
  // In alignZCodeFormat mode (regardless of start-plan), real ZCode client
  // DOES send cache_control on the last user message's text block — we mirror
  // that. sanitizeContentBlocks is also told to preserve cc in this mode.
  if (startPlan && !alignZCodeFormat) return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== "object" || msg === null) continue;
    if (msg.role === "system") continue;

    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      // Walk backwards through this message's blocks looking for a `text`
      // block to attach cache_control to. Skip tool_use / tool_result / image
      // etc. — ZCode gateway only accepts cache_control on text blocks.
      let attached = false;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (typeof block !== "object" || block === null) continue;
        if (block.type !== "text") continue; // ONLY text blocks can carry cc
        if (!block.cache_control) {
          block.cache_control = { type: "ephemeral" };
          attached = true;
          break;
        }
        // Already has cache_control on a text block — message is fine.
        attached = true;
        break;
      }
      if (attached) return true;
      // No text block on this message — fall through to previous message.
      continue;
    }
    continue;
  }
  return false;
}

/**
 * Anthropic: inject `metadata: { user_id }` when not already set.
 * Preserves any existing `metadata.*` fields other than `user_id`.
 */
function applyAnthropicUserId(body: Record<string, unknown>, userId: string): boolean {
  const existing = body.metadata;
  if (isPlainObject(existing) && existing.user_id === userId) {
    return false;
  }
  body.metadata = {
    ...(isPlainObject(existing) ? existing : {}),
    user_id: userId,
  };
  return true;
}

/**
 * Transform or strip top-level Anthropic request fields that GLM upstream does
 * not support in the format sent by Claude Code.
 *
 * Transformations:
 *   - `thinking` — Claude Code sends `{"type":"adaptive"}` or
 *     `{"type":"enabled","budget_tokens":N}`, but GLM only supports
 *     `{"type":"enabled"}` (thinking on) or `{"type":"disabled"}` (thinking off).
 *     We convert "adaptive" and "enabled" to `{"type":"enabled"}` (stripping
 *     unsupported `budget_tokens`), and keep "disabled" as-is.
 *   - `context_management` — removed (GLM has no equivalent)
 *   - `output_config` — removed (GLM has no equivalent)
 */
function transformUnsupportedAnthropicFields(body: Record<string, unknown>): boolean {
  let changed = false;

  // Transform thinking: GLM only supports "enabled" / "disabled", no "adaptive" or "budget_tokens"
  if ("thinking" in body && isPlainObject(body.thinking)) {
    const t = body.thinking as Record<string, unknown>;
    const type = t.type;
    if (type === "adaptive" || type === "enabled") {
      // Convert to GLM's format: {"type":"enabled"} — strip budget_tokens etc.
      body.thinking = { type: "enabled" };
      changed = true;
    }
    // "disabled" is passed through as-is; any other value is also left alone
  }

  // Remove fields GLM does not support at all
  for (const key of ["context_management", "output_config"] as const) {
    if (key in body) {
      delete body[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Inject the EXACT thinking-format fields the real ZCode desktop client sends.
 *
 * Runs UNCONDITIONALLY on every Anthropic request. Behavior depends on whether
 * the client sent a `thinking` field and which `thinkingLevel` tier is selected:
 *
 *   1. Client sent `thinking.type === "enabled"`:
 *      Inject the tier-specific values:
 *        - "max"  (default): max_tokens=64000, budget_tokens=32000, effort="max"
 *        - "high"          : max_tokens=64000, budget_tokens=16000, effort="high"
 *      These match the two thinking tiers the real ZCode desktop client offers
 *      to users (高 / 最高).
 *
 *   2. Client did NOT send `thinking`, or sent `thinking.type !== "enabled"`
 *      (e.g. "disabled"):
 *      Only force `max_tokens=64000`. Do NOT add `thinking` or `output_config`.
 *      This mirrors ZCode's "不思考" wire shape — the client never sends a
 *      thinking field at all in that mode.
 *
 *      We DO NOT force thinking on. If the user wants thinking, they enable it
 *      on the client side (Claude Code, Cherry Studio, etc.) — the dashboard
 *      tier selector only controls high vs max intensity, not on/off.
 *
 * Source: reverse-engineered from real ZCode Electron client traffic (2026-06).
 * Three observed wire shapes:
 *   - max tier:    { max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 32000 }, output_config: { effort: "max" } }
 *   - high tier:   { max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 16000 }, output_config: { effort: "high" } }
 *   - no thinking: { max_tokens: 64000 }   (no thinking field, no output_config field)
 *
 * Runs AFTER transformUnsupportedAnthropicFields so we can detect the simplified
 * `thinking: { type: "enabled" }` shape. Must run BEFORE any transform that
 * might strip output_config.
 */
function injectZCodeThinkingFormat(body: Record<string, unknown>, level: "high" | "max" = "max"): boolean {
  const thinking = body.thinking;
  const isThinkingEnabled = isPlainObject(thinking) && (thinking as Record<string, unknown>).type === "enabled";

  let changed = false;

  // === Always force max_tokens=64000 (matches all 3 ZCode wire shapes) ===
  if (body.max_tokens !== 64000) {
    body.max_tokens = 64000;
    changed = true;
  }

  if (!isThinkingEnabled) {
    // ZCode "不思考" mode: max_tokens already set above, no thinking field,
    // no output_config. Make sure no leftover output_config from a prior
    // transform step sneaks through (transformUnsupportedAnthropicFields
    // already deletes it, but be defensive).
    if ("output_config" in body) {
      delete body.output_config;
      changed = true;
    }
    return changed;
  }

  // === Thinking enabled: inject tier-specific values ===
  const t = thinking as Record<string, unknown>;
  const budgetTokens = level === "high" ? 16000 : 32000;
  const effort = level === "high" ? "high" : "max";

  // 1. Force thinking.budget_tokens to the tier value.
  //    transformUnsupportedAnthropicFields strips budget_tokens (GLM "doesn't
  //    support" it — but the real ZCode client sends it anyway and the gateway
  //    accepts it). We re-add it here to match the real client's shape.
  if (t.budget_tokens !== budgetTokens) {
    t.budget_tokens = budgetTokens;
    changed = true;
  }

  // 2. Re-add output_config: { effort: <tier> }.
  //    transformUnsupportedAnthropicFields deletes this; we add it back. The
  //    real ZCode client always sends it when thinking is enabled.
  if (!isPlainObject(body.output_config) || (body.output_config as Record<string, unknown>).effort !== effort) {
    body.output_config = { effort };
    changed = true;
  }

  return changed;
}

/**
 * Align request structure to match the real ZCode desktop client's wire format.
 *
 * Triggered only when `ctx.alignZCodeFormat === true`. Performs three transformations:
 *
 * 1. **Inject ZCode system blocks** (both coding-plan AND start-plan):
 *    - Prepend 3 official ZCode identity blocks from zcode_system.json
 *    - Each block carries `cache_control: { type: "ephemeral" }`
 *    - Client's original system blocks (if any) appended AFTER the ZCode blocks
 *    - Critical for start-plan: gateway does content inspection and rejects
 *      requests missing the ZCode identity blocks
 *
 * 2. **Client identity rewrite**: if the client's system text contains
 *    "You are Claude Code, Anthropic's official CLI for Claude." (Claude Code's
 *    default identity string), rewrite it to "You are ZCode model working in
 *    Claude Code." — preserves Claude Code's harness instructions while adopting
 *    ZCode identity for WAF bypass.
 *
 * 3. **Top-level field reorder**: rebuild the object with key insertion order
 *    matching the real ZCode client:
 *      model → max_tokens → thinking → output_config → system → messages →
 *      tools → tool_choice → stream → (other fields)
 *    JSON object key order is preserved by JS engines (ES2015+), so this
 *    actually changes the wire bytes — important because some WAFs inspect
 *    key order as a fingerprint.
 *
 * Returns the new object with reordered keys, or null if no changes were made
 * (though in practice the system injection always triggers when alignZCodeFormat
 * is on, so this always returns a non-null object).
 *
 * @see _reverse/NOTEPAD.md "Real ZCode Request Structure (2026-06)"
 */
const ZCODE_OFFICIAL_SYSTEM_BLOCKS: ReadonlyArray<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = Object.freeze(
  (ZCODE_SYSTEM_BLOCKS as SystemBlock[]).map(b => Object.freeze({ ...b })),
);

/** Claude Code's default identity string — we rewrite it to ZCode identity. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const ZCODE_IDENTITY_REPLACEMENT = "You are ZCode model working in Claude Code.";

function alignZCodeRequestFormat(body: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;

  // === Step 1: Inject ZCode system blocks (always, both plans) ===
  // Prepend official ZCode identity blocks. Client's existing system blocks
  // are appended after (with identity rewrite applied — see Step 2).
  //
  // IDEMPOTENCY: if the request has already been aligned (e.g. on retry), the
  // system field already starts with the 3 ZCode official blocks. We detect
  // this by checking if the first block's text matches the first ZCode block,
  // and if so, DON'T re-inject (just rewrite identity + reorder keys).
  const clientSystem = normalizeSystemToArray(body.system);
  const alreadyInjected = clientSystem.length > 0
    && clientSystem[0].text === ZCODE_OFFICIAL_SYSTEM_BLOCKS[0].text;

  const rewrittenClientSystem = rewriteClaudeCodeIdentity(clientSystem);
  if (rewrittenClientSystem !== clientSystem) changed = true;

  if (!alreadyInjected) {
    const officialBlocks = ZCODE_OFFICIAL_SYSTEM_BLOCKS.map(b => ({ ...b }));
    body.system = [...officialBlocks, ...rewrittenClientSystem];
  } else {
    body.system = rewrittenClientSystem;
  }
  changed = true;

  // === Step 2: Identity rewrite inside messages too ===
  // Claude Code's "You are Claude Code..." can also appear in messages[].role: "system"
  // (Claude Code puts its identity in messages too). Rewrite those as well.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isPlainObject(msg)) continue;
      if ((msg as Record<string, unknown>).role !== "system") continue;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        if (content.includes(CLAUDE_CODE_IDENTITY)) {
          (msg as Record<string, unknown>).content = content.replace(
            CLAUDE_CODE_IDENTITY,
            ZCODE_IDENTITY_REPLACEMENT,
          );
          changed = true;
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isPlainObject(block)) continue;
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string" && text.includes(CLAUDE_CODE_IDENTITY)) {
            (block as Record<string, unknown>).text = text.replace(
              CLAUDE_CODE_IDENTITY,
              ZCODE_IDENTITY_REPLACEMENT,
            );
            changed = true;
          }
        }
      }
    }
  }

  // === Step 3: Fill in missing fields real ZCode always sends ===
  // Real ZCode client always includes tool_choice and stream, even when the
  // client (e.g. Claude Code) doesn't send them. Fill in the defaults to match.
  // tool_choice: { type: "auto" } — only when tools are present (real ZCode
  // only sends tool_choice when tools array is non-empty).
  if (Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice === undefined) {
    body.tool_choice = { type: "auto" };
    changed = true;
  }
  // stream: true — real ZCode always streams. Claude Code defaults to non-stream
  // (stream field absent or false), so we force it on to match the real client.
  if (body.stream !== true) {
    body.stream = true;
    changed = true;
  }

  // === Step 4: Drop fields real ZCode client never sends ===
  // Claude Code sends `metadata: { user_id: "..." }` for tracking. Real ZCode
  // client never sends this field — its presence is a clear "non-ZCode client"
  // fingerprint. Drop it.
  if ("metadata" in body) {
    delete body.metadata;
    changed = true;
  }

  // === Step 5: Rebuild top-level keys in ZCode wire order ===
  // Real ZCode order (reverse-engineered):
  //   model → max_tokens → thinking → output_config → system → messages →
  //   tools → tool_choice → stream → (others)
  const ORDERED_KEYS = [
    "model", "max_tokens", "thinking", "output_config",
    "system", "messages", "tools", "tool_choice", "stream",
  ];
  const result: Record<string, unknown> = {};
  for (const k of ORDERED_KEYS) {
    if (k in body) {
      result[k] = body[k];
    }
  }
  // Append any remaining keys not in the ordered list (e.g. stop_sequences)
  // — but NOT metadata (already deleted in Step 4).
  for (const k of Object.keys(body)) {
    if (!ORDERED_KEYS.includes(k)) {
      result[k] = body[k];
    }
  }
  changed = true; // always rebuild — key order matters even if values same

  return changed ? result : null;
}

/** Normalize system field (string | array | undefined) to an array of text blocks. */
function normalizeSystemToArray(system: unknown): SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    return system.trim() ? [{ type: "text", text: system }] : [];
  }
  if (Array.isArray(system)) {
    const out: SystemBlock[] = [];
    for (const item of system) {
      if (typeof item === "string") {
        if (item.trim()) out.push({ type: "text", text: item });
      } else if (isPlainObject(item)) {
        const b = item as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({
            type: "text",
            text: b.text,
            ...(typeof b.cache_control === "object" && b.cache_control !== null
              ? { cache_control: b.cache_control as { type: "ephemeral" } }
              : {}),
          });
        }
      }
    }
    return out;
  }
  return [];
}

/** Rewrite "You are Claude Code..." → "You are ZCode model working in Claude Code." */
function rewriteClaudeCodeIdentity(blocks: SystemBlock[]): SystemBlock[] {
  return blocks.map(b => {
    if (b.text.includes(CLAUDE_CODE_IDENTITY)) {
      return { ...b, text: b.text.replace(CLAUDE_CODE_IDENTITY, ZCODE_IDENTITY_REPLACEMENT) };
    }
    return b;
  });
}

/**
 * Relocate `role: "system"` messages from the `messages` array to the `system` field.
 *
 * Claude Code places system instructions in `messages[].role = "system"`, but the
 * Anthropic Messages API requires system content in the top-level `system` field —
 * `role: "system"` is not a valid value inside `messages`. GLM's Anthropic-compatible
 * endpoint rejects this with 3001 "parameter error".
 *
 * Existing `system` content (string or array) is preserved; relocated system messages
 * are appended after any existing system blocks.
 */
function relocateSystemMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  const systemMsgs: Array<Record<string, unknown>> = [];
  const remaining: unknown[] = [];

  for (const msg of messages) {
    if (isPlainObject(msg) && msg.role === "system") {
      systemMsgs.push(msg);
    } else {
      remaining.push(msg);
    }
  }

  if (systemMsgs.length === 0) return false;

  // Move system messages out of the messages array
  body.messages = remaining;

  // Append their content to the top-level `system` field
  const newBlocks: Array<{ type: string; text: string }> = [];
  for (const msg of systemMsgs) {
    const content = msg.content;
    if (typeof content === "string" && content.trim()) {
      newBlocks.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (isPlainObject(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          newBlocks.push({ type: "text", text: block.text });
        }
      }
    }
  }

  if (newBlocks.length === 0) return true; // messages array was modified even if nothing to append

  // Merge with existing system field
  const existing = body.system;
  if (existing == null) {
    body.system = newBlocks;
  } else if (typeof existing === "string") {
    body.system = [{ type: "text", text: existing }, ...newBlocks];
  } else if (Array.isArray(existing)) {
    body.system = [...existing, ...newBlocks];
  }
  // If system is some other type, overwrite with newBlocks (shouldn't happen)

  return true;
}

/**
 * Strip `thinking` and `redacted_thinking` content blocks from every message's
 * `content` array.
 *
 * Problem: When the proxy enables thinking (`thinking: {type:"enabled"}`) on
 * the upstream, GLM returns `thinking_delta` SSE events in the assistant's
 * response. Claude Code captures these and, on the NEXT turn, echoes the
 * assistant's prior turn back in `messages[].content` — including the
 * `thinking` block (with an empty or invalid `signature`, since the proxy's
 * signature is not a real Anthropic cryptographic signature).
 *
 * GLM's Anthropic-compatible endpoint does NOT accept `thinking` /
 * `redacted_thinking` content blocks inside `messages[].content` — only the
 * top-level `thinking` field. Sending them produces
 * `400 {"code":3001,"msg":"parameter error"}` from the upstream, which the
 * proxy transparently forwards back to Claude Code. This is why the FIRST
 * turn succeeds (no assistant history yet) but every subsequent turn fails
 * with 3001 — until the conversation is reset.
 *
 * This function strips those blocks before forwarding, so GLM only sees
 * `text` / `image` / `tool_use` / `tool_result` blocks in message content.
 *
 * If stripping leaves a message's content array empty, that message is
 * removed from `messages` entirely (an empty assistant turn would also
 * trip GLM's parameter validation).
 *
 * If stripping leaves an ASSISTANT message with only non-text blocks (e.g.
 * only `tool_use` blocks — which happens when the original was
 * `[thinking, tool_use]` and thinking is stripped), an empty `text` block
 * is inserted at the front. ZCode's start-plan gateway rejects assistant
 * messages that contain only `tool_use` blocks with 3001 "parameter error"
 * — Anthropic's official API accepts them, but the gateway is stricter.
 * This was the root cause of the v2.1.3.6beta0 user report: rounds 3-5
 * had assistant messages `[tool_use]` (after thinking strip) and the
 * gateway 3001'd on round 7 once enough had accumulated.
 *
 * No-op for non-array `content` (string content is never a thinking block).
 */
function stripThinkingBlocksFromMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  const surviving: unknown[] = [];

  for (const msg of messages) {
    if (!isPlainObject(msg)) {
      surviving.push(msg);
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      surviving.push(msg);
      continue;
    }

    const filtered = content.filter((block: unknown) => {
      if (!isPlainObject(block)) return true;
      const type = block.type;
      // Strip both thinking variants. Anthropic's API defines:
      //   - "thinking"          — {type, thinking, signature}
      //   - "redacted_thinking" — {type, data}
      // GLM upstream rejects either as a content block in messages.
      return type !== "thinking" && type !== "redacted_thinking";
    });

    if (filtered.length === content.length) {
      // No thinking blocks found — keep message as-is
      surviving.push(msg);
      continue;
    }

    changed = true;
    if (filtered.length === 0) {
      // All blocks were thinking — drop the message entirely to avoid
      // sending an empty-content assistant turn upstream (which GLM also
      // rejects with 3001).
      continue;
    }
    msg.content = filtered;

    // If this is an assistant message that now has ONLY non-text blocks
    // (e.g. only tool_use), insert an empty text block at the front.
    // ZCode gateway rejects assistant messages with no text block.
    //
    // v2.1.3.10beta0: use a single space " " instead of empty string "" —
    // some gateways reject empty text blocks. A space renders as nothing
    // visible but is technically non-empty.
    if (msg.role === "assistant") {
      const hasText = filtered.some((b: unknown) =>
        isPlainObject(b) && b.type === "text"
      );
      if (!hasText) {
        msg.content = [{ type: "text", text: " " }, ...filtered];
      }
    }

    surviving.push(msg);
  }

  if (changed) {
    body.messages = surviving;
  }
  return changed;
}

/**
 * Ensure every assistant message has at least one `text` content block.
 *
 * ZCode's start-plan gateway rejects assistant messages that contain only
 * `tool_use` blocks (no text) with 3001 "parameter error". Anthropic's
 * official API accepts assistant messages with only tool_use blocks, but
 * the gateway is stricter.
 *
 * This can happen in two scenarios:
 *   1. Claude Code sends an assistant message with `[thinking, tool_use]`
 *      and stripThinkingBlocksFromMessages removes the thinking block,
 *      leaving only `[tool_use]`.
 *   2. Claude Code sends an assistant message with only `[tool_use]`
 *      directly (less common, but possible when the model calls a tool
 *      without any preamble text).
 *
 * In both cases, we insert an empty `text` block at the front of the
 * content array. The empty text is harmless — it renders as nothing in
 * the conversation, but satisfies the gateway's requirement that
 * assistant messages have a text block.
 *
 * No-op for:
 *   - Non-array content (string content is already text)
 *   - Messages that already have a text block
 *   - Non-assistant messages (user messages can be all tool_result)
 */
function ensureAssistantTextBlock(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    const hasText = content.some((b: unknown) =>
      isPlainObject(b) && b.type === "text"
    );
    if (!hasText) {
      // Insert a single-space text block at the front.
      // v2.1.3.10beta0: use " " instead of "" — some gateways reject
      // empty text blocks. A space renders as nothing visible but is
      // technically non-empty.
      content.unshift({ type: "text", text: " " });
      changed = true;
    }
  }
  return changed;
}

/**
 * Sanitize content blocks in `messages[].content` to remove fields that GLM
 * upstream / ZCode gateway reject with 3001 "parameter error".
 *
 * Strips the following fields:
 *
 * 1. `cache_control`:
 *    - **start-plan mode**: stripped from ALL blocks (including text). The
 *      ZCode gateway rejects cache_control on every block type, not just
 *      non-text. v2.1.3.9beta0 fix — prior versions incorrectly assumed
 *      text-block cache_control was safe.
 *    - **coding-plan mode**: stripped from non-text blocks only (tool_result,
 *      tool_use, image, etc.). Direct GLM API accepts cache_control on text
 *      blocks, so we keep it for prompt caching.
 *
 * 2. `is_error` (tool_result blocks only):
 *    - Stripped in BOTH modes. Anthropic's official API accepts `is_error` on
 *      tool_result blocks, but the ZCode gateway does not — it returns 3001.
 *      This field is informational (Claude Code sets it to `false` on success)
 *      and the upstream infers success/failure from the content, so removing
 *      it is safe.
 *
 * Root cause history:
 *   - v2.1.3.3beta0: stripped thinking blocks (round-2 3001)
 *   - v2.1.3.5beta0: stripped cache_control from tool_result (round-3 3001)
 *   - v2.1.3.6beta0: stripped cache_control from tool_use (round-3 3001 variant)
 *   - v2.1.3.9beta0: strip cache_control from text too in start-plan;
 *                    strip is_error from tool_result in both modes
 */
function sanitizeContentBlocks(
  body: Record<string, unknown>,
  startPlan?: boolean,
  alignZCodeFormat?: boolean,
): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isPlainObject(block)) continue;

      // cache_control stripping — see function header for mode logic.
      if ("cache_control" in block) {
        let shouldStrip: boolean;
        if (alignZCodeFormat) {
          // alignZCodeFormat: NEVER strip cache_control. Real ZCode client
          // keeps cache_control on the last user message's text block
          // (sample: messages[122].content[3] role=user type=text).
          // Stripping it removes the client's prompt-cache breakpoint,
          // hurting cache hit rate AND creating a fingerprint mismatch.
          shouldStrip = false;
        } else if (startPlan) {
          shouldStrip = true; // start-plan: strip from ALL blocks (including text)
        } else {
          shouldStrip = block.type !== "text"; // coding-plan: strip from non-text only
        }
        if (shouldStrip) {
          delete block.cache_control;
          changed = true;
        }
      }

      // is_error stripping on tool_result blocks.
      // alignZCodeFormat: KEEP is_error — real ZCode client preserves it
      // (sample: messages[6].content[0] has is_error=true on a timeout result).
      // Non-align modes: strip (ZCode gateway doesn't accept this field — 3001).
      if (!alignZCodeFormat && block.type === "tool_result" && "is_error" in block) {
        delete block.is_error;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Normalize `tool_result.content` from string to array format.
 *
 * Anthropic's official API accepts both formats for `tool_result.content`:
 *   - string:  `{ type: "tool_result", content: "result text" }`
 *   - array:   `{ type: "tool_result", content: [{ type: "text", text: "..." }] }`
 *
 * Claude Code sends the **string** format. However, the ZCode gateway (and
 * some other Anthropic-compatible upstreams) ONLY accepts the **array** format
 * and rejects the string format with 3001 "parameter error".
 *
 * This function converts string content to the array format by wrapping it in
 * a single text block. Array content is left untouched. Non-tool_result blocks
 * are not affected.
 *
 * No-op if `messages` is missing or not an array.
 */
function normalizeToolResultContent(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type !== "tool_result") continue;

      // Convert string content to array format.
      // Anthropic accepts both, but ZCode gateway requires array.
      // v2.1.3.11beta0: empty string → single space (non-empty placeholder),
      // matching normalizeAllMessageContent's behavior. ZCode gateway rejects
      // empty text blocks.
      if (typeof block.content === "string") {
        const text = block.content.length > 0 ? block.content : " ";
        block.content = [{ type: "text", text }];
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Normalize ALL message `content` from string to array format.
 *
 * Anthropic's official API accepts both formats for message content:
 *   - string:  `{ role: "user", content: "hello" }`
 *   - array:   `{ role: "user", content: [{ type: "text", text: "hello" }] }`
 *
 * Claude Code sends simple text as **string** and complex content (with tools,
 * images, etc.) as **array**. Some Anthropic-compatible gateways (including
 * ZCode's start-plan gateway) are stricter and ONLY accept the array format,
 * rejecting string content with 3001 "parameter error".
 *
 * This function converts ALL string `content` to the array format by wrapping
 * in a single text block. Array content is left untouched.
 *
 * v2.1.3.10beta0: previously only `tool_result.content` was normalized. We now
 * normalize ALL message content (user + assistant) because the gateway's
 * strictness may apply to all message types, not just tool_result.
 *
 * v2.1.3.11beta0: **empty string content** is converted to `[{type:"text",
 * text:" "}]` (single space) instead of `[{type:"text", text:""}]` (empty).
 * This is the same fix as `ensureAssistantTextBlock`'s non-empty placeholder,
 * but applied at the normalize layer so it catches empty strings produced by
 * the Responses API translator (which `ensureAssistantTextBlock` cannot see,
 * because the translator emits `""` as a *string*, not as a missing-text-block
 * scenario). The Responses API translator produces empty strings in several
 * cases:
 *   - `translateMessageContent` returns `""` for empty/missing content
 *   - `mergeContent` collapses all-empty-text blocks to `""`
 *   - `function_call_output` emits `content: ""` when output is empty
 * Without this fix, these empty strings become `[{type:"text", text:""}]`
 * after normalization — an empty text block that the ZCode gateway rejects.
 *
 * No-op if `messages` is missing or not an array.
 */
function normalizeAllMessageContent(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;

  let changed = false;
  for (const msg of messages) {
    if (!isPlainObject(msg)) continue;
    if (typeof msg.content === "string") {
      // v2.1.3.11beta0: empty string → single space (non-empty placeholder).
      // ZCode gateway rejects empty text blocks; a space is invisible but
      // technically non-empty.
      const text = msg.content.length > 0 ? msg.content : " ";
      msg.content = [{ type: "text", text }];
      changed = true;
    }
  }
  return changed;
}

/**
 * start-plan: prepend ZCode gateway system blocks. The gateway rejects
 * requests without these identity blocks with 3012 "method not allowed".
 *
 * Returns true only if the body's system field was actually changed —
 * short-circuits the `JSON.stringify(transformedObj)` in handler.ts when
 * the body already had the official blocks in the right position, saving
 * ~5ms on a 90KB body for the common case of repeated identical requests.
 */
function applyStartPlanSystem(body: Record<string, unknown>): boolean {
  // Idempotency check: if `body.system` already starts with the official
  // ZCode blocks (e.g. on retry/replay where a previous transform already
  // injected them), DON'T re-inject. buildStartPlanSystem() would otherwise
  // concatenate official blocks + the user blocks (which themselves now
  // contain the official blocks), producing [official, official, client...]
  // — a 5-block system instead of 3-block.
  //
  // Detection: walk the first N=official_blocks positions of cur and check
  // each text matches. If all match, the official prefix is already there.
  const cur = body.system;
  const officialTexts = ZCODE_SYSTEM_BLOCKS.map(b => b.text);
  if (Array.isArray(cur) && cur.length >= officialTexts.length) {
    let alreadyInjected = true;
    for (let i = 0; i < officialTexts.length; i++) {
      const c = cur[i] as { text?: string } | undefined;
      if (!c || c.text !== officialTexts[i]) {
        alreadyInjected = false;
        break;
      }
    }
    if (alreadyInjected) {
      return false;
    }
  }
  const newSystem = buildStartPlanSystem(body.system);
  body.system = newSystem;
  return true;
}

/**
 * Tests for body transformer.
 * @see _reverse/NOTEPAD.md "How Credential is Used for LLM Calls"
 */
import { describe, it, expect } from "bun:test";
import { transformRequestBody } from "./body-transformer.js";

describe("transformRequestBody — general", () => {
  it("returns undefined unchanged", () => {
    expect(transformRequestBody(undefined, { format: "openai" })).toBeUndefined();
  });

  it("returns empty string unchanged", () => {
    expect(transformRequestBody("", { format: "openai" })).toBe("");
  });

  it("returns original body on JSON parse failure", () => {
    const broken = "{not valid json";
    expect(transformRequestBody(broken, { format: "openai" })).toBe(broken);
  });

  it("returns original body when JSON is not an object", () => {
    expect(transformRequestBody("[1,2,3]", { format: "openai" })).toBe("[1,2,3]");
    expect(transformRequestBody("\"hello\"", { format: "openai" })).toBe("\"hello\"");
  });

  it("returns original body when no transformation applies", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });
});

describe("transformRequestBody — stream_options.include_usage (OpenAI)", () => {
  it("injects stream_options.include_usage when stream:true and missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [], stream: true });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options fields, only adds include_usage", () => {
    const body = JSON.stringify({ stream: true, stream_options: { some_other: "x" } });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ some_other: "x", include_usage: true });
  });

  it("does NOT touch body when stream_options.include_usage already true", () => {
    const body = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is false", () => {
    const body = JSON.stringify({ stream: false });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject when stream is missing", () => {
    const body = JSON.stringify({ model: "glm-4.6", messages: [] });
    expect(transformRequestBody(body, { format: "openai" })).toBe(body);
  });

  it("does NOT inject for anthropic format (Anthropic API has no stream_options)", () => {
    const body = JSON.stringify({ stream: true });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // stream_options should NOT be injected (Anthropic API has no such field)
    expect(parsed.stream_options).toBeUndefined();
    // vceshi0.1.7+: injectZCodeThinkingFormat now forces max_tokens=64000
    // unconditionally on Anthropic requests (matches ZCode's wire shape).
    expect(parsed.max_tokens).toBe(64000);
  });
});

describe("transformRequestBody — cache_control (Anthropic)", () => {
  it("adds cache_control to last user message with string content", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second question" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last user msg content converted to array with cache_control on the block
    expect(parsed.messages[2].content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
    // Earlier messages: v2.1.3.10beta0 normalizes string content to array
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "first question" }]);
    expect(parsed.messages[1].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("adds cache_control to last content block when content is already array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT overwrite existing cache_control on last block", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: existing }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content[0].cache_control).toEqual(existing);
  });

  it("skips system messages — relocates them to system field and finds last non-system", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q1" },
        { role: "system", content: "sys-prompt" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // v0.1.9+: alignZCodeFormat is always-on. System message stays in messages[]
    // (real ZCode behavior) — it is NOT relocated to top-level system field.
    // The user msg (index 0) is the last non-system; gets cache_control.
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System message stays in messages[]
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[1].role).toBe("system");
    // Top-level system field is the ZCode official blocks (NOT the relocated msg)
    expect(Array.isArray(parsed.system)).toBe(true);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");
  });

  it("does nothing to messages when messages array is empty", () => {
    const body = JSON.stringify({ messages: [] });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // messages stays empty (no cache_control added, no relocation)
    expect(parsed.messages).toEqual([]);
    // vceshi0.1.7+: max_tokens=64000 still injected unconditionally
    expect(parsed.max_tokens).toBe(64000);
  });

  it("keeps system-only messages in messages[] (v0.1.9+: no relocation)", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // v0.1.9+: alignZCodeFormat is always-on. System message stays in messages[]
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0].role).toBe("system");
    // Top-level system field is the ZCode official blocks (not the relocated msg)
    expect(Array.isArray(parsed.system)).toBe(true);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");
  });

  it("does NOT apply cache_control for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    expect(out).toBe(body);
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-4.6" });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // No crash, no messages field added
    expect(parsed.messages).toBeUndefined();
    // vceshi0.1.7+: max_tokens=64000 still injected unconditionally
    expect(parsed.max_tokens).toBe(64000);
  });
});

describe("transformRequestBody — combined behavior", () => {
  it("OpenAI streaming body is only stream_options-modified (no cache_control)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream_options).toEqual({ include_usage: true });
    expect(parsed.messages[0].content).toBe("hi");
  });
});

describe("transformRequestBody — transform unsupported fields (Anthropic)", () => {
  it("converts thinking type 'adaptive' to 'enabled' for GLM", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // adaptive → enabled (by transformUnsupportedAnthropicFields), then
    // injectZCodeThinkingFormat re-adds budget_tokens=32000 (default since v0.1.9)
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(32000);
    expect(parsed.model).toBe("glm-4.6");
  });

  it("converts thinking type 'enabled' with budget_tokens to simple 'enabled' for GLM, then re-injects ZCode budget", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 10000 },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Client budget_tokens is stripped by transformUnsupportedAnthropicFields,
    // then injectZCodeThinkingFormat re-adds the ZCode value (32000).
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(32000); // ZCode value, not client's 10000
  });

  it("passes thinking type 'disabled' through unchanged", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking).toEqual({ type: "disabled" });
  });

  it("removes context_management field", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.context_management).toBeUndefined();
  });

  it("removes output_config field (then injectZCodeThinkingFormat re-adds ZCode value when thinking enabled)", () => {
    // When thinking is NOT enabled, output_config is stripped and stays gone.
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.output_config).toBeUndefined();
  });

  it("handles all transformations at once", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "test" }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "low" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // thinking adaptive → enabled, then injectZCodeThinkingFormat adds budget_tokens=32000
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(32000);
    expect(parsed.context_management).toBeUndefined();
    // output_config was stripped by transformUnsupportedAnthropicFields, then
    // re-added by injectZCodeThinkingFormat with the ZCode value (effort=max)
    expect(parsed.output_config).toEqual({ effort: "max" });
    expect(parsed.model).toBe("glm-5.2");
  });

  it("does NOT transform fields for openai format", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // thinking is not transformed for openai format
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });
});


describe("transformRequestBody — strip thinking blocks from messages (Anthropic)", () => {
  it("removes thinking content blocks from assistant messages", () => {
    // Reproduces the exact Claude Code round-2 request that triggers 3001:
    // assistant history contains a thinking block (with empty signature)
    // echoed back from the previous turn's thinking_delta SSE events.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好啊" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋..." },
          ],
        },
        { role: "user", content: "帮我看看这个项目是干嘛的" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "你好!👋..." },
    ]);
  });

  it("also strips redacted_thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "opaque-base64==" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // redacted_thinking stripped; text block kept
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops an assistant message entirely if it contained ONLY thinking blocks", () => {
    // An empty-content assistant turn would itself trigger 3001, so the
    // whole message must be removed.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal", signature: "x" }],
        },
        { role: "user", content: "follow-up" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Assistant message gone; only the two user messages remain.
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[1].role).toBe("user");
    expect(parsed.messages.find((m: any) => m.role === "assistant")).toBeUndefined();
  });

  it("preserves tool_use blocks alongside thinking blocks", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // thinking block gone, tool_use preserved
    // After v2.1.3.7beta0: empty text block inserted at front (gateway requires
    // assistant messages to have a text block)
    // v2.1.3.10beta0: text is " " (space) instead of "" (some gateways reject empty)
    expect(parsed.messages[0].content.length).toBe(2);
    expect(parsed.messages[0].content[0].type).toBe("text");
    expect(parsed.messages[0].content[0].text).toBe(" ");
    expect(parsed.messages[0].content[1].type).toBe("tool_use");
    expect(parsed.messages[0].content[1].id).toBe("t1");
    expect(parsed.messages[0].content[1].name).toBe("Bash");
    expect(parsed.messages[0].content[1].input).toEqual({ cmd: "ls" });
    // tool_result preserved, cache_control NOT attached to it (gateway rejects)
    expect(parsed.messages[1].content[0].type).toBe("tool_result");
    expect(parsed.messages[1].content[0].tool_use_id).toBe("t1");
    expect(parsed.messages[1].content[0].cache_control).toBeUndefined();
  });

  it("does NOT touch string content (no thinking blocks possible)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "next" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // v2.1.3.10beta0: string content normalized to array; cache_control lands
    // on last user msg's text block, not on assistant
    expect(parsed.messages[1].content).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("leaves messages without thinking blocks unchanged (apart from other transformations)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(1);
    expect(parsed.messages[0].content[0].type).toBe("text");
  });

  it("does NOT strip thinking blocks for openai format", () => {
    // openai format is forwarded to /chat/completions which has its own
    // schema; thinking-block stripping is Anthropic-specific.
    const body = JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content.length).toBe(2);
    expect(parsed.messages[0].content[0].type).toBe("thinking");
  });

  it("handles missing messages field gracefully", () => {
    const body = JSON.stringify({ model: "glm-5.2" });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // No crash, messages not added
    expect(parsed.messages).toBeUndefined();
    // vceshi0.1.7+: max_tokens=64000 still injected unconditionally
    expect(parsed.max_tokens).toBe(64000);
  });

  it("strips thinking from multi-turn conversation (Claude Code regression case)", () => {
    // End-to-end shape: round-2 request from Claude Code with full history.
    // Verifies the fix unblocks multi-turn Claude Code sessions.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好啊" }] },
        { role: "system", content: "agent types and skills..." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户用中文打招呼...", signature: "" },
            { type: "text", text: "你好!👋 我是 ZCode..." },
          ],
        },
        { role: "user", content: [{ type: "text", text: "帮我看看这个项目是干嘛的" }] },
      ],
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // Top-level Claude-Code-only fields are stripped/normalized.
    // Since v0.1.9, injectZCodeThinkingFormat re-adds budget_tokens=32000
    // and output_config.effort=max to match the real ZCode client.
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(32000);
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toEqual({ effort: "max" });

    // v0.1.9+: alignZCodeFormat is always-on. System message stays in messages[]
    // (NOT relocated to top-level system). Top-level system is the ZCode official blocks.
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeDefined();
    expect(Array.isArray(parsed.system)).toBe(true);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");

    // Thinking block stripped from assistant history
    const assistant = parsed.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "你好!👋 我是 ZCode..." }]);
  });
});


describe("transformRequestBody — v2.1.3.11beta0: empty string content → non-empty space (Responses API path)", () => {
  it("converts empty string user content to non-empty text block", () => {
    // The Responses API translator (responses-to-anthropic.ts) produces empty
    // strings in several cases:
    //   - translateMessageContent returns "" for empty/missing content
    //   - mergeContent collapses all-empty-text blocks to ""
    //   - function_call_output emits content: "" when output is empty
    // These empty strings become [{type:"text", text:""}] after normalization
    // — an empty text block that the ZCode gateway rejects with 3001.
    // v2.1.3.11beta0 fix: empty string → single space " " (non-empty).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "" },  // empty string from translator
        { role: "assistant", content: "ok" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    // Empty string should become a non-empty text block (single space)
    expect(Array.isArray(parsed.messages[0].content)).toBe(true);
    expect(parsed.messages[0].content[0].type).toBe("text");
    expect(parsed.messages[0].content[0].text).toBe(" ");
  });

  it("converts empty string assistant content to non-empty text block", () => {
    // Same fix applies to assistant messages — empty assistant turns are
    // produced by the translator when output_text items have no text.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },  // empty string
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    expect(Array.isArray(parsed.messages[1].content)).toBe(true);
    expect(parsed.messages[1].content[0].type).toBe("text");
    expect(parsed.messages[1].content[0].text).toBe(" ");
  });

  it("preserves non-empty string content as-is (no space substitution)", () => {
    // Only EMPTY strings get the space substitution. Non-empty strings pass
    // through as their actual text value.
    // v0.1.9+: applyAnthropicCacheControl adds cache_control to the last user
    // message's text block (alignment is always-on, even in start-plan).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello world" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "hello world", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("Responses API full regression: function_call_output with empty output", () => {
    // Reproduces a Codex CLI scenario where function_call_output has empty
    // output. The translator produces tool_result with content: "".
    // v0.1.9+: alignZCodeFormat is always-on. We DON'T normalize tool_result
    // content from string to array (real ZCode sends string). Empty string
    // stays as empty string (wire-format aligned with real ZCode).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "run tool" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Shell", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);

    // v0.1.9+: tool_result.content stays as STRING (real ZCode behavior).
    // Empty string is preserved as-is — wire alignment takes priority over
    // gateway strictness workaround.
    const toolResult = parsed.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(typeof toolResult.content).toBe("string");
    expect(toolResult.content).toBe("");
  });
});


describe("transformRequestBody — injectZCodeThinkingFormat (WAF fingerprint alignment, default ON since v0.1.9)", () => {
  // The real ZCode desktop client sends these EXACT values when thinking is
  // enabled. Since v0.1.9, the proxy UNCONDITIONALLY rewrites any Anthropic
  // request with thinking.type === "enabled" to match — no config flag needed.
  // Source: reverse-engineered ZCode Electron client traffic (2026-06).
  const EXPECTED_MAX_TOKENS = 64000;
  const EXPECTED_BUDGET_TOKENS = 32000;
  const EXPECTED_EFFORT = "max";

  it("injects max_tokens + budget_tokens + output_config when thinking is enabled (default behavior, no flag needed)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    // Note: no injectThinkingFormat flag in ctx — it's unconditional now.
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(EXPECTED_MAX_TOKENS);
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(EXPECTED_BUDGET_TOKENS);
    expect(parsed.output_config).toEqual({ effort: EXPECTED_EFFORT });
  });

  it("overwrites client-sent budget_tokens with the ZCode value", () => {
    // Claude Code sends { type: "enabled", budget_tokens: 5000 }.
    // transformUnsupportedAnthropicFields strips budget_tokens first
    // (simplifies to { type: "enabled" }), then injectZCodeThinkingFormat
    // re-adds it with the ZCode value.
    const body = JSON.stringify({
      model: "glm-5.2",
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking.budget_tokens).toBe(EXPECTED_BUDGET_TOKENS);
    expect(parsed.max_tokens).toBe(EXPECTED_MAX_TOKENS);
    expect(parsed.output_config).toEqual({ effort: EXPECTED_EFFORT });
  });

  it("handles adaptive thinking (Claude Code sends type: adaptive)", () => {
    // Claude Code sometimes sends { type: "adaptive" }.
    // transformUnsupportedAnthropicFields converts to { type: "enabled" },
    // then injectZCodeThinkingFormat kicks in.
    const body = JSON.stringify({
      model: "glm-5.2",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(EXPECTED_BUDGET_TOKENS);
    expect(parsed.output_config).toEqual({ effort: EXPECTED_EFFORT });
  });

  it("only injects max_tokens when thinking is disabled (ZCode no-thinking mode)", () => {
    // vceshi0.1.7+: when client sends thinking.type=disabled (or doesn't send
    // thinking at all), the proxy mirrors ZCode's "不思考" wire shape — only
    // max_tokens=64000 is injected, no thinking field is added, no output_config.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000); // forced to ZCode value
    expect(parsed.thinking).toEqual({ type: "disabled" }); // preserved as-is
    expect(parsed.output_config).toBeUndefined(); // not injected
  });

  it("only injects max_tokens when thinking is absent (ZCode no-thinking mode)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000); // forced to ZCode value
    expect(parsed.thinking).toBeUndefined(); // not added
    expect(parsed.output_config).toBeUndefined(); // not injected
  });

  it("is a no-op for OpenAI format (inject only applies to Anthropic)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(1000);
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
  });

  it("idempotent: running twice produces the same result", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const ctx = { format: "anthropic" as const };
    const out1 = transformRequestBody(body, ctx);
    const out2 = transformRequestBody(out1 as string, ctx);
    expect(out2).toBe(out1);
  });
});

describe("transformRequestBody — thinkingLevel (vceshi0.1.7+ tier selector: high / max)", () => {
  it("default tier is max: budget_tokens=32000, effort=max", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    // No thinkingLevel in ctx → defaults to "max"
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000);
    expect(parsed.thinking.budget_tokens).toBe(32000);
    expect(parsed.output_config).toEqual({ effort: "max" });
  });

  it("thinkingLevel=max explicitly: budget_tokens=32000, effort=max", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 9999 },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", thinkingLevel: "max" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000);
    expect(parsed.thinking.budget_tokens).toBe(32000); // client's 9999 overwritten
    expect(parsed.output_config).toEqual({ effort: "max" });
  });

  it("thinkingLevel=high: budget_tokens=16000, effort=high", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 9999 },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", thinkingLevel: "high" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000);
    expect(parsed.thinking.budget_tokens).toBe(16000); // ZCode high tier value
    expect(parsed.output_config).toEqual({ effort: "high" });
  });

  it("thinkingLevel=high works with adaptive thinking (Claude Code)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", thinkingLevel: "high" });
    const parsed = JSON.parse(out as string);
    // transformUnsupportedAnthropicFields converts adaptive→enabled
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(16000); // high tier
    expect(parsed.output_config).toEqual({ effort: "high" });
  });

  it("thinkingLevel does NOT force thinking on when client didn't send thinking", () => {
    // Even with thinkingLevel=high, if client didn't send thinking, we don't
    // add it — the dashboard tier selector only controls high vs max intensity,
    // not on/off. To enable thinking, the user must configure it client-side.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", thinkingLevel: "high" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000); // forced
    expect(parsed.thinking).toBeUndefined(); // NOT added
    expect(parsed.output_config).toBeUndefined(); // NOT added
  });

  it("thinkingLevel does NOT force thinking on when client sent thinking.type=disabled", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", thinkingLevel: "high" });
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(64000);
    expect(parsed.thinking).toEqual({ type: "disabled" }); // preserved
    expect(parsed.output_config).toBeUndefined(); // NOT injected
  });

  it("switching tier from max to high updates budget_tokens + effort", () => {
    // Idempotency: first run with max, second run with high — values should update.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const outMax = transformRequestBody(body, { format: "anthropic", thinkingLevel: "max" });
    const outHigh = transformRequestBody(outMax as string, { format: "anthropic", thinkingLevel: "high" });
    const parsed = JSON.parse(outHigh as string);
    expect(parsed.thinking.budget_tokens).toBe(16000);
    expect(parsed.output_config).toEqual({ effort: "high" });
  });

  it("thinkingLevel is irrelevant for OpenAI format (no injection)", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      max_tokens: 1000,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", thinkingLevel: "high" });
    // OpenAI path doesn't go through injectZCodeThinkingFormat
    const parsed = JSON.parse(out as string);
    expect(parsed.max_tokens).toBe(1000); // unchanged
    expect(parsed.thinking).toBeUndefined();
  });
});

describe("transformRequestBody — alignZCodeFormat (ZCode wire format alignment)", () => {
  it("reorders top-level fields to match real ZCode client", () => {
    // Input with arbitrary key order
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const keys = Object.keys(parsed);
    // Expected order: model, max_tokens, thinking, output_config (injected),
    // system (injected), messages, tools (n/a), tool_choice (n/a), stream
    expect(keys[0]).toBe("model");
    expect(keys[1]).toBe("max_tokens");
    expect(keys[2]).toBe("thinking");
    expect(keys[3]).toBe("output_config"); // injected by injectZCodeThinkingFormat
    expect(keys[4]).toBe("system"); // injected by alignZCodeRequestFormat
    expect(keys.indexOf("messages")).toBeGreaterThan(keys.indexOf("system"));
    expect(keys.indexOf("stream")).toBeGreaterThan(keys.indexOf("messages"));
  });

  it("injects ZCode official system blocks (both coding-plan AND start-plan)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    // coding-plan
    const outCoding = transformRequestBody(body, { format: "anthropic", startPlan: false });
    const parsedCoding = JSON.parse(outCoding as string);
    expect(Array.isArray(parsedCoding.system)).toBe(true);
    expect(parsedCoding.system.length).toBeGreaterThanOrEqual(2); // 2 ZCode blocks
    expect(parsedCoding.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(parsedCoding.system[0].cache_control).toEqual({ type: "ephemeral" });
    // start-plan
    const outStart = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsedStart = JSON.parse(outStart as string);
    expect(Array.isArray(parsedStart.system)).toBe(true);
    expect(parsedStart.system[0].text).toBe("You are ZCode, an interactive coding agent");
  });

  it("appends client's original system blocks AFTER the ZCode blocks", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
      system: [
        { type: "text", text: "Custom client instructions" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // 2 ZCode blocks + 1 client block = 3
    expect(parsed.system.length).toBe(3);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(parsed.system[2].text).toBe("Custom client instructions");
  });

  it("rewrites 'You are Claude Code' → 'You are ZCode model working in Claude Code'", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: "Some harness instructions" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Find the rewritten block (it's in the client blocks, after the 2 ZCode blocks)
    const clientBlocks = parsed.system.slice(2);
    const identityBlock = clientBlocks.find((b: any) => b.text.includes("You are ZCode model working in Claude Code"));
    expect(identityBlock).toBeDefined();
    expect(identityBlock.text).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("rewrites 'You are Claude Code, Anthropic\\'s official CLI for Claude, running within the Claude Agent SDK.' (newer variant)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
        { type: "text", text: "Some harness instructions" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const clientBlocks = parsed.system.slice(2);
    const identityBlock = clientBlocks.find((b: any) => b.text.includes("You are ZCode model working in Claude Code"));
    expect(identityBlock).toBeDefined();
    expect(identityBlock.text).not.toContain("You are Claude Code, Anthropic's official CLI for Claude");
  });

  it("also rewrites identity in messages[].role: 'system' content", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Be helpful." },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const sysMsg = parsed.messages.find((m: any) => m.role === "system");
    expect(sysMsg).toBeDefined();
    // normalizeAllMessageContent converts string content to array
    const text = Array.isArray(sysMsg.content)
      ? sysMsg.content.map((b: any) => b.text || "").join("")
      : String(sysMsg.content);
    expect(text).toContain("You are ZCode model working in Claude Code");
    expect(text).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("does NOT relocate system role from messages (keeps them in messages[])", () => {
    // v0.1.9+: alignZCodeFormat is always-on. The system role message stays
    // in messages[] (matching real ZCode behavior — sample has 5 role:system
    // messages in messages[], not moved to top-level system field).
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "The Bash tool shell was changed by the user." },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // The system role message should STILL be in messages (not relocated)
    const sysInMessages = parsed.messages.find((m: any) => m.role === "system");
    expect(sysInMessages).toBeDefined();
    // normalizeAllMessageContent converts string content to array
    const text = Array.isArray(sysInMessages.content)
      ? sysInMessages.content.map((b: any) => b.text || "").join("")
      : String(sysInMessages.content);
    expect(text).toContain("Bash tool shell was changed");
  });

  it("is a no-op for OpenAI format", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // No system injection for OpenAI
    expect(parsed.system).toBeUndefined();
  });

  it("idempotent: running twice produces the same result", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const ctx = { format: "anthropic" as const };
    const out1 = transformRequestBody(body, ctx);
    const out2 = transformRequestBody(out1 as string, ctx);
    // Second run should produce same output (no duplicate system blocks)
    const p1 = JSON.parse(out1 as string);
    const p2 = JSON.parse(out2 as string);
    expect(p2.system.length).toBe(p1.system.length);
    expect(p2.system[0].text).toBe(p1.system[0].text);
  });

  it("strips x-anthropic-billing-header system block", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.195; cc_entrypoint=claude-vscode;" },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const billingBlock = parsed.system.find((b: any) => b.text.includes("x-anthropic-billing-header"));
    expect(billingBlock).toBeUndefined();
  });

  it("preserves 'Claude Code' references in harness instructions (functional descriptions)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
      system: [
        { type: "text", text: "Claude Code is available as a CLI. Fast mode for Claude Code uses Claude Opus." },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Client system blocks are after the 2 ZCode official blocks
    const clientBlocks = parsed.system.slice(2);
    const harnessBlock = clientBlocks.find((b: any) => b.text.includes("available as a CLI"));
    expect(harnessBlock).toBeDefined();
    // "Claude Code" references in harness instructions are preserved — they are
    // functional descriptions the model relies on, not identity strings.
    expect(harnessBlock.text).toContain("Claude Code is available as a CLI");
  });
});

describe("transformRequestBody — alignZCodeFormat (field fill + drop, v0.2.0+)", () => {
  it("fills tool_choice: { type: 'auto' } when tools are present but tool_choice is missing", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", description: "read", input_schema: {} }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.tool_choice).toEqual({ type: "auto" });
  });

  it("does NOT add tool_choice when tools array is empty", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.tool_choice).toBeUndefined();
  });

  it("preserves client's existing tool_choice (doesn't overwrite)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", description: "read", input_schema: {} }],
      tool_choice: { type: "any" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.tool_choice).toEqual({ type: "any" }); // preserved, not overwritten
  });

  it("forces stream: true when client didn't send it (v0.2.0.4+: align ZCode wire shape)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // v0.2.0.4+: stream is ALWAYS forced to true (matches real ZCode client).
    expect(parsed.stream).toBe(true);
  });

  it("overrides client's stream: false to true (v0.2.0.4+: align ZCode wire shape)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // v0.2.0.4+: stream:false is overridden to true (matches real ZCode client).
    expect(parsed.stream).toBe(true);
  });

  it("drops metadata field (Claude Code's user_id tracking — real ZCode never sends it)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "device-123" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("complete alignment: Claude Code request → real ZCode wire format", () => {
    // Mimics Claude Code's actual request shape (model→messages→system→tools→metadata→max_tokens→thinking)
    // v0.2.0.4+: stream:true is forced unconditionally inside alignZCodeRequestFormat
    // to match the real ZCode desktop client's wire shape. The test no longer needs
    // to send stream:true explicitly.
    const body = JSON.stringify({
      model: "glm5.1",
      messages: [{ role: "user", content: "hi" }],
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      tools: [{ name: "Read", description: "read", input_schema: {} }],
      metadata: { user_id: "device-xyz" },
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const keys = Object.keys(parsed);

    // 1. Field order matches real ZCode exactly
    expect(keys[0]).toBe("model");
    expect(keys[1]).toBe("max_tokens");
    expect(keys[2]).toBe("thinking");
    expect(keys[3]).toBe("output_config");
    expect(keys[4]).toBe("system");
    expect(keys[5]).toBe("messages");
    expect(keys[6]).toBe("tools");
    expect(keys[7]).toBe("tool_choice");
    expect(keys[8]).toBe("stream");

    // 2. No metadata (dropped)
    expect(parsed.metadata).toBeUndefined();

    // 3. tool_choice filled
    expect(parsed.tool_choice).toEqual({ type: "auto" });

    // 4. stream forced to true (v0.2.0.4+: aligns with real ZCode client)
    expect(parsed.stream).toBe(true);

    // 5. max_tokens forced to 64000 (thinking enabled)
    expect(parsed.max_tokens).toBe(64000);

    // 6. thinking simplified + budget injected
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });

    // 7. output_config injected
    expect(parsed.output_config).toEqual({ effort: "max" });

    // 8. system starts with 2 ZCode blocks, then client's (rewritten) block
    expect(parsed.system.length).toBe(3);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(parsed.system[2].text).toContain("You are ZCode model working in Claude Code");
    expect(parsed.system[2].text).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.");

    // 9. v0.2.0.5: last system block carries cache_control (mirrors real ZCode
    // client's prompt-cache breakpoint — without this, the wire shape is
    // [cc, cc, no-cc] vs real ZCode's [cc, cc, cc]).
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("v0.2.0.5: injects cache_control on last user-provided system block (Codex instructions case)", () => {
    // Mimics Codex CLI's instructions field (a long string with no cache_control)
    // being translated to Anthropic system. The proxy should inject cache_control
    // on the resulting last block to match real ZCode client's wire shape.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      system: "You are Codex, an elite System Architect...",
      max_tokens: 4096,
      thinking: { type: "enabled" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // 3 blocks: 2 official ZCode + 1 user-provided (the Codex instructions)
    expect(parsed.system.length).toBe(3);
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" }); // official
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" }); // official
    // v0.2.0.5: last block now carries cache_control (was missing before)
    expect(parsed.system[2].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[2].text).toBe("You are Codex, an elite System Architect...");
  });

  it("v0.2.0.5: does NOT overwrite existing cache_control on last system block", () => {
    // If the client already set cache_control on their last system block, we
    // preserve it (idempotent injection).
    const existingCc = { type: "ephemeral" };
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      system: [{ type: "text", text: "client system", cache_control: existingCc }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // Last block (user-provided) should still have its cache_control unchanged
    expect(parsed.system[2].cache_control).toEqual(existingCc);
  });

  it("v0.2.0.5: when no user-provided system blocks, last official block keeps its cc", () => {
    // Edge case: client didn't send any system text. The result is just the 2
    // official ZCode blocks. The last one already has cc (from zcode_system.json),
    // and Step 1b should be a no-op (idempotent check finds cc already present).
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2); // 2 official only
    expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.system[1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("transformRequestBody — alignZCodeFormat (message body fingerprint alignment, vceshi0.1.6+)", () => {
  it("does NOT convert tool_result.content from string to array (real ZCode sends string)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "run the tests" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "bun test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "532 pass\n0 fail" }] },
      ],
      tools: [{ name: "Bash", description: "shell", input_schema: {} }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // tool_result.content should STILL be a string — real ZCode client sends string
    const tr = parsed.messages[2].content[0];
    expect(tr.type).toBe("tool_result");
    expect(typeof tr.content).toBe("string");
    expect(tr.content).toBe("532 pass\n0 fail");
  });

  it("does NOT insert placeholder text block into assistant messages with only tool_use", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "what files are here" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "*" } }] },
        { role: "user", content: "thanks" },
      ],
      tools: [{ name: "Glob", description: "find files", input_schema: {} }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // assistant message should STILL have only the tool_use block — no inserted text:" "
    const asst = parsed.messages[1];
    expect(asst.role).toBe("assistant");
    expect(Array.isArray(asst.content)).toBe(true);
    expect(asst.content.length).toBe(1);
    expect(asst.content[0].type).toBe("tool_use");
  });

  it("preserves is_error on tool_result blocks (real ZCode keeps it)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "run something that fails" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "exit 1" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "command failed", is_error: true }] },
      ],
      tools: [{ name: "Bash", description: "shell", input_schema: {} }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const tr = parsed.messages[2].content[0];
    expect(tr.type).toBe("tool_result");
    expect(tr.is_error).toBe(true); // preserved, not stripped
  });

  it("preserves client's cache_control in messages (does NOT strip)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: [{ type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "next question" },
      ],
      tools: [],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    // The client's cache_control on messages[0].content[0] should be preserved
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("injects cache_control on last user message's text block (mirrors real ZCode)", () => {
    // Real ZCode sample: messages[122].content[3] (role=user, type=text) has cc.
    // Claude Code doesn't always add cc, so the proxy should add it on the
    // last non-system message's last text block — same as coding-plan behavior.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        { role: "user", content: [{ type: "text", text: "last question" }] },
      ],
    });
    // v0.1.9+: cc is always added (was no-op in start-plan pre-v0.1.9)
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const lastBlock = lastUser.content[lastUser.content.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("applyStartPlanSystem is idempotent (no double-injection)", () => {
    // Reproduces the vceshi0.1.5 bug: when startPlan is on AND the body
    // already has ZCode blocks in system (e.g. retry), applyStartPlanSystem
    // used to inject another copy, producing 5 blocks
    // instead of 3 (ZCode, ZCode, ZCode, ZCode, client).
    //
    // Use the EXACT official block texts (a real retry would carry the exact
    // bytes injected by a prior transform — partial matches don't happen).
    const zcodeBlock0 = "You are ZCode, an interactive coding agent";
    const zcodeBlock1 = "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.";
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      // System already has 2 ZCode blocks + 1 client block (from a prior transform)
      system: [
        { type: "text", text: zcodeBlock0, cache_control: { type: "ephemeral" } },
        { type: "text", text: zcodeBlock1, cache_control: { type: "ephemeral" } },
        { type: "text", text: "client instructions" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    // Should be 3 blocks (2 ZCode + 1 client), NOT 5
    expect(parsed.system.length).toBe(3);
    expect(parsed.system[0].text).toBe(zcodeBlock0);
    expect(parsed.system[2].text).toBe("client instructions");
  });

  it("full alignment: ClaudeCode long-task body matches real ZCode wire format", () => {
    // Integration test mirroring the captured samples: a multi-turn ClaudeCode
    // request with tool_use/tool_result should produce output matching the
    // real ZCode client's wire format on every dimension that WAF inspects.
    // v0.1.9+: stream is NOT forced — test sends stream:true to verify wire alignment.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "explore the repo" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "src/index.ts\nsrc/foo.ts", is_error: false }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { cmd: "wc -l src/index.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "command timed out", is_error: true }] },
        { role: "assistant", content: [{ type: "text", text: "let me retry" }] },
        { role: "user", content: "go ahead" },
      ],
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
      tools: [
        { name: "Glob", description: "find files", input_schema: {} },
        { name: "Bash", description: "shell", input_schema: {} },
      ],
      metadata: { user_id: "device-abc" },
      stream: true,
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const keys = Object.keys(parsed);

    // 1. Top-level key order matches ZCode exactly
    expect(keys).toEqual([
      "model", "max_tokens", "thinking", "output_config",
      "system", "messages", "tools", "tool_choice", "stream",
    ]);

    // 2. tool_result.content stayed as STRING (not converted to array)
    const tr1 = parsed.messages[2].content[0];
    expect(tr1.type).toBe("tool_result");
    expect(typeof tr1.content).toBe("string");
    const tr2 = parsed.messages[4].content[0];
    expect(tr2.type).toBe("tool_result");
    expect(typeof tr2.content).toBe("string");

    // 3. is_error:true preserved on the failed tool_result
    expect(tr2.is_error).toBe(true);
    // Successful tool_result: is_error:false stripped (real ZCode only sends is_error:true)
    expect(tr1.is_error).toBeUndefined();

    // 4. Assistant message with only tool_use is NOT given a placeholder text block
    const asst1 = parsed.messages[1];
    expect(asst1.role).toBe("assistant");
    expect(asst1.content.every((b: any) => b.type === "tool_use")).toBe(true);

    // 5. cache_control added on last user message's text block (prompt cache breakpoint)
    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    const lastBlock = lastUser.content[lastUser.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });

    // 6. metadata dropped (real ZCode never sends it)
    expect(parsed.metadata).toBeUndefined();

    // 7. system: 2 ZCode blocks + client block (with identity rewritten)
    expect(parsed.system.length).toBe(3);
    expect(parsed.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(parsed.system[2].text).toContain("You are ZCode model working in Claude Code");

    // 8. thinking simplified + budget injected; max_tokens=64000; output_config injected
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 32000 });
    expect(parsed.max_tokens).toBe(64000);
    expect(parsed.output_config).toEqual({ effort: "max" });

    // 9. tool_choice + stream filled
    expect(parsed.tool_choice).toEqual({ type: "auto" });
    expect(parsed.stream).toBe(true);
  });
});

describe("transformRequestBody — document block conversion + is_error:false stripping", () => {
  it("converts document type blocks to text type", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Please check this log:" },
            {
              type: "document",
              source: { type: "text", media_type: "text/plain", data: "[2026-06-25] log line 1\n[2026-06-25] log line 2" },
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "I see the log." }] },
      ],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const userContent = parsed.messages[0].content;
    // document block should be converted to text
    const docBlock = userContent.find((b: any) => b.type === "document");
    expect(docBlock).toBeUndefined();
    const convertedBlock = userContent.find((b: any) => b.type === "text" && b.text.includes("[2026-06-25]"));
    expect(convertedBlock).toBeDefined();
    expect(convertedBlock.text).toContain("log line 1");
  });

  it("converts document block with empty source.data to text:' '", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "" } }],
        },
      ],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const block = parsed.messages[0].content[0];
    expect(block.type).toBe("text");
    expect(block.text).toBe(" ");
  });

  it("converts document block with missing source to text:' '", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "document" }],
        },
      ],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const block = parsed.messages[0].content[0];
    expect(block.type).toBe("text");
    expect(block.text).toBe(" ");
  });

  it("strips is_error:false from tool_result blocks but keeps is_error:true", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file1\nfile2", is_error: false }],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "bad" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu2", content: "command not found", is_error: true }],
        },
      ],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // is_error:false should be stripped from the success tool_result
    const successBlock = parsed.messages
      .flatMap((m: any) => m.content || [])
      .find((b: any) => b.tool_use_id === "tu1");
    expect(successBlock.is_error).toBeUndefined();
    // is_error:true should be preserved on the error tool_result
    const errorBlock = parsed.messages
      .flatMap((m: any) => m.content || [])
      .find((b: any) => b.tool_use_id === "tu2");
    expect(errorBlock.is_error).toBe(true);
  });

  it("does not affect tool_result blocks without is_error field", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "do it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/tmp/a" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }],
        },
      ],
      max_tokens: 1000,
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const tr = parsed.messages.find(
      (m: any) => m.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
    );
    expect(tr.content[0].content).toBe("file contents");
    expect("is_error" in tr.content[0]).toBe(false);
  });
});

// v0.2.1+: cache_control fingerprint alignment vs real ZCode desktop client.
// Captured real ZCode sample (2026-06-28): the client places cc on a near-empty
// text block at the tail of the LAST **user** message, and NEVER on tool_result
// blocks or assistant messages. Claude Code, by contrast, frequently puts cc on
// tool_result blocks (the last tool_result of an agentic turn). The proxy must
// strip cc from tool_result blocks AND ensure cc lands only on the last user
// message — never on assistant (which was the pre-v0.2.1 behavior via fallthrough).
describe("transformRequestBody — cache_control fingerprint alignment (v0.2.1+)", () => {
  it("strips cache_control from tool_result blocks (real ZCode never sends it there)", () => {
    // Claude Code often attaches cc to the final tool_result of an agentic turn.
    // Real ZCode client never does this — cc is always on a text block at the
    // tail of the last user message. Stripping tool_result cc is required for
    // fingerprint alignment.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            // Claude Code's tool_result with cc attached — must be stripped.
            {
              tool_use_id: "call_1",
              type: "tool_result",
              content: "file1.js\nfile2.js",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // The tool_result block must NOT carry cache_control after transform.
    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    const toolResultBlock = lastUser.content.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.cache_control).toBeUndefined();
  });

  it("SKIPS cache_control when last user msg has tool_result (v0.2.1.3+ fix for gateway 1213)", () => {
    // v0.2.0.9–v0.2.1.2 regression: when Claude Code's last user message was
    // a tool-call continuation (only tool_result blocks, no text), the proxy
    // appended a single-space text block carrying cc to mirror what the
    // developer thought was the real ZCode cc-anchor pattern.
    //
    // This was a MISREADING of the zcode reference sample: msg[122]'s cc
    // anchor is on a user message with ONLY text blocks, NOT on a user
    // message that also contains tool_result. The zcode gateway rejects
    // the appended-text+cc-on-tool-result-user-msg pattern with
    // `[1213][未正常接收到prompt参数。]`.
    //
    // v0.2.1.3+ fix: when the last user message contains ANY tool_result
    // block, SKIP cache_control injection entirely. Better to miss the cache
    // optimization than to fail the request. The next turn (when the user
    // sends a text-only message) picks up cc normally.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "file1.js" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");

    // The tool_result block must remain unchanged (no cc on it — Claude
    // Code's original cc was already stripped by sanitizeContentBlocks).
    const toolResultBlock = lastUser.content.find((b: any) => b.type === "tool_result");
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock.cache_control).toBeUndefined();

    // NO new text block should have been appended. The user message's
    // content array length must be unchanged (still just 1 tool_result).
    expect(lastUser.content.length).toBe(1);

    // NO block anywhere in the last user message should carry cache_control.
    for (const block of lastUser.content) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it("SKIPS cache_control when last user msg has tool_result + text (v0.2.1.3+ fix)", () => {
    // Even when the last user message has a text block alongside tool_result,
    // we still skip cc — the zcode reference NEVER attaches cc to a user
    // message that also contains tool_result, regardless of where the text
    // block sits. Attaching cc to the text block in such a message also
    // triggers the gateway 1213 error.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first question" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "file1.js" },
            { type: "text", text: "what next?" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content.length).toBe(2); // unchanged: tool_result + text

    // NO block in this user message should carry cc — skipping entirely.
    for (const block of lastUser.content) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it("NEVER attaches cache_control to assistant messages (no fallthrough)", () => {
    // Pre-v0.2.1 bug: when the last user message had only tool_result blocks
    // (no text), applyAnthropicCacheControl would fall through to earlier
    // messages and attach cc to an assistant message — a clear fingerprint
    // mismatch vs real ZCode (which never puts cc on assistant turns).
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "file1.js" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // No assistant message should carry cache_control on any of its blocks.
    for (const msg of parsed.messages) {
      if (msg.role !== "assistant") continue;
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "text") {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });

  it("still attaches cc to last user message's existing text block when one is present", () => {
    // Sanity: when the last user message already has a text block (the
    // common case for non-tool-call-continuation requests), cc attaches to
    // the LAST text block of that message — no new block is appended.
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "part 1" },
            { type: "text", text: "part 2" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content.length).toBe(2); // no new block appended
    expect(lastUser.content[0].cache_control).toBeUndefined(); // first text block: no cc
    expect(lastUser.content[1].cache_control).toEqual({ type: "ephemeral" }); // last text block: cc
  });
});

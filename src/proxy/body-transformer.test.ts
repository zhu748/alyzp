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
    // The user msg (index 0) is the last non-system; gets cache_control
    expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    // System message relocated from messages to top-level system field
    expect(parsed.messages.length).toBe(1);
    expect(parsed.system).toEqual([{ type: "text", text: "sys-prompt" }]);
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

  it("relocates system-only messages to system field", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "sys" }] });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // System message moved out of messages array
    expect(parsed.messages).toEqual([]);
    expect(parsed.system).toEqual([{ type: "text", text: "sys" }]);
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

describe("transformRequestBody — relocate system messages (Anthropic)", () => {
  it("moves role:system messages from messages to system field", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hello" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages.length).toBe(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.system).toEqual([{ type: "text", text: "you are helpful" }]);
  });

  it("appends to existing system array", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "existing sys" }],
      messages: [
        { role: "system", content: "injected sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0].text).toBe("existing sys");
    expect(parsed.system[1].text).toBe("injected sys");
  });

  it("converts existing string system to array and appends", () => {
    const body = JSON.stringify({
      system: "string system",
      messages: [
        { role: "system", content: "array system" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system.length).toBe(2);
    expect(parsed.system[0]).toEqual({ type: "text", text: "string system" });
    expect(parsed.system[1]).toEqual({ type: "text", text: "array system" });
  });

  it("handles system message with array content", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: [{ type: "text", text: "block1" }, { type: "text", text: "block2" }] },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.system).toEqual([
      { type: "text", text: "block1" },
      { type: "text", text: "block2" },
    ]);
  });

  it("does NOT relocate for openai format", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    const out = transformRequestBody(body, { format: "openai" });
    const parsed = JSON.parse(out as string);
    // For openai format, system messages stay in messages array
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("system");
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

    // System message relocated
    expect(parsed.system).toEqual([{ type: "text", text: "agent types and skills..." }]);
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeUndefined();

    // Thinking block stripped from assistant history
    const assistant = parsed.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "你好!👋 我是 ZCode..." }]);
  });
});

describe("transformRequestBody — strip cache_control from tool_result (Anthropic)", () => {
  it("removes cache_control from tool_result blocks", () => {
    // Reproduces the v2.1.3.4beta0 start-plan 3001: Claude Code attaches
    // cache_control to the last block of the last user message. When that
    // message is a tool_result, cache_control lands ON the tool_result block,
    // which ZCode's start-plan gateway rejects with 3001.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: "file1\nfile2",
              is_error: false,
              cache_control: { type: "ephemeral" },  // ← Claude Code adds this
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const toolResultMsg = parsed.messages[parsed.messages.length - 1];
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].cache_control).toBeUndefined();
    // Other fields on tool_result preserved
    expect(toolResultMsg.content[0].tool_use_id).toBe("t1");
    // v2.1.3.9beta0: tool_result.content is normalized from string to array
    // format — ZCode gateway requires array, Anthropic accepts both.
    expect(toolResultMsg.content[0].content).toEqual([
      { type: "text", text: "file1\nfile2" },
    ]);
    // v2.1.3.9beta0: is_error stripped — ZCode gateway doesn't accept it.
    expect("is_error" in toolResultMsg.content[0]).toBe(false);
  });

  it("preserves cache_control on text blocks", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        {
          role: "user",
          content: [
            { type: "text", text: "follow up", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // text block keeps its cache_control
    expect(parsed.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("does NOT re-add cache_control to tool_result via applyAnthropicCacheControl", () => {
    // After stripping, the proxy's applyAnthropicCacheControl runs and tries
    // to add cache_control to the last block of the last message. If that
    // block is a tool_result, it MUST skip it — otherwise we re-introduce
    // the 3001. This test verifies the skip logic.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: "output",
              is_error: false,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    // tool_result block must NOT have cache_control after transform
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].cache_control).toBeUndefined();
  });

  it("handles tool_result-only user message: skips cache_control, no crash", () => {
    // If the last user message has ONLY tool_result blocks (no text), the
    // proxy can't attach cache_control anywhere on it. Should skip gracefully
    // and not attach to tool_result.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    expect(lastMsg.content[0].type).toBe("tool_result");
    expect(lastMsg.content[0].cache_control).toBeUndefined();
  });

  it("start-plan full Claude Code round-3 regression (thinking + tool_result+cc)", () => {
    // Reproduces the EXACT structure from user's v2.1.3.4beta0 diagnostic:
    // msgs[[0]user/{text,text},[1]assistant/{text},[2]user/str,[3]assistant/{text,tool_use},[4]user/{tool_result}]
    // where [3] had a thinking block (now stripped) and [4] had cache_control
    // on the tool_result (now stripped).
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "system",
          content: "Available agent types...",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看当前项目是干嘛的" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "用户想了解...", signature: "" },
            { type: "text", text: "我来看看..." },
            { type: "tool_use", id: "call_x", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "call_x",
              type: "tool_result",
              content: "total 12",
              is_error: false,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [{ name: "Bash", description: "run bash", input_schema: { type: "object" } }],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // Thinking block stripped from assistant [3]
    const assistant3 = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistant3.content.some((b: any) => b.type === "thinking")).toBe(false);
    expect(assistant3.content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);

    // cache_control stripped from tool_result in [4]
    const toolResultMsg = parsed.messages[parsed.messages.length - 1];
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].cache_control).toBeUndefined();

    // System message relocated, start-plan blocks prepended
    expect(parsed.system.length).toBeGreaterThanOrEqual(3);  // 2 ZCode + 1 client
    expect(parsed.messages.find((m: any) => m.role === "system")).toBeUndefined();

    // Top-level fields normalized.
    // Since v0.1.9, injectZCodeThinkingFormat re-adds budget_tokens=32000
    // and output_config.effort=max to match the real ZCode client.
    expect(parsed.thinking.type).toBe("enabled");
    expect(parsed.thinking.budget_tokens).toBe(32000);
    expect(parsed.context_management).toBeUndefined();
    expect(parsed.output_config).toEqual({ effort: "max" });
  });

  it("strips cache_control from tool_use blocks (v2.1.3.5beta0 regression)", () => {
    // v2.1.3.5beta0 fixed tool_result+cc but applyAnthropicCacheControl then
    // attached cc to tool_use blocks when the last user message was all
    // tool_results. ZCode gateway ALSO rejects cc on tool_use blocks → 3001.
    // This reproduces the user's v2.1.3.5beta0 diagnostic:
    //   msgs[..., [3]assistant/{tool_use,tool_use+cc}, [4]user/{tool_result,tool_result}]
    // The assistant called 2 tools; proxy walked back and put cc on 2nd tool_use.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看当前项目是干嘛的" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "x" } },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "result1", is_error: false },
            { tool_use_id: "call_2", type: "tool_result", content: "result2", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // The assistant message with tool_use blocks — NO block should have cc
    const assistantWithTools = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistantWithTools).toBeDefined();
    for (const block of assistantWithTools.content) {
      // No tool_use block should carry cache_control
      if (block.type === "tool_use") {
        expect(block.cache_control).toBeUndefined();
      }
    }
    // Thinking block should also be stripped
    expect(assistantWithTools.content.some((b: any) => b.type === "thinking")).toBe(false);

    // The last user message (tool_results) — NO block should have cc
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    for (const block of lastMsg.content) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it("attachable text block found when last msg is all tool_results", () => {
    // When the last user message is all tool_results and the previous
    // assistant has a text block, cache_control should land on that text
    // block — NOT on any tool_use block.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    // text block should get cache_control
    const textBlock = assistant.content.find((b: any) => b.type === "text");
    expect(textBlock.cache_control).toEqual({ type: "ephemeral" });
    // tool_use block should NOT have cache_control
    const toolUseBlock = assistant.content.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock.cache_control).toBeUndefined();
    // tool_result block should NOT have cache_control
    const toolResultBlock = parsed.messages[2].content[0];
    expect(toolResultBlock.cache_control).toBeUndefined();
  });

  it("skips cache_control entirely when no text block exists in any message", () => {
    // After v2.1.3.7beta0, assistant messages with only tool_use get an empty
    // text block inserted. So cache_control lands on that inserted text block
    // in the assistant message — NOT on tool_use, NOT on tool_result, NOT on
    // the first user message (which would have been the fallback before).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },  // string content
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // First user message: v2.1.3.10beta0 normalizes string content to array
    // [{type:"text", text:"你好"}] — ZCode gateway requires array format.
    const firstUser = parsed.messages[0];
    expect(Array.isArray(firstUser.content)).toBe(true);
    expect(firstUser.content[0].type).toBe("text");
    expect(firstUser.content[0].text).toBe("你好");

    // Assistant message: non-empty text block inserted at front, cache_control
    // attached to that text block
    // v2.1.3.10beta0: text is " " (space) instead of "" (some gateways reject empty)
    const assistant = parsed.messages[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe(" ");
    expect(assistant.content[0].cache_control).toEqual({ type: "ephemeral" });
    // tool_use block has NO cache_control
    expect(assistant.content[1].type).toBe("tool_use");
    expect(assistant.content[1].cache_control).toBeUndefined();

    // Last user message: tool_result, NO cache_control
    const lastUser = parsed.messages[2];
    expect(lastUser.content[0].type).toBe("tool_result");
    expect(lastUser.content[0].cache_control).toBeUndefined();
  });
});

describe("transformRequestBody — ensure assistant has text block (v2.1.3.7beta0)", () => {
  it("inserts empty text block when assistant has only tool_use (after thinking strip)", () => {
    // Reproduces the v2.1.3.6beta0 user report: rounds 3-5 had assistant
    // messages like [thinking, tool_use]; after thinking strip they became
    // [tool_use] only, which ZCode gateway rejects with 3001.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me check", signature: "" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    // After thinking strip + ensureAssistantTextBlock:
    // content should be [text(" "), tool_use]
    // v2.1.3.10beta0: text is " " (space) instead of "" (some gateways reject empty)
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe(" ");
    expect(assistant.content[1].type).toBe("tool_use");
    expect(assistant.content[1].id).toBe("t1");
  });

  it("inserts empty text block when assistant originally has only tool_use (no thinking)", () => {
    // Claude Code sometimes sends assistant messages with only tool_use
    // (no thinking, no text). ZCode gateway rejects these too.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe(" ");
    expect(assistant.content[1].type).toBe("tool_use");
  });

  it("does NOT modify assistant that already has a text block", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const assistant = parsed.messages[1];
    expect(assistant.content.length).toBe(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[0].text).toBe("let me check");
  });

  it("does NOT modify user messages (user can be all tool_result)", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [{ type: "text", text: "checking" }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    // user message with only tool_result should NOT get a text block inserted
    const userMsg = parsed.messages[2];
    expect(userMsg.content.length).toBe(1);
    expect(userMsg.content[0].type).toBe("tool_result");
  });

  it("full Claude Code multi-round regression (v2.1.3.6beta0 round-7 scenario)", () => {
    // Reproduces the EXACT message structure from user's v2.1.3.6beta0 log:
    //   msgs[[0]user/{text,text},[1]assistant/{text},[2]user/str,
    //        [3]assistant/{tool_use},[4]user/{tool_result},
    //        [5]assistant/{tool_use},[6]user/{tool_result},
    //        [7]assistant/{tool_use},[8]user/{tool_result},
    //        [9]assistant/{text+cc,tool_use},[10]user/{tool_result}]
    // [3],[5],[7] had thinking blocks stripped → became [tool_use] only.
    // ZCode gateway 3001'd on round 7 because of these text-less assistant msgs.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！我是 ZCode..." }],
        },
        { role: "user", content: "帮我看看这个项目是干嘛的" },
        // Round 3: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "out1", is_error: false },
          ],
        },
        // Round 4: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls subdir" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_2", type: "tool_result", content: "out2", is_error: false },
          ],
        },
        // Round 5: [thinking, tool_use] → after strip: [text(""), tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "tool_use", id: "call_3", name: "Bash", input: { command: "ls subdir2" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_3", type: "tool_result", content: "out3", is_error: false },
          ],
        },
        // Round 6: [thinking, text, tool_use] → after strip: [text, tool_use]
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "" },
            { type: "text", text: "让我再看几个关键文件确认细节。" },
            { type: "tool_use", id: "call_4", name: "Read", input: { file_path: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_4", type: "tool_result", content: "out4", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [],
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { effort: "max" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // Every assistant message MUST have at least one text block
    const assistants = parsed.messages.filter((m: any) => m.role === "assistant");
    for (const a of assistants) {
      const hasText = Array.isArray(a.content) &&
        a.content.some((b: any) => b.type === "text");
      expect(hasText).toBe(true);
    }

    // Specifically check the round-3,4,5 assistants (which had thinking stripped)
    // They should now be [text(""), tool_use]
    const round3Assistant = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.id === "call_1")
    );
    expect(round3Assistant.content.length).toBe(2);
    expect(round3Assistant.content[0].type).toBe("text");
    expect(round3Assistant.content[0].text).toBe(" ");
    expect(round3Assistant.content[1].type).toBe("tool_use");

    // No thinking blocks anywhere
    for (const m of parsed.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        expect(b.type).not.toBe("thinking");
        expect(b.type).not.toBe("redacted_thinking");
      }
    }
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
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hello world" },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("Responses API full regression: function_call_output with empty output", () => {
    // Reproduces a Codex CLI scenario where function_call_output has empty
    // output. The translator produces tool_result with content: "".
    // After body-transformer, this should become a non-empty text block
    // inside the tool_result.
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

    // tool_result.content should be array with a non-empty text block
    const toolResult = parsed.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content[0].type).toBe("text");
    // Empty tool_result content → non-empty space (v2.1.3.11beta0 fix)
    expect(toolResult.content[0].text).toBe(" ");
  });
});

describe("transformRequestBody — v2.1.3.9beta0: start-plan strips ALL cache_control + tool_result normalization", () => {
  it("start-plan: strips cache_control from text blocks (v2.1.3.8beta0 regression)", () => {
    // v2.1.3.5/6/7/8beta0 assumed text-block cache_control was safe in
    // start-plan. v2.1.3.9beta0 fix: in start-plan, strip cache_control from
    // ALL blocks including text. Reproduces #004 from v2.1.3.8beta0:
    //   msgs[..., [3]assistant/{text+cc,tool_use,tool_use}, [4]user/{tool_result,tool_result}]
    // The `text+cc` on the assistant message's text block was the 3001 trigger.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "你好！" }],
        },
        { role: "user", content: "帮我看看当前项目" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check", cache_control: { type: "ephemeral" } },
            { type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "x" } },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "r1", is_error: false },
            { tool_use_id: "call_2", type: "tool_result", content: "r2", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "u-123",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // No block in any message should carry cache_control in start-plan mode.
    for (const m of parsed.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        expect(b.cache_control).toBeUndefined();
      }
    }
  });

  it("coding-plan: KEEPS cache_control on text blocks (preserves prompt caching)", () => {
    // In coding-plan mode, only non-text blocks have cache_control stripped.
    // Text blocks keep cache_control for prompt caching on direct GLM API.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "out", is_error: false },
          ],
        },
      ],
    });
    // No startPlan flag → coding-plan mode
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);

    // The assistant text block should have cache_control attached by
    // applyAnthropicCacheControl (last non-system msg with text block).
    const assistant = parsed.messages[1];
    const textBlock = assistant.content.find((b: any) => b.type === "text");
    expect(textBlock.cache_control).toEqual({ type: "ephemeral" });
    // tool_use block should NOT have cache_control
    const toolUseBlock = assistant.content.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock.cache_control).toBeUndefined();
    // tool_result block should NOT have cache_control
    const toolResultBlock = parsed.messages[2].content[0];
    expect(toolResultBlock.cache_control).toBeUndefined();
  });

  it("normalizes tool_result.content from string to array (both modes)", () => {
    // Claude Code sends tool_result.content as a string. The ZCode gateway
    // (and some other Anthropic-compatible upstreams) only accepts the array
    // format. This converts string → array of one text block.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "the result text" },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    const toolResult = parsed.messages[2].content[0];
    expect(toolResult.type).toBe("tool_result");
    // content should now be an array of text blocks
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content).toEqual([{ type: "text", text: "the result text" }]);
  });

  it("preserves tool_result.content when already array", () => {
    // If content is already an array (some clients send it this way), leave
    // it untouched.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            {
              tool_use_id: "t1",
              type: "tool_result",
              content: [{ type: "text", text: "already array" }],
            },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    const toolResult = parsed.messages[2].content[0];
    expect(toolResult.content).toEqual([{ type: "text", text: "already array" }]);
  });

  it("strips is_error from tool_result blocks (both modes)", () => {
    // Claude Code attaches `is_error: false` to successful tool_result blocks.
    // Anthropic's official API accepts this, but ZCode gateway rejects it
    // with 3001. Strip in both modes (the field is informational).
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "ok", is_error: false },
          ],
        },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", startPlan: true });
    const parsed = JSON.parse(out as string);
    const toolResult = parsed.messages[2].content[0];
    expect("is_error" in toolResult).toBe(false);
  });

  it("strips is_error even in coding-plan mode (gateway-strict field)", () => {
    // is_error is stripped in both modes — it's a Claude Code metadata field
    // that the upstream doesn't need and ZCode gateway actively rejects.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "ok", is_error: true },
          ],
        },
      ],
    });
    // No startPlan → coding-plan
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    const toolResult = parsed.messages[2].content[0];
    expect("is_error" in toolResult).toBe(false);
  });

  it("v2.1.3.9beta0 full #004 regression: multi-tool_use + tool_result + cache_control on text", () => {
    // Reproduces the exact #004 request from v2.1.3.8beta0 that 3001'd:
    //   msgs[[0]user/{text,text},[1]assistant/{text},
    //        [2]user/str,[3]assistant/{text+cc,tool_use,tool_use},
    //        [4]user/{tool_result,tool_result}]
    // After v2.1.3.9beta0 fixes:
    //   - text block's cache_control stripped (start-plan mode)
    //   - tool_result.content converted string → array
    //   - tool_result.is_error stripped
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>...</system-reminder>" },
            { type: "text", text: "你好" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "你好！" }] },
        { role: "user", content: "帮我看看当前项目" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check", cache_control: { type: "ephemeral" } },
            { type: "tool_use", id: "call_1", name: "Grep", input: { pattern: "x" } },
            { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { tool_use_id: "call_1", type: "tool_result", content: "r1", is_error: false },
            { tool_use_id: "call_2", type: "tool_result", content: "r2", is_error: false },
          ],
        },
      ],
      system: [{ type: "text", text: "You are Claude Code." }],
      tools: [],
      thinking: { type: "enabled" },
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "84e5299d-a2f6-45b3-aaff-d2edde14969c",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);

    // 1. NO cache_control anywhere in start-plan mode
    for (const m of parsed.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        expect(b.cache_control).toBeUndefined();
      }
    }

    // 2. tool_result.content is now array format
    const lastMsg = parsed.messages[parsed.messages.length - 1];
    for (const b of lastMsg.content) {
      expect(b.type).toBe("tool_result");
      expect(Array.isArray(b.content)).toBe(true);
      expect(b.content[0].type).toBe("text");
      expect(typeof b.content[0].text).toBe("string");
      // 3. is_error stripped
      expect("is_error" in b).toBe(false);
    }

    // 4. assistant message [3] still has text + 2 tool_use (structure preserved)
    const assistantWithTools = parsed.messages.find((m: any) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_use")
    );
    expect(assistantWithTools).toBeDefined();
    const textBlock = assistantWithTools.content.find((b: any) => b.type === "text");
    expect(textBlock).toBeDefined();
    const toolUseBlocks = assistantWithTools.content.filter((b: any) => b.type === "tool_use");
    expect(toolUseBlocks.length).toBe(2);

    // 5. metadata.user_id is NOT injected in start-plan mode.
    // ZCode start-plan gateway rejects metadata.user_id (returns 200 + empty
    // SSE stream — see body-transformer.ts:150-158). Only coding-plan gets
    // the metadata.user_id injection. So in start-plan + userId, metadata
    // must be absent entirely.
    expect(parsed.metadata).toBeUndefined();
  });
});

describe("transformRequestBody — metadata.user_id (Anthropic)", () => {
  it("injects metadata.user_id when ctx.userId is set", () => {
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves existing metadata fields when adding user_id", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { existing_field: "keep" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_99" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ existing_field: "keep", user_id: "u_99" });
  });

  it("does NOT touch metadata.user_id when it already equals ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "u_x" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "u_x" });
    const parsed = JSON.parse(out as string);
    // metadata.user_id should be unchanged (no overwrite)
    expect(parsed.metadata.user_id).toBe("u_x");
    // vceshi0.1.7+: max_tokens=64000 still injected unconditionally
    expect(parsed.max_tokens).toBe(64000);
  });

  it("overwrites metadata.user_id when value differs from ctx.userId", () => {
    const body = JSON.stringify({
      messages: [],
      metadata: { user_id: "client_set" },
    });
    const out = transformRequestBody(body, { format: "anthropic", userId: "oauth_resolved" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata.user_id).toBe("oauth_resolved");
  });

  it("does NOT inject metadata when ctx.userId is absent (apikey mode)", () => {
    const body = JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata for OpenAI format even if userId is set", () => {
    const body = JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "openai", userId: "u_42" });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("does NOT inject metadata.user_id in start-plan mode (ZCode gateway rejects it)", () => {
    // Regression guard: start-plan + OAuth userId must NOT inject
    // metadata.user_id. The ZCode gateway returns 200 + empty SSE stream
    // when metadata.user_id is present, which surfaces to Claude Code as
    // "API returned an empty or malformed response (HTTP 200)".
    // Symmetric with applyAnthropicCacheControl's start-plan no-op.
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "user-from-oauth",
      startPlan: true,
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("DOES inject metadata.user_id in coding-plan mode when userId is set", () => {
    // Positive counterpart: coding-plan still gets the injection.
    const body = JSON.stringify({
      model: "glm-4.6",
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, {
      format: "anthropic",
      userId: "user-from-oauth",
      startPlan: false,
    });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toEqual({ user_id: "user-from-oauth" });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const outCoding = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true, startPlan: false });
    const parsedCoding = JSON.parse(outCoding as string);
    expect(Array.isArray(parsedCoding.system)).toBe(true);
    expect(parsedCoding.system.length).toBeGreaterThanOrEqual(2); // 2 ZCode blocks
    expect(parsedCoding.system[0].text).toBe("You are ZCode, an interactive coding agent");
    expect(parsedCoding.system[0].cache_control).toEqual({ type: "ephemeral" });
    // start-plan
    const outStart = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true, startPlan: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
    const parsed = JSON.parse(out as string);
    // Find the rewritten block (it's in the client blocks, after the 2 ZCode blocks)
    const clientBlocks = parsed.system.slice(2);
    const identityBlock = clientBlocks.find((b: any) => b.text.includes("You are ZCode model working in Claude Code"));
    expect(identityBlock).toBeDefined();
    expect(identityBlock.text).not.toContain("You are Claude Code, Anthropic's official CLI for Claude.");
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    // When alignZCodeFormat is OFF, relocateSystemMessages moves role:system to top-level system.
    // When ON, the system message stays in messages[] (matching real ZCode behavior).
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "The Bash tool shell was changed by the user." },
      ],
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "openai", alignZCodeFormat: true });
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
    const ctx = { format: "anthropic" as const, alignZCodeFormat: true };
    const out1 = transformRequestBody(body, ctx);
    const out2 = transformRequestBody(out1 as string, ctx);
    // Second run should produce same output (no duplicate system blocks)
    const p1 = JSON.parse(out1 as string);
    const p2 = JSON.parse(out2 as string);
    expect(p2.system.length).toBe(p1.system.length);
    expect(p2.system[0].text).toBe(p1.system[0].text);
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.tool_choice).toEqual({ type: "any" }); // preserved, not overwritten
  });

  it("forces stream: true when client didn't send it", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream).toBe(true);
  });

  it("forces stream: true even when client sent stream: false", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.stream).toBe(true); // forced on
  });

  it("drops metadata field (Claude Code's user_id tracking — real ZCode never sends it)", () => {
    const body = JSON.stringify({
      model: "glm-5.2",
      max_tokens: 1000,
      thinking: { type: "enabled" },
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "device-123" },
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
    const parsed = JSON.parse(out as string);
    expect(parsed.metadata).toBeUndefined();
  });

  it("complete alignment: Claude Code request → real ZCode wire format", () => {
    // Mimics Claude Code's actual request shape (model→messages→system→tools→metadata→max_tokens→thinking)
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
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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

    // 4. stream forced on
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true, startPlan: true });
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
    // startPlan + alignZCodeFormat: cc should STILL be added (was no-op before fix)
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true, startPlan: true });
    const parsed = JSON.parse(out as string);
    const lastUser = parsed.messages[parsed.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(Array.isArray(lastUser.content)).toBe(true);
    const lastBlock = lastUser.content[lastUser.content.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("applyStartPlanSystem is idempotent under alignZCodeFormat + start-plan (no double-injection)", () => {
    // Reproduces the vceshi0.1.5 bug: when alignZCodeFormat + startPlan are
    // both on AND the body already has ZCode blocks in system (e.g. retry),
    // applyStartPlanSystem used to inject another copy, producing 5 blocks
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
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true, startPlan: true });
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
    });
    const out = transformRequestBody(body, { format: "anthropic", alignZCodeFormat: true });
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

    // 3. is_error preserved on the failed tool_result
    expect(tr2.is_error).toBe(true);
    // Successful tool_result: is_error: false was sent by client → preserved too
    expect(tr1.is_error).toBe(false);

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

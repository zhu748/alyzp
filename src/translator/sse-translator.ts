/**
 * SSE event translator — converts streaming events between OpenAI and Anthropic formats.
 * @see .omo/plans/zcode-proxy.md Task 12
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
import type { AnthropicStreamEvent, OpenAIStreamChunk } from "./types.js";
import { parseSSEChunk, waitForBackpressure, type ParsedSSE } from "../utils/sse.js";

interface TranslationState {
  messageId: string;
  model: string;
  roleSent: boolean;
  inputTokens: number;
  outputTokens: number;
  /**
   * Tracks active tool_use content blocks by their Anthropic block index.
   * Key = Anthropic block index (from content_block_start.index).
   * Value = { openaiIndex, id, name }.
   *
   * The OpenAI tool_calls array uses its own `index` (0, 1, 2...) which is
   * separate from Anthropic's block index (text blocks and tool_use blocks
   * share the same Anthropic index space). We assign each tool_use block a
   * sequential OpenAI index when it starts, so OpenAI clients can correlate
   * the initial `tool_calls[i].function.name` chunk with subsequent
   * `tool_calls[i].function.arguments` delta chunks.
   */
  toolBlocks: Map<number, { openaiIndex: number; id: string; name: string }>;
  /** Counter for assigning OpenAI tool_calls indices. */
  nextToolIndex: number;
}

function initState(model: string): TranslationState {
  return {
    messageId: "",
    model,
    roleSent: false,
    inputTokens: 0,
    outputTokens: 0,
    toolBlocks: new Map(),
    nextToolIndex: 0,
  };
}

function makeChunk(
  state: TranslationState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): string {
  const chunk: OpenAIStreamChunk & { usage?: typeof usage } = {
    id: state.messageId || "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta: delta as any,
      finish_reason: finishReason as any,
    }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Transform an Anthropic SSE stream into OpenAI SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 */
export function anthropicSseToOpenaiSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const state = initState(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";

          for (const block of blocks) {
            const parsed = parseSSEChunk(block);
            for (const p of parsed) {
              const output = translateEvent(state, p);
              if (output) {
                // Wait for the downstream client to drain before enqueuing
                // more chunks. Without this, a slow client (e.g. Codex CLI
                // on a flaky network) can cause the proxy's translated-stream
                // buffer to grow unbounded — eventually OOMing.
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(output));
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateEvent(state, p);
            if (output) {
              await waitForBackpressure(controller);
              controller.enqueue(encoder.encode(output));
            }
          }
        }

        // Emit [DONE]
        await waitForBackpressure(controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.error(err);
      } finally {
        try { controller.close(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    },
  });
}

function translateEvent(state: TranslationState, sse: ParsedSSE): string | null {
  const data = sse.data as AnthropicStreamEvent;

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.messageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      if (!state.roleSent) {
        state.roleSent = true;
        return makeChunk(state, { role: "assistant" });
      }
      return null;
    }

    case "content_block_start": {
      // vceshi0.0.8+: handle tool_use blocks. Previously this case was
      // skipped entirely, which meant OpenAI clients never received the
      // tool_call's id / name — the streaming tool_use was completely
      // lost. Now we emit an OpenAI-style tool_calls delta with the
      // initial id + name + empty arguments string; subsequent
      // input_json_delta events append to the arguments string.
      const block = (data as any).content_block;
      const blockIdx = (data as any).index ?? 0;
      if (block?.type === "tool_use") {
        const openaiIdx = state.nextToolIndex++;
        state.toolBlocks.set(blockIdx, {
          openaiIndex: openaiIdx,
          id: block.id ?? `call_${blockIdx}`,
          name: block.name ?? "",
        });
        return makeChunk(state, {
          tool_calls: [{
            index: openaiIdx,
            id: block.id ?? `call_${blockIdx}`,
            type: "function",
            function: { name: block.name ?? "", arguments: "" },
          }],
        });
      }
      // text blocks (and any other block type) don't need an open chunk in
      // the OpenAI format — OpenAI just streams content deltas directly.
      return null;
    }

    case "content_block_delta": {
      const delta = (data as any).delta;
      if (delta?.type === "text_delta") {
        return makeChunk(state, { content: delta.text });
      }
      if (delta?.type === "input_json_delta") {
        // Forward the partial JSON arguments to the matching OpenAI
        // tool_call entry. The Anthropic block index tells us which
        // tool_use block this delta belongs to.
        const blockIdx = (data as any).index ?? 0;
        const tool = state.toolBlocks.get(blockIdx);
        if (!tool) return null; // orphan delta — drop
        return makeChunk(state, {
          tool_calls: [{
            index: tool.openaiIndex,
            function: { arguments: delta.partial_json ?? "" },
          }],
        });
      }
      return null;
    }

    case "content_block_stop": {
      // vceshi0.0.8+: clean up the tool_use block tracking. No OpenAI
      // event needs to be emitted — OpenAI's format doesn't have an
      // explicit "tool call ended" marker; the finish_reason carries
      // that information.
      const blockIdx = (data as any).index ?? 0;
      state.toolBlocks.delete(blockIdx);
      return null;
    }

    case "message_delta": {
      const dataAny = data as any;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== undefined) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      if (delta?.stop_reason) {
        const finishReason = mapStopReason(delta.stop_reason);
        return makeChunk(state, {}, finishReason, {
          prompt_tokens: state.inputTokens,
          completion_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        });
      }
      return null;
    }

    case "message_stop": {
      return makeChunk(state, {}, "stop", {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
      });
    }

    case "ping":
      return null;

    default:
      return null;
  }
}

function mapStopReason(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

/**
 * Transform an OpenAI SSE stream into Anthropic SSE format.
 * Input: ReadableStream<Uint8Array> (OpenAI SSE bytes)
 * Output: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 *
 * @deprecated v0.2.0.8: this function is NOT used by any production code path
 * (handler.ts only does Anthropic→OpenAI / Anthropic→Responses translation,
 * never the reverse). It is retained solely for test coverage and as a stub
 * for future reverse-translation support.
 *
 * KNOWN BUG: the current implementation emits one content_block_start +
 * content_block_delta + content_block_stop triple per OpenAI delta chunk,
 * producing N independent 1-token blocks instead of one block with N deltas.
 * This violates the Anthropic SSE spec (a single text block should emit
 * start ONCE, then multiple deltas at the same index, then ONE stop). Any
 * future production use MUST fix this before shipping — see the
 * `blockIndex++` line below and rework it to reuse the index across deltas
 * from the same content block.
 */
export function openaiSseToAnthropicSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = "glm-4.6",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStarted = false;
  let blockIndex = 0;
  const messageId = `msg_${Date.now()}`;

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();

            if (dataStr === "[DONE]") {
              await waitForBackpressure(controller);
              controller.enqueue(encoder.encode(
                formatAnthropicSSE("message_stop", { type: "message_stop" }),
              ));
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr) as OpenAIStreamChunk;
              const choice = chunk.choices?.[0];

              if (!messageStarted) {
                messageStarted = true;
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(formatAnthropicSSE("message_start", {
                  type: "message_start",
                  message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                })));
              }

              if (choice?.delta?.content) {
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(formatAnthropicSSE("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                })));
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(formatAnthropicSSE("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: choice.delta.content },
                })));
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(formatAnthropicSSE("content_block_stop", {
                  type: "content_block_stop",
                  index: blockIndex,
                })));
                blockIndex++;
              }

              if (choice?.finish_reason) {
                const stopReason = mapFinishReason(choice.finish_reason);
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(formatAnthropicSSE("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: stopReason },
                  usage: { output_tokens: 0 },
                })));
              }
            } catch {
              // Skip malformed
            }
          }
        }
      } catch (err) {
        controller.error(err);
      } finally {
        try { controller.close(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    },
  });
}

function formatAnthropicSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapFinishReason(finishReason: string): string {
  switch (finishReason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

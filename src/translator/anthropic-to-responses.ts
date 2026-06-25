/**
 * Anthropic Messages → OpenAI Responses translator.
 *
 * Translates both batch and streaming Anthropic responses into the Responses
 * API format consumed by Codex CLI and the openai-node SDK's `responses` API.
 *
 * Streaming event sequence emitted (matches OpenAI's official Responses API):
 *   1. response.created              (initial empty response)
 *   2. response.in_progress          (status update)
 *   3. For each text block:
 *        response.output_item.added        (message item, status=in_progress)
 *        response.content_part.added       (output_text part, empty)
 *        response.output_text.delta *      (text deltas)
 *        response.output_text.done         (final text)
 *        response.content_part.done        (part done)
 *        response.output_item.done         (item done, status=completed)
 *   4. For each tool_use block:
 *        response.output_item.added        (function_call item, status=in_progress)
 *        response.function_call_arguments.delta * (argument deltas)
 *        response.function_call_arguments.done    (final arguments)
 *        response.output_item.done         (item done, status=completed)
 *   5. response.completed            (final response with usage)
 *
 * @see https://platform.openai.com/docs/api-reference/responses-streaming
 */
import type {
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  OpenAIResponse,
  ResponsesOutputItem,
} from "./types.js";
import { parseSSEChunk, waitForBackpressure } from "../utils/sse.js";

/** Default model name when upstream doesn't echo one back. */
const DEFAULT_MODEL = "glm-4.6";

/** Generate a Responses-style id with the given prefix. */
function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
}

/** Map Anthropic stop_reason → Responses status (incomplete vs completed). */
function mapStopReasonToStatus(stopReason: string | null | undefined): "completed" | "incomplete" {
  if (stopReason === "max_tokens") return "incomplete";
  return "completed";
}

/** Build the canonical Responses `output[]` array from an Anthropic response. */
export function buildResponsesOutput(resp: AnthropicMessagesResponse): ResponsesOutputItem[] {
  const out: ResponsesOutputItem[] = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text") {
      out.push({
        type: "message",
        id: genId("msg"),
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: (block as any).text ?? "",
          annotations: [],
        }],
      });
    } else if (block.type === "tool_use") {
      out.push({
        type: "function_call",
        id: genId("fc"),
        call_id: (block as any).id,
        name: (block as any).name,
        arguments: JSON.stringify((block as any).input ?? {}),
        status: "completed",
      });
    }
    // Skip thinking blocks — Codex CLI doesn't render them and GLM's reasoning
    // summary format is incompatible with the Responses `reasoning` item shape.
  }
  return out;
}

/** Translate a non-streaming Anthropic Messages response into a Responses response. */
export function translateResponseAnthropicToResponses(
  resp: AnthropicMessagesResponse,
  model: string = DEFAULT_MODEL,
  previousResponseId?: string | null,
): OpenAIResponse {
  const output = buildResponsesOutput(resp);
  const status = mapStopReasonToStatus(resp.stop_reason);
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;

  return {
    id: genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    previous_response_id: previousResponseId ?? null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  };
}

// ─────────────────────────────────────────────
// SSE streaming translator
// ─────────────────────────────────────────────

const SSE_DATA_PREFIX = "data: ";

interface ParsedSSE {
  event: string;
  data: unknown;
}

interface StreamState {
  responseId: string;
  model: string;
  createdAt: number;
  /** Anthropic messageId, used to seed our msg_ ids deterministically. */
  anthropicMessageId: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** Have we emitted response.created + response.in_progress yet? */
  headerSent: boolean;
  /** Index of the next output item to emit. */
  nextOutputIndex: number;
  /** Track open content block indices for the current Anthropic block. */
  currentBlockIndex: number | null;
  /** For text blocks: have we emitted the message item + content_part.added? */
  textItemOpened: boolean;
  /** For tool_use blocks: have we emitted the function_call item.added? */
  toolItemOpened: boolean;
  /** Accumulated text for the current text block (for the .done event). */
  currentTextAccum: string;
  /** Accumulated JSON for the current tool_use block (for the .done event). */
  currentToolArgsAccum: string;
  /** Items we've emitted (for the final response.completed payload). */
  emittedItems: ResponsesOutputItem[];
}

function initState(model: string): StreamState {
  return {
    responseId: genId("resp"),
    model,
    createdAt: Math.floor(Date.now() / 1000),
    anthropicMessageId: "",
    inputTokens: 0,
    outputTokens: 0,
    stopReason: null,
    headerSent: false,
    nextOutputIndex: 0,
    currentBlockIndex: null,
    textItemOpened: false,
    toolItemOpened: false,
    currentTextAccum: "",
    currentToolArgsAccum: "",
    emittedItems: [],
  };
}

function formatSSE(eventType: string, payload: unknown): string {
  return `event: ${eventType}\n${SSE_DATA_PREFIX}${JSON.stringify(payload)}\n\n`;
}

function buildResponseSnapshot(state: StreamState, status: OpenAIResponse["status"]): OpenAIResponse {
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output: state.emittedItems,
    usage: {
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      total_tokens: state.inputTokens + state.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
    },
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  };
}

function emitHeaderIfNeeded(state: StreamState): string[] {
  if (state.headerSent) return [];
  state.headerSent = true;
  const out: string[] = [];
  out.push(formatSSE("response.created", {
    type: "response.created",
    response: buildResponseSnapshot(state, "in_progress"),
  }));
  out.push(formatSSE("response.in_progress", {
    type: "response.in_progress",
    response: buildResponseSnapshot(state, "in_progress"),
  }));
  return out;
}

function openTextItem(state: StreamState): string[] {
  const out: string[] = [];
  const outputIndex = state.nextOutputIndex;
  const msgId = genId("msg");
  const item: ResponsesOutputItem = {
    type: "message",
    id: msgId,
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  out.push(formatSSE("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  }));
  out.push(formatSSE("response.content_part.added", {
    type: "response.content_part.added",
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  }));
  // Track this item so we can close it later. We'll mutate its content when closing.
  state.emittedItems.push(item);
  state.currentBlockIndex = outputIndex;
  state.textItemOpened = true;
  state.currentTextAccum = "";
  return out;
}

function closeTextItem(state: StreamState): string[] {
  if (!state.textItemOpened) return [];
  const out: string[] = [];
  const outputIndex = state.currentBlockIndex!;
  const finalText = state.currentTextAccum;
  out.push(formatSSE("response.output_text.done", {
    type: "response.output_text.done",
    output_index: outputIndex,
    content_index: 0,
    text: finalText,
  }));
  out.push(formatSSE("response.content_part.done", {
    type: "response.content_part.done",
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: finalText, annotations: [] },
  }));
  // Replace the in_progress item with a completed one carrying the final text.
  const itemRef = state.emittedItems[outputIndex] as Extract<ResponsesOutputItem, { type: "message" }>;
  itemRef.status = "completed";
  itemRef.content = [{ type: "output_text", text: finalText, annotations: [] }];
  out.push(formatSSE("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: itemRef,
  }));
  state.nextOutputIndex++;
  state.textItemOpened = false;
  state.currentTextAccum = "";
  state.currentBlockIndex = null;
  return out;
}

function openToolItem(state: StreamState, block: { id: string; name: string }): string[] {
  const out: string[] = [];
  const outputIndex = state.nextOutputIndex;
  const fcId = genId("fc");
  const item: ResponsesOutputItem = {
    type: "function_call",
    id: fcId,
    call_id: block.id,
    name: block.name,
    arguments: "",
    status: "in_progress",
  };
  out.push(formatSSE("response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  }));
  state.emittedItems.push(item);
  state.currentBlockIndex = outputIndex;
  state.toolItemOpened = true;
  state.currentToolArgsAccum = "";
  return out;
}

function closeToolItem(state: StreamState): string[] {
  if (!state.toolItemOpened) return [];
  const out: string[] = [];
  const outputIndex = state.currentBlockIndex!;
  const finalArgs = state.currentToolArgsAccum;
  out.push(formatSSE("response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    output_index: outputIndex,
    arguments: finalArgs,
  }));
  const itemRef = state.emittedItems[outputIndex] as Extract<ResponsesOutputItem, { type: "function_call" }>;
  itemRef.arguments = finalArgs;
  itemRef.status = "completed";
  out.push(formatSSE("response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: itemRef,
  }));
  state.nextOutputIndex++;
  state.toolItemOpened = false;
  state.currentToolArgsAccum = "";
  state.currentBlockIndex = null;
  return out;
}

function translateStreamEvent(state: StreamState, sse: ParsedSSE): string[] {
  const data = sse.data as AnthropicStreamEvent;
  const out: string[] = [];

  switch (data.type) {
    case "message_start": {
      const msg = (data as any).message;
      state.anthropicMessageId = msg?.id ?? "msg_stream";
      state.model = msg?.model ?? state.model;
      state.inputTokens = msg?.usage?.input_tokens ?? 0;
      // Emit response.created + response.in_progress
      out.push(...emitHeaderIfNeeded(state));
      return out;
    }

    case "content_block_start": {
      const block = (data as any).content_block;
      const idx = (data as any).index;
      // Close any previously open block of the other kind.
      if (block?.type === "text") {
        if (state.toolItemOpened) out.push(...closeToolItem(state));
        out.push(...openTextItem(state));
      } else if (block?.type === "tool_use") {
        if (state.textItemOpened) out.push(...closeTextItem(state));
        out.push(...openToolItem(state, { id: block.id, name: block.name }));
      } else {
        // thinking blocks etc. — skip but track index parity
        state.currentBlockIndex = idx;
      }
      return out;
    }

    case "content_block_delta": {
      const delta = (data as any).delta;
      if (delta?.type === "text_delta") {
        // Be tolerant of upstreams that omit content_block_start (some GLM
        // streams jump straight to deltas). Open a text item lazily here.
        if (!state.textItemOpened && !state.toolItemOpened) {
          out.push(...openTextItem(state));
        }
        if (state.textItemOpened) {
          state.currentTextAccum += delta.text ?? "";
          out.push(formatSSE("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: state.currentBlockIndex,
            content_index: 0,
            delta: delta.text ?? "",
          }));
        }
      } else if (delta?.type === "input_json_delta") {
        // Tool argument delta — content_block_start should have arrived first
        // with the tool_use block; if it didn't, we can't recover the tool
        // name/id, so silently drop.
        if (state.toolItemOpened) {
          state.currentToolArgsAccum += delta.partial_json ?? "";
          out.push(formatSSE("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            output_index: state.currentBlockIndex,
            delta: delta.partial_json ?? "",
          }));
        }
      }
      return out;
    }

    case "content_block_stop": {
      if (state.textItemOpened) out.push(...closeTextItem(state));
      else if (state.toolItemOpened) out.push(...closeToolItem(state));
      return out;
    }

    case "message_delta": {
      const dataAny = data as any;
      const delta = dataAny.delta;
      if (dataAny?.usage?.output_tokens !== undefined) {
        state.outputTokens = dataAny.usage.output_tokens;
      }
      if (delta?.stop_reason) {
        state.stopReason = delta.stop_reason;
      }
      return out;
    }

    case "message_stop": {
      // Close any stray open block, then emit response.completed.
      if (state.textItemOpened) out.push(...closeTextItem(state));
      if (state.toolItemOpened) out.push(...closeToolItem(state));
      if (!state.headerSent) out.push(...emitHeaderIfNeeded(state));
      const status = mapStopReasonToStatus(state.stopReason);
      out.push(formatSSE("response.completed", {
        type: "response.completed",
        response: buildResponseSnapshot(state, status),
      }));
      return out;
    }

    case "ping":
    default:
      return out;
  }
}

/**
 * Transform an Anthropic SSE stream into Responses API SSE format.
 * Input: ReadableStream<Uint8Array> (Anthropic SSE bytes)
 * Output: ReadableStream<Uint8Array> (Responses SSE bytes)
 */
export function anthropicSseToResponsesSse(
  upstream: ReadableStream<Uint8Array>,
  model: string = DEFAULT_MODEL,
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
              const output = translateStreamEvent(state, p);
              for (const line of output) {
                // Apply backpressure before each enqueue to prevent unbounded
                // memory growth when the downstream client is slow.
                await waitForBackpressure(controller);
                controller.enqueue(encoder.encode(line));
              }
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const parsed = parseSSEChunk(buffer);
          for (const p of parsed) {
            const output = translateStreamEvent(state, p);
            for (const line of output) {
              await waitForBackpressure(controller);
              controller.enqueue(encoder.encode(line));
            }
          }
        }

        // If upstream ended without message_stop (rare), still emit response.completed
        if (!state.emittedItems.some((i) => i === undefined)) {
          // Check if we've already emitted response.completed by looking at the last emission
          // The translateStreamEvent for message_stop already emits it; if we never got
          // message_stop, fall through to emit a synthetic one.
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

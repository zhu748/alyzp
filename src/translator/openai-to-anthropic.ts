/**
 * OpenAI → Anthropic request translator and Anthropic → OpenAI response translator.
 * @see .omo/plans/zcode-proxy.md Task 11
 */
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIMessage,
  OpenAIToolDefinition,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolDefinition,
} from "./types.js";

/** Default max_tokens if the OpenAI request doesn't specify one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Translate an OpenAI chat request into an Anthropic messages request. */
export function translateRequestOpenAIToAnthropic(req: OpenAIChatRequest): AnthropicMessagesRequest {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

  const system = systemMessages.length > 0
    ? systemMessages.map((m) => extractText(m)).join("\n\n")
    : undefined;

  const anthropicMessages: AnthropicMessage[] = nonSystemMessages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: translateContentOpenAIToAnthropic(m),
  }));

  const result: AnthropicMessagesRequest = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
  };

  if (system) result.system = system;
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stream !== undefined) result.stream = req.stream;
  if (req.stop) result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  // tool_choice "none" means "do not call any tools" — Anthropic has no "none"
  // enum, so we achieve the same effect by dropping the tools array entirely
  // AND not setting tool_choice. Returning { type: "any" } here would have the
  // *opposite* semantics ("must call a tool") when tools is non-empty.
  if (req.tool_choice === "none") {
    return result;
  }

  if (req.tools?.length) {
    result.tools = req.tools.map(translateToolOpenAIToAnthropic);
  }
  if (req.tool_choice) {
    result.tool_choice = translateToolChoiceOpenAIToAnthropic(req.tool_choice);
  }

  return result;
}

/** Type guards for AnthropicContentBlock discriminated union.
 *  v0.2.0.8: replaces `(b as any).text` / `(b as any).id` casts that bypassed
 *  the type system. Using guards lets TypeScript narrow the union so we get
 *  compile-time safety on field access. */
function isTextBlock(b: AnthropicContentBlock): b is { type: "text"; text: string } {
  return b.type === "text";
}
function isToolUseBlock(b: AnthropicContentBlock): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } {
  return b.type === "tool_use";
}

/** Translate an Anthropic messages response into an OpenAI chat completion response. */
export function translateResponseAnthropicToOpenAI(
  resp: AnthropicMessagesResponse,
  model: string,
): OpenAIChatResponse {
  const textBlocks = resp.content.filter(isTextBlock);
  const toolUseBlocks = resp.content.filter(isToolUseBlock);

  const content = textBlocks.map((b) => b.text).join("") || null;
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b) => ({
        id: b.id,
        type: "function" as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }))
    : undefined;

  const finishReason = mapStopReasonToFinishReason(resp.stop_reason);

  return {
    id: resp.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
    },
  };
}

function extractText(msg: OpenAIMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

function translateContentOpenAIToAnthropic(msg: OpenAIMessage): string | AnthropicContentBlock[] {
  if (typeof msg.content === "string") return msg.content;
  if (msg.content === null) return "";
  if (Array.isArray(msg.content)) {
    return msg.content.map((c) => {
      if (c.type === "text") return { type: "text" as const, text: c.text ?? "" };
      return { type: "text" as const, text: "" };
    });
  }
  return "";
}

function translateToolOpenAIToAnthropic(tool: OpenAIToolDefinition): AnthropicToolDefinition {
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { input_schema: tool.function.parameters } : {}),
  };
}

/**
 * Translate OpenAI tool_choice to Anthropic tool_choice format.
 * OpenAI: "none" | "auto" | "required" | { type: "function", function: { name: string } }
 * Anthropic: { type: "auto" | "any" | "tool", name?: string }
 *
 * NOTE: "none" is handled by the caller — when tool_choice === "none" we drop
 * both the tools array and tool_choice so the model has no tools to call.
 * This function must never receive "none".
 */
function translateToolChoiceOpenAIToAnthropic(
  toolChoice: string | { type: "function"; function: { name: string } },
): { type: "auto" | "any" | "tool"; name?: string } {
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "required": return { type: "any" };
      case "auto":
      default: return { type: "auto" };
    }
  }
  // Object form: { type: "function", function: { name: "..." } }
  if (toolChoice.type === "function" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name };
  }
  return { type: "auto" };
}

function mapStopReasonToFinishReason(
  stopReason: string | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" | null {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return null;
  }
}

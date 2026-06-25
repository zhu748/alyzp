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
  if (req.tools?.length) {
    result.tools = req.tools.map(translateToolOpenAIToAnthropic);
  }
  if (req.tool_choice) {
    result.tool_choice = translateToolChoiceOpenAIToAnthropic(req.tool_choice);
  }

  return result;
}

/** Translate an Anthropic messages response into an OpenAI chat completion response. */
export function translateResponseAnthropicToOpenAI(
  resp: AnthropicMessagesResponse,
  model: string,
): OpenAIChatResponse {
  const textBlocks = resp.content.filter((b) => b.type === "text");
  const toolUseBlocks = resp.content.filter((b) => b.type === "tool_use");

  const content = textBlocks.map((b) => (b as any).text).join("") || null;
  const toolCalls = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b) => ({
        id: (b as any).id,
        type: "function" as const,
        function: {
          name: (b as any).name,
          arguments: JSON.stringify((b as any).input ?? {}),
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
 */
function translateToolChoiceOpenAIToAnthropic(
  toolChoice: string | { type: "function"; function: { name: string } },
): { type: "auto" | "any" | "tool"; name?: string } {
  if (typeof toolChoice === "string") {
    switch (toolChoice) {
      case "none": return { type: "any" }; // Anthropic has no "none"; "any" with empty tools effectively disables
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

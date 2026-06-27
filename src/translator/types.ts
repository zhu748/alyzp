/**
 * Type definitions for OpenAI and Anthropic API formats.
 * @see .omo/plans/zcode-proxy.md Task 5
 * @see https://platform.openai.com/docs/api-reference/chat
 * @see https://docs.anthropic.com/en/api/messages
 */

// ─────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────

/** API format identifier.
 *  - "openai"           → Chat Completions (`/v1/chat/completions`)
 *  - "anthropic"        → Anthropic Messages (`/v1/messages`)
 *  - "openai-responses" → OpenAI Responses API (`/v1/responses`)
 */
export type Format = "openai" | "anthropic" | "openai-responses";

/** Token usage statistics. */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Anthropic-native names. */
  inputTokens?: number;
  outputTokens?: number;
}

/** Function/tool definition (shared shape). */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>; // JSON Schema
}

// ─────────────────────────────────────────────
// OpenAI types
// ─────────────────────────────────────────────

/** OpenAI message role. */
export type OpenAIRole = "system" | "user" | "assistant" | "tool";

/** OpenAI message in a chat completion request. */
export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

/** Multi-modal content part (OpenAI format). */
export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

/** Tool call in an assistant message. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Tool definition in OpenAI format. */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** POST /v1/chat/completions request body. */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAIToolDefinition[];
  tool_choice?: "none" | "auto" | { type: "function"; function: { name: string } };
  response_format?: { type: "text" | "json_object" };
  seed?: number;
}

/** Non-streaming response. */
export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Choice in a non-streaming response. */
export interface OpenAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/** Streaming chunk (SSE `data:` payload). */
export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

/** Choice in a streaming chunk. */
export interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: Partial<OpenAIToolCall>[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/** /v1/models list entry. */
export interface OpenAIModel {
  id: string;
  object: "model";
  created?: number;
  owned_by: string;
}

/** /v1/models list response. */
export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

// ─────────────────────────────────────────────
// Anthropic types
// ─────────────────────────────────────────────

/** Anthropic content block types. */
export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] };

/** Anthropic message in a request. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** POST /v1/messages request body. */
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  tools?: AnthropicToolDefinition[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  /** GLM extension: enable thinking / extended reasoning. */
  thinking?: { type: "enabled" | "disabled" | "adaptive"; budget_tokens?: number };
}

/** Tool definition in Anthropic format. */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

/** Non-streaming response. */
export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─────────────────────────────────────────────
// Anthropic SSE event types
// @see https://docs.anthropic.com/en/api/messages-streaming
// ─────────────────────────────────────────────

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicMessagesResponse }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "stop_reason"; stop_reason: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string; stop_sequence?: string | null };
      usage?: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" };

// ─────────────────────────────────────────────
// OpenAI Responses API types (/v1/responses)
// @see https://platform.openai.com/docs/api-reference/responses
// ─────────────────────────────────────────────

/** Input item in a Responses API request. */
export type ResponsesInputItem =
  | {
      type: "message";
      role: "system" | "user" | "assistant" | "developer";
      content: string | ResponsesInputContentPart[];
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      id?: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    }
  | {
      type: "custom_tool_call";
      call_id: string;
      name: string;
      input: string;
      status?: string;
      id?: string;
    }
  | {
      type: "custom_tool_call_output";
      call_id: string;
      output: string;
      id?: string;
    }
  | {
      type: "reasoning";
      id?: string;
      summary?: Array<{ type: "summary_text"; text: string }>;
      content?: unknown[];
      encrypted_content?: string;
    };

/** Content part inside a message input item. */
export interface ResponsesInputContentPart {
  type: "input_text" | "output_text" | "input_image" | "input_file";
  text?: string;
  image_url?: string;
  file_id?: string;
  file_data?: string;
  filename?: string;
}

/** Tool definition in Responses API format (only function tools are forwarded upstream). */
export interface ResponsesToolDefinition {
  type: "function" | "local_shell" | "web_search" | "file_search" | "computer_use" | "code_interpreter" | string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  /** Built-in tools carry extra fields we ignore. */
  [key: string]: unknown;
}

/** POST /v1/responses request body. */
export interface OpenAIResponseRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  previous_response_id?: string;
  store?: boolean;
  tools?: ResponsesToolDefinition[];
  tool_choice?: "auto" | "required" | "none" | { type: "function"; name: string } | { type: string; [k: string]: unknown };
  reasoning?: { effort?: "low" | "medium" | "high" | "xhigh"; summary?: "auto" | "concise" | "detailed" | null };
  text?: { verbosity?: "low" | "medium" | "high" };
  stop?: string | string[];
  user?: string;
  metadata?: Record<string, unknown>;
  /** Other unknown fields tolerated. */
  [key: string]: unknown;
}

/** Output item in a Responses API response. */
export type ResponsesOutputItem =
  | {
      type: "message";
      id: string;
      status: "completed" | "in_progress" | "incomplete";
      role: "assistant";
      content: Array<{
        type: "output_text";
        text: string;
        annotations: unknown[];
      }>;
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: "completed" | "in_progress" | "incomplete";
    }
  | {
      type: "reasoning";
      id: string;
      summary: Array<{ type: "summary_text"; text: string }>;
      status?: "completed" | "in_progress" | "incomplete";
    };

/** Non-streaming Responses API response. */
export interface OpenAIResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "in_progress" | "incomplete" | "cancelled";
  model: string;
  output: ResponsesOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
  /** Echoed back from request when store=true (always echoed for client compatibility). */
  previous_response_id?: string | null;
  instructions?: string | null;
  /** Marker that Codex CLI / openai SDK checks on every response. */
  incomplete_details?: null | { reason: string };
}

/** Streaming event payload. Only the events we emit are listed; unknown ones pass through as `unknown`. */
export type ResponsesStreamEvent =
  | { type: "response.created"; response: OpenAIResponse }
  | { type: "response.in_progress"; response: OpenAIResponse }
  | { type: "response.output_item.added"; output_index: number; item: ResponsesOutputItem }
  | { type: "response.output_item.done"; output_index: number; item: ResponsesOutputItem }
  | { type: "response.content_part.added"; output_index: number; content_index: number; part: { type: "output_text"; text: string; annotations: unknown[] } }
  | { type: "response.content_part.done"; output_index: number; content_index: number; part: { type: "output_text"; text: string; annotations: unknown[] } }
  | { type: "response.output_text.delta"; output_index: number; content_index: number; delta: string }
  | { type: "response.output_text.done"; output_index: number; content_index: number; text: string }
  | { type: "response.function_call_arguments.delta"; output_index: number; delta: string }
  | { type: "response.function_call_arguments.done"; output_index: number; arguments: string }
  | { type: "response.completed"; response: OpenAIResponse }
  | { type: "response.failed"; response: OpenAIResponse };

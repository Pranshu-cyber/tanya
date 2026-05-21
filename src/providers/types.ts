import type { SchemaFlattenWarning } from "./schemaFlatten";
import type { ProviderThrottleEvent } from "./retry";

export interface ProviderErrorOptions {
  provider: string;
  rawMessage: string;
  status?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly rawMessage: string;
  readonly status?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.provider = options.provider;
    this.rawMessage = options.rawMessage;
    if (options.status !== undefined) this.status = options.status;
  }
}

export class ContextWindowExceededError extends ProviderError {
  constructor(options: ProviderErrorOptions) {
    const statusText = options.status === undefined ? "" : ` HTTP ${options.status}`;
    super(
      `Provider ${options.provider} exceeded the context window${statusText}: ${options.rawMessage.slice(0, 500)}`,
      options,
    );
    this.name = "ContextWindowExceededError";
  }
}

export function isContextWindowExceededError(error: unknown): error is ContextWindowExceededError {
  return error instanceof ContextWindowExceededError ||
    Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "ContextWindowExceededError");
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface ChatDelta {
  content?: string;
  reasoningContent?: string;
  toolCalls?: unknown[];
  finishReason?: string | null;
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number };
  schemaWarnings?: SchemaFlattenWarning[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  onProviderThrottle?: (event: ProviderThrottleEvent) => void | Promise<void>;
}

export interface ChatProvider {
  id: string;
  model: string;
  contextWindow?: number;
  reasoning?: boolean;
  roundTripReasoning?: boolean;
  streamChat(input: ChatRequest): AsyncGenerator<ChatDelta>;
}

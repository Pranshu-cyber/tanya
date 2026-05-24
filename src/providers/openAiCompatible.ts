import { ContextWindowExceededError, type ChatDelta, type ChatMessage, type ChatProvider, type ChatRequest, type ToolCall } from "./types";
import { envValue } from "../config/envCompat";
import { estimateReasoningTokens, ThinkBlockSplitter } from "../agent/reasoning";
import { resolveProviderAdapter, type ChatResponse, type ProviderAdapter, type ProviderRequest } from "./adapters";
import { flattenToolDefinitions, type SchemaFlattenWarning } from "./schemaFlatten";
import { fetchWithProviderRetry } from "./retry";
import { normalizeMessages } from "./messageNormalize";

export interface OpenAiCompatibleProviderOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  topP?: number;
  contextWindow?: number;
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: "function";
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

interface StreamChunk {
  choices?: StreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

const CONTEXT_WINDOW_ERROR_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /tokens?\s+exceeds?/i,
  /too long/i,
];

const deprecatedDeepSeekModels = new Set(["deepseek-chat", "deepseek-reasoner"]);
const warnedDeprecatedModels = new Set<string>();

function isContextWindowExceededResponse(status: number, detail: string): boolean {
  if (status === 413) return true;
  if (status >= 500) return false;
  return CONTEXT_WINDOW_ERROR_PATTERNS.some((pattern) => pattern.test(detail));
}

function providerConcurrency(): number {
  const raw = Number(envValue({}, "TANYA_PROVIDER_CONCURRENCY"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
}

function warnDeprecatedDeepSeekModel(providerId: string, model: string): void {
  if (providerId !== "deepseek") return;
  if (!deprecatedDeepSeekModels.has(model)) return;
  if (warnedDeprecatedModels.has(model)) return;
  if (envValue({}, "TANYA_SUPPRESS_DEPRECATION") === "1") return;

  warnedDeprecatedModels.add(model);
  process.stderr.write([
    `[tanya] DeepSeek model "${model}" is a V4-Flash compatibility alias and is scheduled for deprecation by DeepSeek on 2026-07-24.`,
    "Tanya will migrate to V4 thinking-mode config in a future release (tracked as M13).",
    "Until then, you can keep using the legacy name with no behavior change.",
    "See docs/providers.md#deepseek-v4-deprecation for the migration story.",
    "Suppress this warning with TANYA_SUPPRESS_DEPRECATION=1 (or legacy TANIA_SUPPRESS_DEPRECATION=1).",
    "",
  ].join("\n"));
}

export function messagesForAdapter(messages: ChatMessage[], roundTripReasoning: boolean): ChatMessage[] {
  return messages.map((message) => {
    const carryReasoning =
      roundTripReasoning &&
      message.role === "assistant" &&
      typeof message.reasoning_content === "string" &&
      message.reasoning_content.length > 0;

    const base = carryReasoning ? message : (() => {
      const { reasoning_content: _reasoningContent, ...rest } = message;
      return rest;
    })();

    // DeepSeek rejects assistant messages where content is null and tool_calls
    // is empty/missing, even when reasoning_content is present.
    if (
      roundTripReasoning &&
      base.role === "assistant" &&
      (base.content === null || base.content === undefined) &&
      (!base.tool_calls || base.tool_calls.length === 0)
    ) {
      return { ...base, content: "" };
    }

    return base;
  });
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly reasoning: boolean;
  readonly roundTripReasoning: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly adapter: ProviderAdapter;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.adapter = resolveProviderAdapter({ provider: options.id, baseUrl: options.baseUrl });
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || this.adapter.defaultBaseUrl || "").replace(/\/$/, "");
    this.model = options.model || this.adapter.defaultModel || "";
    warnDeprecatedDeepSeekModel(this.adapter.id, this.model);
    this.contextWindow = options.contextWindow ?? this.adapter.capabilities.contextWindow;
    this.reasoning = reasoningEnabled(this.adapter, this.model);
    this.roundTripReasoning = this.adapter.capabilities.roundTripReasoning === true;
    const envTimeout = parseInt(envValue({}, "TANYA_TIMEOUT_MS"), 10);
    const envTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : null;
    this.timeoutMs = envTimeoutMs ?? options.timeoutMs ?? 90_000;
    this.temperature = options.temperature ?? 0;
    this.topP = options.topP ?? 0.2;
  }

  async *streamChat(input: ChatRequest): AsyncGenerator<ChatDelta> {
    if (!this.apiKey) {
      throw new Error(`Missing API key for provider "${this.id}".`);
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const resetTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    };

    const normalizedMessages = normalizeMessages(input.messages);
    if (normalizedMessages.warnings.length > 0 && envValue({}, "TANYA_DEBUG")) {
      console.debug(`[tanya] Provider message normalization: ${normalizedMessages.warnings.join("; ")}`);
    }

    const request: ProviderRequest = {
      model: this.model,
      messages: messagesForAdapter(normalizedMessages.messages, this.roundTripReasoning),
      temperature: input.temperature ?? this.temperature,
      top_p: input.topP ?? this.topP,
      max_tokens: input.maxTokens ?? 8192,
      stream: true,
    };
    const schemaWarnings: SchemaFlattenWarning[] = [];
    if (input.tools?.length) {
      if (this.adapter.capabilities.flattenSchemas) {
        const flattened = flattenToolDefinitions(input.tools);
        request.tools = flattened.schema;
        schemaWarnings.push(...flattened.warnings);
      } else {
        request.tools = input.tools;
      }
      request.tool_choice = "auto";
    }
    const requestBody = JSON.stringify(this.adapter.preRequest ? this.adapter.preRequest(request) : request);

    resetTimeout();
    const retryOptions = {
      provider: this.adapter.id,
      concurrency: providerConcurrency(),
      fetch: () => {
        resetTimeout();
        return fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: requestBody,
        }).catch((error) => {
          if (controller.signal.aborted) {
            throw new Error(`Provider ${this.id} timed out before streaming a response.`);
          }
          throw error;
        });
      },
      ...(input.onProviderThrottle ? { onThrottle: input.onProviderThrottle } : {}),
    };
    const response = await fetchWithProviderRetry(retryOptions);

    if (!response.ok || !response.body) {
      if (timeout) clearTimeout(timeout);
      const detail = await response.text().catch(() => "");
      if (isContextWindowExceededResponse(response.status, detail)) {
        throw new ContextWindowExceededError({
          provider: this.id,
          status: response.status,
          rawMessage: detail || response.statusText || "context window exceeded",
        });
      }
      throw new Error(`Provider ${this.id} returned HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallParts = new Map<number, ToolCall>();
    const thinkSplitter = new ThinkBlockSplitter();
    let thinkSplittingActive = this.reasoning;

    const flushThinkSplitter = function* (): Generator<ChatDelta> {
      if (!thinkSplittingActive) return;
      for (const split of thinkSplitter.flush()) {
        if (split.type === "reasoning") {
          yield { reasoningContent: split.text, usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: estimateReasoningTokens(split.text) } };
        } else {
          yield { content: split.text };
        }
      }
    };

    try {
      if (schemaWarnings.length > 0) {
        yield { schemaWarnings };
      }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        resetTimeout();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") {
            yield* flushThinkSplitter();
            return;
          }

          let parsed: StreamChunk;
          try {
            const rawParsed = JSON.parse(data) as ChatResponse;
            parsed = (this.adapter.postResponse ? this.adapter.postResponse(rawParsed) : rawParsed) as StreamChunk;
          } catch (error) {
            if (envValue({}, "TANYA_DEBUG")) {
              const message = error instanceof Error ? error.message : String(error);
              console.debug(`[tanya] Skipping malformed SSE chunk: ${message}`);
            }
            continue;
          }
          if (parsed.usage?.prompt_tokens !== undefined) {
            const reasoningTokens = parsed.usage.reasoning_tokens ??
              parsed.usage.completion_tokens_details?.reasoning_tokens;
            yield {
              usage: {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
              },
            };
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const reasoningContent = choice.delta?.reasoning_content ?? undefined;
          if (reasoningContent) {
            yield {
              reasoningContent,
              usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: estimateReasoningTokens(reasoningContent) },
            };
          }

          const content = choice.delta?.content ?? undefined;
          if (content) {
            if (!thinkSplittingActive && !content.includes("<think>")) {
              yield { content };
            } else {
              thinkSplittingActive = true;
              for (const split of thinkSplitter.push(content)) {
                if (split.type === "reasoning") {
                  yield {
                    reasoningContent: split.text,
                    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: estimateReasoningTokens(split.text) },
                  };
                } else {
                  yield { content: split.text };
                }
              }
            }
          }

          const rawToolCalls = choice.delta?.tool_calls ?? [];
          for (const rawToolCall of rawToolCalls) {
            const index = rawToolCall.index ?? 0;
            const existing =
              toolCallParts.get(index) ??
              ({
                id: rawToolCall.id ?? `tool-${index}`,
                type: "function",
                function: { name: "", arguments: "" },
              } satisfies ToolCall);

            if (rawToolCall.id) existing.id = rawToolCall.id;
            if (rawToolCall.function?.name) existing.function.name += rawToolCall.function.name;
            if (rawToolCall.function?.arguments) existing.function.arguments += rawToolCall.function.arguments;
            toolCallParts.set(index, existing);
          }

          if (choice.finish_reason) {
            const toolCalls = [...toolCallParts.values()].filter((call) => call.function.name);
            yield toolCalls.length
              ? { finishReason: choice.finish_reason, toolCalls }
              : { finishReason: choice.finish_reason };
          }
        }
      }
      yield* flushThinkSplitter();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Provider ${this.id} timed out while streaming a response.`);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function reasoningEnabled(adapter: ProviderAdapter, model: string): boolean {
  const normalized = model.toLowerCase();
  if (adapter.id === "deepseek") return normalized.includes("reasoner") || /\br1\b/.test(normalized);
  if (adapter.id === "qwen") return /qwen3.*thinking|thinking/.test(normalized);
  if (adapter.id === "grok") return /grok-3-reasoning|reasoning/.test(normalized);
  return false;
}

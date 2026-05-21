import type { ChatRequest } from "../types";

export type ProviderCapabilities = {
  toolChoiceRequired: boolean;
  parallelToolCalls: boolean;
  jsonMode: boolean;
  vision: boolean;
  reasoning: boolean;
  roundTripReasoning?: boolean;
  flattenSchemas: boolean;
  contextWindow: number;
};

export type ProviderRequest = ChatRequest & Record<string, unknown>;

export type ChatResponse = Record<string, unknown>;

export type ProviderAdapter = {
  id: string;
  matchBaseUrl?: RegExp;
  defaultBaseUrl?: string;
  defaultModel?: string;
  capabilities: ProviderCapabilities;
  preRequest?: (req: ProviderRequest) => ProviderRequest;
  postResponse?: (res: ChatResponse) => ChatResponse;
};

export function withoutUnsupportedToolChoice(req: ProviderRequest): ProviderRequest {
  if (req.tool_choice === "required") {
    const { tool_choice: _toolChoice, ...rest } = req;
    return rest;
  }
  return req;
}

export function identityResponse(res: ChatResponse): ChatResponse {
  return res;
}

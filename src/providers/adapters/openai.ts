import type { ProviderAdapter } from "./types";

export const openAiAdapter: ProviderAdapter = {
  id: "openai",
  matchBaseUrl: /(?:api\.)?openai\.com/i,
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1-mini",
  capabilities: {
    toolChoiceRequired: true,
    parallelToolCalls: true,
    jsonMode: true,
    vision: true,
    reasoning: true,
    flattenSchemas: false,
    contextWindow: 128_000,
  },
};

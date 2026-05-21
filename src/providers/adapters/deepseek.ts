import type { ProviderAdapter } from "./types";

export const deepSeekAdapter: ProviderAdapter = {
  id: "deepseek",
  matchBaseUrl: /api\.deepseek\.com/i,
  defaultBaseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-pro",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: true,
    roundTripReasoning: true,
    flattenSchemas: false,
    contextWindow: 128_000,
  },
};

import type { ProviderAdapter } from "./types";

export const groqAdapter: ProviderAdapter = {
  id: "groq",
  matchBaseUrl: /api\.groq\.com/i,
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: false,
    flattenSchemas: false,
    contextWindow: 131_000,
  },
};

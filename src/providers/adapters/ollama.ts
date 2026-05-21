import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const ollamaAdapter: ProviderAdapter = {
  id: "ollama",
  matchBaseUrl: /(?:localhost:11434|127\.0\.0\.1:11434|ollama)/i,
  defaultBaseUrl: "http://localhost:11434/v1",
  defaultModel: "qwen2.5-coder:7b",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: false,
    flattenSchemas: false,
    contextWindow: 32_000,
  },
  preRequest: withoutUnsupportedToolChoice,
};

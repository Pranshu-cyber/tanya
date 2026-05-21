import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const togetherAdapter: ProviderAdapter = {
  id: "together",
  matchBaseUrl: /api\.together\.xyz/i,
  defaultBaseUrl: "https://api.together.xyz/v1",
  defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: false,
    flattenSchemas: true,
    contextWindow: 32_000,
  },
  preRequest: withoutUnsupportedToolChoice,
};

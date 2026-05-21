import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  matchBaseUrl: /(?:api\.)?x\.ai/i,
  defaultBaseUrl: "https://api.x.ai/v1",
  defaultModel: "grok-3-mini",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: true,
    reasoning: true,
    flattenSchemas: false,
    contextWindow: 131_000,
  },
  preRequest: withoutUnsupportedToolChoice,
};

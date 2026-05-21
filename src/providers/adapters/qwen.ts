import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const qwenAdapter: ProviderAdapter = {
  id: "qwen",
  matchBaseUrl: /(?:dashscope|aliyuncs|qwen)/i,
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultModel: "qwen3-coder-plus",
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: true,
    reasoning: true,
    flattenSchemas: true,
    contextWindow: 128_000,
  },
  preRequest: (req) => ({
    ...withoutUnsupportedToolChoice(req),
    parallel_tool_calls: false,
  }),
};

import type { RouteTable, RouteTarget } from "./types";

export const ROUTES_SCHEMA_VERSION = 1;

export const BUILT_IN_ROUTE_DEFAULTS: RouteTarget = {
  provider: "openai",
  model: "gpt-4.1-mini",
};

export function builtInRouteTable(defaults: RouteTarget = BUILT_IN_ROUTE_DEFAULTS): RouteTable {
  return {
    version: ROUTES_SCHEMA_VERSION,
    routes: [
      {
        match: "planning",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "qwen", model: "qwen3-coder-plus" },
        reasoningCap: { maxTokens: 2_000 },
      },
      {
        match: "tool_call",
        provider: "deepseek",
        model: "deepseek-chat",
        fallback: { provider: "groq", model: "llama-3.3-70b-versatile" },
      },
      {
        match: "synthesis",
        provider: "deepseek",
        model: "deepseek-reasoner",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        reasoningCap: { maxTokens: 8_000 },
      },
      {
        match: "verification",
        provider: "deepseek",
        model: "deepseek-reasoner",
        fallback: { provider: "openai", model: "gpt-4.1-mini" },
        reasoningCap: { maxTokens: 8_000 },
      },
      {
        match: "reasoning",
        provider: "deepseek",
        model: "deepseek-reasoner",
        fallback: { provider: "qwen", model: "qwen3-coder-plus" },
        reasoningCap: { maxTokens: 8_000 },
      },
    ],
    defaults,
  };
}

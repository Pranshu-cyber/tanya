import type { RouteCascadeEntry, RouteTable, RouteTarget } from "./types";

export const ROUTES_SCHEMA_VERSION = 1;

export const BUILT_IN_ROUTE_DEFAULTS: RouteTarget = {
  provider: "openai",
  model: "gpt-4.1-mini",
  maxInputTokens: 128_000,
};

export const BUILT_IN_ROUTE_CASCADE: RouteCascadeEntry[] = [
  { provider: "deepseek", model: "deepseek-chat", maxInputTokens: 128_000 },
  { provider: "openai", model: "gpt-5-codex", maxInputTokens: 200_000 },
  { provider: "claude", model: "claude-sonnet-4-6", maxInputTokens: 1_000_000 },
  { provider: "gemini", model: "gemini-1.5-pro", maxInputTokens: 2_000_000 },
];

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
    cascade: BUILT_IN_ROUTE_CASCADE,
  };
}

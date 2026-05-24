import type { TanyaConfig } from "../config/env";
import { envValue } from "../config/envCompat";
import { resolveProviderAdapter } from "./adapters";
import { OpenAiCompatibleProvider } from "./openAiCompatible";
import type { ChatProvider } from "./types";
import type { RouteTarget } from "../router/types";

export function createProvider(config: TanyaConfig): ChatProvider {
  return new OpenAiCompatibleProvider({
    id: config.provider === "deepseek" && config.profile === "reasoner" ? "deepseek-reasoner" : config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    topP: config.topP,
    timeoutMs: config.timeoutMs,
  });
}

export function createProviderForRoute(config: TanyaConfig, target: RouteTarget): ChatProvider {
  const adapter = resolveProviderAdapter({ provider: target.provider });
  const envPrefix = target.provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const providerApiKey = process.env[`${envPrefix}_API_KEY`] ?? "";
  const providerBaseUrl = process.env[`${envPrefix}_BASE_URL`] ?? "";
  const apiKey = target.provider === "deepseek"
    ? envValue(process.env, "DEEPSEEK_API_KEY") || providerApiKey || config.apiKey
    : providerApiKey || config.apiKey;
  const baseUrl = target.provider === config.provider && config.baseUrl
    ? config.baseUrl
    : providerBaseUrl || adapter.defaultBaseUrl || config.baseUrl;

  return new OpenAiCompatibleProvider({
    id: target.provider === "deepseek" && target.model === "deepseek-reasoner" ? "deepseek-reasoner" : target.provider,
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: target.model,
    temperature: config.temperature,
    topP: config.topP,
    timeoutMs: config.timeoutMs,
    ...(target.maxInputTokens ? { contextWindow: target.maxInputTokens } : {}),
  });
}

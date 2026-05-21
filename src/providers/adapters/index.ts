import { deepSeekAdapter } from "./deepseek";
import { grokAdapter } from "./grok";
import { groqAdapter } from "./groq";
import { ollamaAdapter } from "./ollama";
import { openAiAdapter } from "./openai";
import { qwenAdapter } from "./qwen";
import { togetherAdapter } from "./together";
import type { ProviderAdapter } from "./types";

export type { ChatResponse, ProviderAdapter, ProviderCapabilities, ProviderRequest } from "./types";

export const providerAdapters: ProviderAdapter[] = [
  deepSeekAdapter,
  qwenAdapter,
  grokAdapter,
  groqAdapter,
  togetherAdapter,
  ollamaAdapter,
  openAiAdapter,
];

const aliases = new Map<string, string>([
  ["deepseek-reasoner", "deepseek"],
  ["deepseek-chat", "deepseek"],
  ["xai", "grok"],
  ["openai-compatible", "openai"],
  ["custom", "openai"],
]);

export function resolveProviderAdapter(input: { provider?: string; baseUrl?: string } = {}): ProviderAdapter {
  const provider = normalizeProviderId(input.provider);
  if (provider) {
    const explicit = providerAdapters.find((adapter) => adapter.id === provider);
    if (explicit) return explicit;
  }

  const baseUrl = input.baseUrl?.trim();
  if (baseUrl) {
    const matched = providerAdapters.find((adapter) => adapter.matchBaseUrl?.test(baseUrl));
    if (matched) return matched;
  }

  return openAiAdapter;
}

export function listProviderAdapters(): ProviderAdapter[] {
  return [...providerAdapters];
}

function normalizeProviderId(provider: string | undefined): string | null {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) return null;
  return aliases.get(normalized) ?? normalized;
}

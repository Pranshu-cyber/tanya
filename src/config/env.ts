import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { envValue, numberEnvValue } from "./envCompat";
import { resolveProviderAdapter } from "../providers/adapters";

export interface TanyaConfig {
  provider: string;
  profile: "chat" | "reasoner";
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  topP: number;
  timeoutMs: number;
  obsidianVault?: string;
}

function loadDotEnv(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return {};
  return parse(readFileSync(envPath, "utf8"));
}

export function loadConfig(cwd = process.cwd()): TanyaConfig {
  const local = loadDotEnv(cwd);
  const profile = envValue(local, "TANYA_PROFILE") === "reasoner" ? "reasoner" : "chat";
  const requestedProvider = envValue(local, "TANYA_PROVIDER").trim();
  const requestedBaseUrl = envValue(local, "TANYA_BASE_URL").trim();
  const providerSeed = requestedProvider || (requestedBaseUrl ? "" : "deepseek");
  const adapter = resolveProviderAdapter({
    provider: providerSeed,
    baseUrl: requestedBaseUrl,
  });
  const provider = providerSeed || adapter.id;

  const apiKey =
    provider === "deepseek"
      ? envValue(local, "DEEPSEEK_API_KEY") || envValue(local, "TANYA_API_KEY")
      : envValue(local, "TANYA_API_KEY");

  const baseUrl =
    provider === "deepseek"
      ? envValue(local, "DEEPSEEK_BASE_URL") || envValue(local, "TANYA_BASE_URL") || adapter.defaultBaseUrl || "https://api.deepseek.com"
      : envValue(local, "TANYA_BASE_URL") || adapter.defaultBaseUrl || "";

  const profileModelDefault = profile === "reasoner" && adapter.id === "deepseek"
    ? "deepseek-reasoner"
    : adapter.defaultModel ?? "deepseek-v4-pro";
  const model = envValue(local, "TANYA_MODEL") || profileModelDefault;

  const profileTimeoutDefault = profile === "reasoner" ? 180_000 : 90_000;
  const timeoutMs = numberEnvValue(local, "TANYA_TIMEOUT_MS", profileTimeoutDefault);

  const config: TanyaConfig = {
    provider,
    profile,
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    temperature: numberEnvValue(local, "TANYA_TEMPERATURE", 0),
    topP: numberEnvValue(local, "TANYA_TOP_P", 0.2),
    timeoutMs,
    ...(envValue(local, "TANYA_OBSIDIAN_VAULT") ? { obsidianVault: envValue(local, "TANYA_OBSIDIAN_VAULT") } : {}),
  };

  if (!config.apiKey.trim()) {
    throw new Error("TANYA_API_KEY is not set. Add it to your .env file or environment.");
  }

  return config;
}

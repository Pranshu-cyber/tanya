import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunLog {
  ts: string;
  prompt: string;
  provider?: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  systemPromptTokens?: number;
  repoMapTokens?: number;
  historyTokens?: number;
  toolResultTokens?: number;
  modelOutputTokens?: number;
  changedFiles: string[];
  blockers: string[];
}

export interface RunCostEstimate {
  provider: string;
  usd: number | null;
  display: string;
  cacheModelKnown: boolean;
}

type Pricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheModelKnown?: boolean;
};

export const CACHE_MISS_ESTIMATE_TAG = "[cache-miss estimate]";

// Per-1M-token prices in USD. Input is the cache-MISS rate (the conservative
// estimate — cache hits are ~10x cheaper, and we don't track the hit/miss split).
// V4-Pro reflects DeepSeek's discounted "forever" rate (75% off the original list
// price); V4-Flash is the standard rate. Verified against api-docs.deepseek.com
// pricing, May 2026. deepseek-chat / deepseek-reasoner are the deprecated legacy
// aliases (sunset 2026-07-24) kept at their historical prices. Any model can be
// overridden at runtime with TANYA_PRICE_INPUT_PER_MTOK / TANYA_PRICE_OUTPUT_PER_MTOK.
const deepSeekPricingByModel: Record<string, Pricing> = {
  "deepseek-v4-pro": { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  "deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.10 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
};

function priceEnvOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Resolve pricing for a provider/model, applying TANYA_PRICE_* env overrides on
// top of the built-in table. Returns undefined when the model is unknown and no
// override is set.
export function resolvePricing(provider: string, model: string): Pricing | undefined {
  const base = provider === "deepseek" ? deepSeekPricingByModel[model] : undefined;
  const inputOverride = priceEnvOverride("TANYA_PRICE_INPUT_PER_MTOK");
  const outputOverride = priceEnvOverride("TANYA_PRICE_OUTPUT_PER_MTOK");
  if (inputOverride === undefined && outputOverride === undefined) return base;
  return {
    inputPerMillion: inputOverride ?? base?.inputPerMillion ?? 0,
    outputPerMillion: outputOverride ?? base?.outputPerMillion ?? 0,
    ...(base?.cacheModelKnown !== undefined ? { cacheModelKnown: base.cacheModelKnown } : {}),
  };
}

export function readRunLogs(workspace: string, limit?: number): RunLog[] {
  const runsDir = join(workspace, ".tanya", "runs");
  if (!existsSync(runsDir)) return [];

  const files = readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
  const selected = limit === undefined ? files : files.slice(0, limit);

  return selected.flatMap((file) => {
    try {
      const parsed = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as Partial<RunLog>;
      if (typeof parsed.ts !== "string" || typeof parsed.model !== "string") return [];
      return [{
        ts: parsed.ts,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
        ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
        model: parsed.model,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
        promptTokens: typeof parsed.promptTokens === "number" ? parsed.promptTokens : 0,
        completionTokens: typeof parsed.completionTokens === "number" ? parsed.completionTokens : 0,
        ...(typeof parsed.reasoningTokens === "number" ? { reasoningTokens: parsed.reasoningTokens } : {}),
        ...(typeof parsed.systemPromptTokens === "number" ? { systemPromptTokens: parsed.systemPromptTokens } : {}),
        ...(typeof parsed.repoMapTokens === "number" ? { repoMapTokens: parsed.repoMapTokens } : {}),
        ...(typeof parsed.historyTokens === "number" ? { historyTokens: parsed.historyTokens } : {}),
        ...(typeof parsed.toolResultTokens === "number" ? { toolResultTokens: parsed.toolResultTokens } : {}),
        ...(typeof parsed.modelOutputTokens === "number" ? { modelOutputTokens: parsed.modelOutputTokens } : {}),
        changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter((file): file is string => typeof file === "string") : [],
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [],
      }];
    } catch {
      return [];
    }
  });
}

export function estimateRunCost(log: Pick<RunLog, "provider" | "model" | "promptTokens" | "completionTokens"> & { reasoningTokens?: number }): RunCostEstimate {
  const provider = normalizeProvider(log.provider, log.model);
  const pricing = resolvePricing(provider, log.model);
  if (!pricing) {
    return { provider, usd: null, display: "pricing unknown", cacheModelKnown: false };
  }

  const outputTokens = log.completionTokens + (log.reasoningTokens ?? 0);
  const usd = (log.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheModelKnown = pricing.cacheModelKnown ?? false;
  return { provider, usd, display: formatUsdWithCacheNote(usd, cacheModelKnown), cacheModelKnown };
}

export function formatRunLogLine(log: RunLog): string {
  const cost = estimateRunCost(log);
  const status = log.blockers.length > 0 ? "BLOCKED" : "OK";
  const duration = `${Math.round(log.durationMs / 1000)}s`;
  const fileCount = log.changedFiles.length;
  return `${log.ts.slice(0, 16)}  ${status.padEnd(7)} ${duration.padStart(5)}  ${cost.display.padStart(15)}  ${fileCount} file(s)  ${log.prompt.slice(0, 60)}`;
}

export function formatUsd(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(3)}`;
}

export function formatUsdWithCacheNote(usd: number, cacheModelKnown = false): string {
  return cacheModelKnown ? formatUsd(usd) : `${formatUsd(usd)} ${CACHE_MISS_ESTIMATE_TAG}`;
}

function normalizeProvider(provider: string | undefined, model: string): string {
  if (provider?.trim()) return provider.trim();
  if (model.startsWith("deepseek-")) return "deepseek";
  return "unknown";
}

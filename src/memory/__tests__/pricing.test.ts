import { afterEach, describe, expect, it } from "vitest";
import { estimateRunCost, resolvePricing } from "../runLogs";

const ENV_KEYS = ["TANYA_PRICE_INPUT_PER_MTOK", "TANYA_PRICE_OUTPUT_PER_MTOK"];

function clearPriceEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("resolvePricing", () => {
  afterEach(clearPriceEnv);

  it("prices deepseek-v4-pro at the discounted forever rate", () => {
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 0.435, outputPerMillion: 0.87 });
  });

  it("prices deepseek-v4-flash at the standard rate", () => {
    expect(resolvePricing("deepseek", "deepseek-v4-flash")).toEqual({ inputPerMillion: 0.14, outputPerMillion: 0.28 });
  });

  it("returns undefined for an unknown model with no override", () => {
    expect(resolvePricing("deepseek", "made-up-model")).toBeUndefined();
    expect(resolvePricing("openai", "gpt-4")).toBeUndefined();
  });

  it("applies TANYA_PRICE_* env overrides on top of the table", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "1.5";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "3";
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 1.5, outputPerMillion: 3 });
  });

  it("lets an override price a model that has no built-in entry", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "0.2";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "0.6";
    expect(resolvePricing("deepseek", "future-model")).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.6 });
  });

  it("ignores invalid override values", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "not-a-number";
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 0.435, outputPerMillion: 0.87 });
  });
});

describe("estimateRunCost with v4-pro", () => {
  afterEach(clearPriceEnv);

  it("computes USD from prompt + completion + reasoning tokens", () => {
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      reasoningTokens: 500_000,
    });
    // input: 1M * 0.435 = 0.435 ; output: (0.5M+0.5M) * 0.87 = 0.87 ; total 1.305
    expect(cost.usd).toBeCloseTo(1.305, 5);
  });

  it("honours an env override end-to-end", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "1";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "2";
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost.usd).toBeCloseTo(3, 5); // 1*1 + 1*2
  });
});

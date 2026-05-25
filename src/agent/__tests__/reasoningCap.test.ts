import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedRoute } from "../../router/types";
import { reasoningCapForTurn } from "../runner";

const ENV_KEYS = [
  "TANYA_REASONING_CAP_SHORT",
  "TANYA_REASONING_CAP_LONG",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("reasoningCapForTurn", () => {
  it("defaults to 2000 for short turns and 8000 for long turns", () => {
    expect(reasoningCapForTurn("planning")).toBe(2_000);
    expect(reasoningCapForTurn("tool_call")).toBe(2_000);
    expect(reasoningCapForTurn("unknown")).toBe(2_000);
    expect(reasoningCapForTurn("synthesis")).toBe(8_000);
    expect(reasoningCapForTurn("verification")).toBe(8_000);
    expect(reasoningCapForTurn("reasoning")).toBe(8_000);
  });

  it("honors TANYA_REASONING_CAP_SHORT / _LONG overrides", () => {
    process.env.TANYA_REASONING_CAP_SHORT = "8000";
    process.env.TANYA_REASONING_CAP_LONG = "16000";
    expect(reasoningCapForTurn("planning")).toBe(8_000);
    expect(reasoningCapForTurn("unknown")).toBe(8_000);
    expect(reasoningCapForTurn("synthesis")).toBe(16_000);
  });

  it("lets an explicit per-route reasoningCap win over env and defaults", () => {
    process.env.TANYA_REASONING_CAP_SHORT = "8000";
    const route = { reasoningCap: { maxTokens: 1234 } } as unknown as ResolvedRoute;
    expect(reasoningCapForTurn("planning", route)).toBe(1234);
  });
});

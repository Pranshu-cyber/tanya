import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env";

const envKeys = [
  "DEEPSEEK_API_KEY",
  "TANYA_PROVIDER",
  "TANYA_BASE_URL",
  "TANYA_MODEL",
  "TANYA_PROFILE",
];

function clearEnv(): void {
  for (const key of envKeys) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe("Tanya package configuration", () => {
  it("defaults DeepSeek chat profile to the current V4 Pro model", () => {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = "test-key";

    expect(loadConfig().model).toBe("deepseek-v4-pro");
  });

  it("only exposes the tanya binary", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin).toEqual({ tanya: "dist/cli.js" });
  });
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env";

const envKeys = [
  "DEEPSEEK_API_KEY",
  "TANYA_PROVIDER",
  "TANIA_PROVIDER",
  "TANYA_BASE_URL",
  "TANIA_BASE_URL",
  "TANYA_MODEL",
  "TANIA_MODEL",
  "TANYA_PROFILE",
  "TANIA_PROFILE",
];

function clearEnv(): void {
  for (const key of envKeys) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe("Tanya rebrand compatibility", () => {
  it("defaults DeepSeek chat profile to the current V4 Pro model", () => {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = "test-key";

    expect(loadConfig().model).toBe("deepseek-v4-pro");
  });

  it("keeps tania as a binary alias for tanya", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin?.tanya).toBe("dist/cli.js");
    expect(packageJson.bin?.tania).toBe("dist/cli.js");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "process.argv.splice(1, process.argv.length - 1, 'tania', '--help'); await import('./src/cli.ts');",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("Tanya CLI");
    expect(output).toContain("run");
  });

  it("honors legacy TANIA_MODEL with a deprecation warning", () => {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.TANIA_MODEL = "legacy-model";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadConfig().model).toBe("legacy-model");
    expect(warn).toHaveBeenCalledWith("[tanya] TANIA_MODEL is deprecated; use TANYA_MODEL.");
  });

  it("prefers TANYA_MODEL over legacy TANIA_MODEL", () => {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.TANIA_MODEL = "legacy-model";
    process.env.TANYA_MODEL = "current-model";

    expect(loadConfig().model).toBe("current-model");
  });
});

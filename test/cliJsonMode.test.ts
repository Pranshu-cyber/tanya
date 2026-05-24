import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function cliEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "tanya-json-home-"));
  return {
    ...process.env,
    HOME: home,
    NODE_NO_WARNINGS: "1",
    TANYA_PROVIDER: "custom",
    TANYA_API_KEY: "test",
    TANYA_BASE_URL: "https://fake-provider.test",
    TANYA_MODEL: "test-model",
    TANYA_TIMEOUT_MS: "5000",
    TANYA_SUPPRESS_DEPRECATION: "1",
  };
}

describe("CLI JSON event mode", () => {
  it("emits well-formed JSONL for tanya run --json", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-json-cli-"));
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(process.cwd(), "test", "fixtures", "fake-openai-fetch.mjs"),
        "src/cli.ts",
        "run",
        "--json",
        "--no-post-check",
        "--cwd",
        workspace,
        "--max-turns",
        "1",
        "Say hello",
      ],
      { cwd: process.cwd(), encoding: "utf8", env: cliEnv() },
    );

    const events = output.trim().split("\n").map((line) => JSON.parse(line) as { type?: string });
    expect(events.map((event) => event.type)).toEqual(["message_start", "message_delta", "message_end", "final"]);
    expect(events.at(-1)).toMatchObject({ type: "final" });
  });

  it("rejects the removed --cosmo flag cleanly", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "run", "--cosmo", "Say hello"],
      { cwd: process.cwd(), encoding: "utf8", env: cliEnv() },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown option '--cosmo'");
  });
});

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI slash command dispatch", () => {
  it("does not intercept slash-prefixed prompts in ask mode", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(process.cwd(), "test", "fixtures", "fake-openai-fetch.mjs"),
        join(process.cwd(), "src", "cli.ts"),
        "ask",
        "/help is great",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TANYA_PROVIDER: "custom",
          TANYA_API_KEY: "test",
          TANYA_BASE_URL: "https://fake-provider.test",
          TANYA_MODEL: "test-model",
          TANYA_TIMEOUT_MS: "5000",
        },
      },
    );

    expect(stdout).toContain("model saw /help is great");
    expect(stdout).not.toContain("Slash commands:");
  });
});

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function runPipedChat(liveStatus: "0" | "1"): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "chat"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "/exit\n",
      env: {
        ...process.env,
        TANYA_PROVIDER: "custom",
        TANYA_API_KEY: "test",
        TANYA_BASE_URL: "https://fake-provider.test",
        TANYA_MODEL: "test-model",
        TANYA_LIVE_STATUS: liveStatus,
      },
    },
  );
}

describe("CLI live status fallback", () => {
  it("keeps piped tanya chat output byte-identical and free of ANSI bytes", () => {
    const baseline = runPipedChat("0");
    const liveStatusEnabled = runPipedChat("1");

    expect(liveStatusEnabled).toBe(baseline);
    expect(liveStatusEnabled).not.toContain("\x1b");
    expect(liveStatusEnabled).toContain("Tanya live chat");
    expect(liveStatusEnabled).toContain("Session:");
    expect(liveStatusEnabled).toContain("0 turns");
  });

  it("exits cleanly after piped prompts without spinner bytes or readline errors", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(process.cwd(), "test", "fixtures", "fake-openai-fetch.mjs"),
        "src/cli.ts",
        "chat",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: "Hello\n/exit\n",
        env: {
          ...process.env,
          TANYA_PROVIDER: "custom",
          TANYA_API_KEY: "test",
          TANYA_BASE_URL: "https://fake-provider.test",
          TANYA_MODEL: "test-model",
          TANYA_TIMEOUT_MS: "5000",
          TANYA_LIVE_STATUS: "0",
        },
      },
    );

    expect(output).toContain("Tanya ·");
    expect(output).toContain("Session:");
    expect(output).not.toContain("readline was closed");
    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\rTanya:");
  });

  it("--no-tui keeps piped chat on the readline path", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        join(process.cwd(), "test", "fixtures", "fake-openai-fetch.mjs"),
        "src/cli.ts",
        "chat",
        "--no-tui",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: "Hello\n/exit\n",
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

    expect(output).toContain("Tanya live chat");
    expect(output).toContain("Tanya ·");
    expect(output).toContain("Session:");
    expect(output).not.toContain("\x1b");
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-cli-debug-"));
}

describe("debug-prompt CLI", () => {
  it("keeps artifact sections intact and does not let boolean flags consume the task", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "ios"), { recursive: true });
    writeFileSync(
      join(root, "artifacts", "RULES.md"),
      "# Rules\n\n## Inner Artifact Heading\nFollow the artifact before editing.\n",
    );
    writeFileSync(
      join(root, "artifacts", "ios", "FastlaneSetup.md"),
      "# Fastlane Setup\n\n## Installation\nUse fastlane lanes.\n",
    );

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "debug-prompt",
        "--cwd",
        root,
        "--section",
        "artifacts",
        "--no-auto-brief",
        "add fastlane ios deploy lane",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "test" },
      },
    );

    expect(output).toContain("## Artifact Index");
    expect(output).toContain("## Inner Artifact Heading");
    expect(output).toContain("#### artifacts/ios/FastlaneSetup.md");
    expect(output).toContain("## Installation");
    expect(output).not.toContain("## Workspace Context");
  });

  it("prints repo-map cache diagnostics for lite debug prompts", () => {
    const root = makeProject();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export function startApp() { return true; }\n");

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src", "cli.ts"),
        "debug-prompt",
        "--cwd",
        root,
        "inspect startApp",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "test", TANYA_LITE_PROMPT: "1" },
      },
    );

    expect(output).toContain("## Repo Map (advisory)");
    expect(output).toContain("src/index.ts");
    expect(output).toContain("Repo map: 1 files, 1 symbols");
  });
});

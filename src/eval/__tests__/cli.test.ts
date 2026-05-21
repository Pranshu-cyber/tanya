import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-eval-cli-integrations-"));
  tempRoots.push(root);
  return root;
}

function write(root: string, path: string, content: unknown): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("eval CLI", () => {
  it("registers tanya eval and dry-runs eco-30 without provider credentials", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "eval",
        "--suite",
        "eco-30",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-chat",
        "--dry-run",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("Eval dry-run: eco-30@2026-05");
    expect(output).toContain("Tasks: 30");
    expect(output).toContain("Model: deepseek/deepseek-chat");
  });

  it("dry-runs an integration JSON suite", () => {
    const root = makeTempRoot();
    write(root, "acme/suites/cli-suite.json", {
      name: "cli-integration",
      version: "2026-05",
      tasks: [
        {
          id: "cli-01",
          repo_setup: { type: "local_fixture", path: "fixtures/cli-01" },
          prompt: "Dry-run this integration suite.",
        },
      ],
    });

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "eval",
        "--suite",
        "cli-integration",
        "--provider",
        "deepseek",
        "--model",
        "deepseek-chat",
        "--dry-run",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, TANYA_INTEGRATIONS_DIR: root },
      },
    );

    expect(output).toContain("Eval dry-run: cli-integration@2026-05");
    expect(output).toContain("Tasks: 1");
  });
});

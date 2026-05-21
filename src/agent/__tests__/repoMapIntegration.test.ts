import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeUnfamiliarRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-repo-map-integration-"));
  mkdirSync(join(root, "src", "features", "auth", "session"), { recursive: true });
  mkdirSync(join(root, "src", "features", "billing", "reports"), { recursive: true });
  for (let index = 0; index < 180; index += 1) {
    const dir = join(root, "src", "features", "billing", "reports");
    writeFileSync(join(dir, `report-${index}.ts`), `export function report${index}() { return ${index}; }\n`);
  }
  writeFileSync(join(root, "src", "features", "billing", "reports", "wrong-a.ts"), "export function wrongA() { return false; }\n");
  writeFileSync(join(root, "src", "features", "billing", "reports", "wrong-b.ts"), "export function wrongB() { return false; }\n");
  writeFileSync(join(root, "src", "features", "auth", "session", "authorize.ts"), [
    "export function authorizeUser(token: string) {",
    "  return token.length > 0;",
    "}",
  ].join("\n"));
  return root;
}

function repoAwareProvider(reads: string[], options: { useRepoMap: boolean }): ChatProvider {
  return {
    id: "test",
    model: "test-model",
    async *streamChat(input: ChatRequest) {
      const system = input.messages.find((message) => message.role === "system")?.content ?? "";
      const hasTargetPath = options.useRepoMap && system.includes("src/features/auth/session/authorize.ts");
      if (reads.length === 0 && hasTargetPath) {
        reads.push("src/features/auth/session/authorize.ts");
        yield { toolCalls: [toolCall("read-target", "read_file", { path: "src/features/auth/session/authorize.ts" })] };
        return;
      }
      if (reads.length === 0) {
        reads.push("src/features/billing/reports/wrong-a.ts");
        yield { toolCalls: [toolCall("read-a", "read_file", { path: "src/features/billing/reports/wrong-a.ts" })] };
        return;
      }
      if (reads.length === 1 && !hasTargetPath) {
        reads.push("src/features/billing/reports/wrong-b.ts");
        yield { toolCalls: [toolCall("read-b", "read_file", { path: "src/features/billing/reports/wrong-b.ts" })] };
        return;
      }
      if (!reads.includes("src/features/auth/session/authorize.ts")) {
        reads.push("src/features/auth/session/authorize.ts");
        yield { toolCalls: [toolCall("read-target", "read_file", { path: "src/features/auth/session/authorize.ts" })] };
        return;
      }
      yield { content: "Done." };
    },
  };
}

describe("repo-map prompt integration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("helps a lite prompt target the right file with fewer reads on an unfamiliar repo", async () => {
    const baselineCwd = makeUnfamiliarRepo();
    const baselineReads: string[] = [];
    vi.stubEnv("TANYA_LITE_PROMPT", "0");
    await runAgent({
      provider: repoAwareProvider(baselineReads, { useRepoMap: false }),
      prompt: "Fix authorizeUser session behavior.",
      cwd: baselineCwd,
      sink: async () => {},
      maxTurns: 4,
    });

    const mappedCwd = makeUnfamiliarRepo();
    const mappedReads: string[] = [];
    vi.stubEnv("TANYA_LITE_PROMPT", "1");
    await runAgent({
      provider: repoAwareProvider(mappedReads, { useRepoMap: true }),
      prompt: "Fix authorizeUser session behavior.",
      cwd: mappedCwd,
      sink: async () => {},
      maxTurns: 4,
    });

    expect(mappedReads).toEqual(["src/features/auth/session/authorize.ts"]);
    expect(mappedReads.length).toBeLessThan(baselineReads.length);
  });
});

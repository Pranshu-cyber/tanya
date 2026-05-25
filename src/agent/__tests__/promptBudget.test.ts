import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider } from "../../providers/types";

describe("runner prompt budget events", () => {
  it("emits and audits prompt_budget_exceeded when provider context is small", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-prompt-budget-"));
    mkdirSync(join(cwd, "artifacts", "web"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(cwd, "next.config.ts"), "export default {};\n");
    writeFileSync(join(cwd, "artifacts", "README.md"), "artifact guidance\n".repeat(1200));
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "qwen",
      model: "qwen3-test",
      contextWindow: 32_000,
      async *streamChat() {
        yield { content: "Done." };
      },
    };

    await runAgent({
      provider,
      prompt: "Build a Next.js settings page",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
      runContext: {
        languages: ["typescript"],
        frameworks: ["nextjs"],
        stack: "nextjs-reference",
      },
    });

    expect(events.some((event) => event.type === "prompt_budget_exceeded")).toBe(true);
    const audit = readFileSync(join(cwd, ".tanya", "audit.jsonl"), "utf8");
    expect(audit).toContain("\"tool\":\"system_prompt\"");
    expect(audit).toContain("prompt-budget-enforced");
  });
});

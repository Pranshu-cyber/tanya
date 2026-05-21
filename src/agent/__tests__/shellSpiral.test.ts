import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

describe("runner shell verification spiral detector", () => {
  it("executes a repeated shell verification five times, then returns synthetic skips", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-shell-spiral-"));
    writeFileSync(join(cwd, "huma-api.go"), "type Config struct {}\n");
    const script = 'touch spiral-marker && GOMODCACHE=. && grep -n "type Config struct" "$GOMODCACHE/huma-api.go"';
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          yield {
            toolCalls: Array.from({ length: 10 }, (_, index) => toolCall(`grep-${index + 1}`, "run_shell", { script })),
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Verify Huma signatures.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    expect(events.filter((event) =>
      event.type === "tool_result" &&
      String(event.output ?? "").includes("type Config struct") &&
      !String(event.output ?? "").includes("skipped: spiral detected"),
    )).toHaveLength(5);
    expect(events.filter((event) =>
      event.type === "tool_result" && String(event.output ?? "").includes("skipped: spiral detected"),
    )).toHaveLength(5);
    expect(events.filter((event) =>
      event.type === "status" && event.message.includes("Detected repeated verification"),
    )).toHaveLength(1);
  });
});

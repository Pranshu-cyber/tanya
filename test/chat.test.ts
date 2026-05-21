import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThinkingSpinner, startInteractiveChat } from "../src/agent/chat";
import { createHumanSink } from "../src/ui/humanSink";
import type { ChatDelta, ChatProvider, ChatRequest } from "../src/providers/types";

class MemoryStream {
  chunks: string[] = [];
  isTTY?: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  on(): this {
    return this;
  }

  off(): this {
    return this;
  }

  removeListener(): this {
    return this;
  }

  text(): string {
    return this.chunks.join("");
  }
}

class StreamingProvider implements ChatProvider {
  id = "test";
  model = "streaming-model";

  async *streamChat(_input: ChatRequest): AsyncGenerator<ChatDelta> {
    yield { content: "I'm " };
    yield { content: "Tanya" };
    yield { content: ", your CLI coding agent." };
  }
}

describe("interactive chat rendering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows elapsed seconds in the TTY thinking spinner from the first frame", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T12:00:00.000Z"));
    const output = new MemoryStream(true);

    const stop = createThinkingSpinner(output as unknown as NodeJS.WritableStream);
    expect(output.text()).toContain("Tanya: ⠋ thinking… (0s)");

    vi.advanceTimersByTime(1200);
    expect(output.text()).toContain("thinking… (1s)");

    stop();
    expect(output.chunks.at(-1)).toMatch(/^\r +\r$/);
  });

  it("renders a clock timestamp on the TTY user prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 17, 14, 32, 9));
    const cwd = mkdtempSync(join(tmpdir(), "tanya-chat-prompt-clock-"));
    try {
      const output = new MemoryStream(true);
      const sink = createHumanSink(output as unknown as NodeJS.WritableStream);

      await startInteractiveChat({
        provider: new StreamingProvider(),
        cwd,
        sink,
        input: Readable.from(["/exit\n"]),
        output: output as unknown as NodeJS.WritableStream,
      });

      expect(output.text()).toContain("[14:32:09] You:");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders streamed assistant text once and keeps the clocked elapsed heading", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-chat-render-"));
    try {
      const output = new MemoryStream(false);
      const sink = createHumanSink(output as unknown as NodeJS.WritableStream);

      await startInteractiveChat({
        provider: new StreamingProvider(),
        cwd,
        sink,
        input: Readable.from(["hello\n/exit\n"]),
        output: output as unknown as NodeJS.WritableStream,
      });

      const rendered = output.text();
      expect(rendered).toMatch(/\[\d{2}:\d{2}:\d{2}\] Tanya · \d+(?:\.\d+)?s: I'm Tanya, your CLI coding agent\./);
      expect(rendered.match(/I'm Tanya, your CLI coding agent\./g)).toHaveLength(1);
      expect(rendered).toContain("Session:");
      expect(rendered).toContain("1 turn");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

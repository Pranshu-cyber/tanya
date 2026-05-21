import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/skills command", () => {
  it("prints matched skill packs with source paths and token counts", async () => {
    const output = new MemoryStream();

    await expect(runCommand("/skills", {
      cwd: mkdtempSync(join(tmpdir(), "tanya-skills-command-")),
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    })).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("Skill packs loaded:");
    expect(text).toContain("| slug | source | reason | tokens |");
  });
});

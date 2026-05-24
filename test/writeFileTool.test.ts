import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_WRITE_FILE_BYTES, writeFileTool } from "../src/tools/fsTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-write-file-"));
}

describe("write_file tool", () => {
  it("writes content and reports line count and preview from the input", async () => {
    const root = makeProject();
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

    const result = await writeFileTool.run(
      { path: "notes.txt", content },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["notes.txt"]);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(content);
    const output = result.output as { lineCount: number; preview: string };
    expect(output.lineCount).toBe(6);
    expect(output.preview).toBe("alpha\nbeta\ngamma\ndelta");
  });

  it("rejects content larger than MAX_WRITE_FILE_BYTES without touching disk", async () => {
    const root = makeProject();
    const oversized = "a".repeat(MAX_WRITE_FILE_BYTES + 1);

    const result = await writeFileTool.run(
      { path: "huge.txt", content: oversized },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/larger than .* bytes/);
    expect(existsSync(join(root, "huge.txt"))).toBe(false);
  });
});

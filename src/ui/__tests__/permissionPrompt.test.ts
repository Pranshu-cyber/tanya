import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReplPermissionRequestHandler } from "../permissionPrompt";

function handlerWithAnswers(answers: string[], home = mkdtempSync(join(tmpdir(), "tanya-permission-prompt-"))) {
  const prompts: string[] = [];
  const output: string[] = [];
  const handler = createReplPermissionRequestHandler({
    home,
    output: {
      write(chunk: string) {
        output.push(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
    question: async (prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? "n";
    },
  });
  return { handler, home, prompts, output };
}

describe("permission prompt", () => {
  it("maps y and n answers to host decisions", async () => {
    const allow = handlerWithAnswers(["y"]);
    await expect(allow.handler({ id: "call-1", tool: "write_file", input: { path: "a.txt" } })).resolves.toEqual({ decision: "allow" });

    const deny = handlerWithAnswers(["n"]);
    await expect(deny.handler({ id: "call-1", tool: "write_file", input: { path: "a.txt" } })).resolves.toEqual({ decision: "deny" });
  });

  it("persists always as an exact allow rule", async () => {
    const { handler, home } = handlerWithAnswers(["always"]);

    await expect(handler({ id: "call-1", tool: "write_file", input: { path: "a.txt" } })).resolves.toEqual({
      decision: "allow",
      persistAs: "always",
    });

    const file = join(home, ".tanya", "permissions.json");
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { alwaysAllow?: string[] };
    expect(parsed.alwaysAllow?.[0]).toMatch(/^write_file:/);
    expect(parsed.alwaysAllow?.[0]).toContain("a\\.txt");
  });

  it("persists never as an exact deny rule", async () => {
    const { handler, home } = handlerWithAnswers(["never"]);

    await expect(handler({ id: "call-1", tool: "run_shell", input: { script: "rm -rf build" } })).resolves.toEqual({
      decision: "deny",
      persistAs: "never",
    });

    const parsed = JSON.parse(readFileSync(join(home, ".tanya", "permissions.json"), "utf8")) as { alwaysDeny?: string[] };
    expect(parsed.alwaysDeny?.[0]).toMatch(/^run_shell:/);
    expect(parsed.alwaysDeny?.[0]).toContain("rm -rf build");
  });

  it("re-prompts on invalid answers", async () => {
    const { handler, prompts, output } = handlerWithAnswers(["maybe", "yes"]);

    await expect(handler({ id: "call-1", tool: "read_file", input: { path: "README.md" } })).resolves.toEqual({ decision: "allow" });

    expect(prompts).toHaveLength(2);
    expect(output.join("")).toContain("Please answer");
  });
});

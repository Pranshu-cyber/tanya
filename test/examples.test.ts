import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillPacksFromRoot } from "../src/skills/load";

const repoRoot = process.cwd();

describe("examples", () => {
  it("keeps each README runnable and explicit about prerequisites", () => {
    for (const relativePath of [
      "examples/01-hello-world/README.md",
      "examples/02-custom-provider/README.md",
      "examples/03-skill-pack/README.md",
      "examples/04-cosmochat-integration/README.md",
    ]) {
      const content = readFileSync(join(repoRoot, relativePath), "utf8");
      expect(content).toContain("## Prerequisites");
      expect(content).toContain("## Run");
      expect(content).toMatch(/```bash[\s\S]+?```/);
    }
  });

  it("ships a replayable hello-world transcript", () => {
    expect(existsSync(join(repoRoot, "examples/01-hello-world/demo.cast"))).toBe(true);
  });

  it("loads the custom skill-pack example from its declared hint", () => {
    const exampleRoot = join(repoRoot, "examples/03-skill-pack");
    const packs = loadSkillPacksFromRoot({
      workspace: join(exampleRoot, "workspace"),
      hints: { frameworks: ["example"] },
    }, join(exampleRoot, "skills"));

    expect(packs.map((pack) => pack.slug)).toContain("framework/example");
  });

  it("keeps the host-integration sample context shaped like a coding run", () => {
    const context = JSON.parse(readFileSync(
      join(repoRoot, "examples/04-cosmochat-integration/context.json"),
      "utf8",
    )) as {
      task?: { kind?: string };
      verification?: Array<{ command?: string }>;
    };

    expect(context.task?.kind).toBe("coding");
    expect(context.verification?.[0]?.command).toBe("npm test");
  });
});

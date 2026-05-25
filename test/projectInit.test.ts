import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initTanyaProject } from "../src/init/projectInit";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-init-"));
}

describe("initTanyaProject", () => {
  it("creates project instructions from detected Next.js/Node signals", async () => {
    const root = makeProject();
    writeFileSync(join(root, "package.json"), JSON.stringify({
      scripts: {
        typecheck: "tsc --noEmit",
        build: "next build",
        test: "vitest run",
      },
      dependencies: {
        next: "15.0.0",
      },
    }));
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    await mkdir(join(root, "prisma"));
    writeFileSync(join(root, "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n");

    const path = await initTanyaProject(root);

    expect(path).toBe(join(root, ".tanya", "INSTRUCTIONS.md"));
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("Project type: Next.js");
    expect(content).toContain("- package.json");
    expect(content).toContain("- prisma/schema.prisma");
    expect(content).toContain("- next.config.ts");
    expect(content).toContain("- tsconfig.json");
    expect(content).toContain("- `npm run typecheck`");
    expect(content).toContain("- `npm run build`");
    expect(content).toContain("- `npm run test`");
    expect(content).toContain("- `npx prisma generate`");
    expect(content).toContain("## Custom Instructions");
  });

  it("detects Android and iOS project markers", async () => {
    const root = makeProject();
    writeFileSync(join(root, "gradlew"), "#!/bin/sh\n");
    await mkdir(join(root, "Demo.xcodeproj"));

    const path = await initTanyaProject(root);
    const content = readFileSync(path, "utf8");

    expect(content).toContain("Project type: Android / iOS");
    expect(content).toContain("- gradlew");
    expect(content).toContain("- Demo.xcodeproj");
    expect(content).toContain("- `./gradlew assembleDebug --no-daemon`");
    expect(content).toContain("- `xcodebuild -list -project 'Demo.xcodeproj'`");
  });

  it("does not overwrite existing project instructions", async () => {
    const root = makeProject();
    await mkdir(join(root, ".tanya"));
    const path = join(root, ".tanya", "INSTRUCTIONS.md");
    writeFileSync(path, "existing\n");

    await expect(initTanyaProject(root)).rejects.toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe("existing\n");
  });
});

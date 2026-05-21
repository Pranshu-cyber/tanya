import { describe, expect, it } from "vitest";
import { resolveInsideWorkspace } from "../src/safety/workspace";

describe("workspace safety", () => {
  it("allows paths inside the workspace", () => {
    expect(resolveInsideWorkspace("/tmp/project", "src/index.ts")).toBe("/tmp/project/src/index.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => resolveInsideWorkspace("/tmp/project", "../secret.txt")).toThrow(/escapes workspace/);
  });
});

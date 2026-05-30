import { describe, expect, it } from "vitest";
import { definitionOfDoneInstruction, extractAcceptanceCriteria } from "../acceptanceCriteria";

describe("extractAcceptanceCriteria", () => {
  it("always includes a builds-and-launches baseline", () => {
    const ids = extractAcceptanceCriteria("make a notes app").map((c) => c.id);
    expect(ids).toContain("builds-and-launches");
  });

  it("derives calculator-specific behavioural criteria", () => {
    const ids = extractAcceptanceCriteria("build an iOS calculator app").map((c) => c.id);
    expect(ids).toContain("digits-render");
    expect(ids).toContain("operations-work");
  });

  it("derives auth/list/form/data criteria from keywords", () => {
    expect(extractAcceptanceCriteria("a login screen").map((c) => c.id)).toContain("auth-flow");
    expect(extractAcceptanceCriteria("a todo list").map((c) => c.id)).toContain("list-and-mutations");
    expect(extractAcceptanceCriteria("a signup form").map((c) => c.id)).toContain("form-validates");
    expect(extractAcceptanceCriteria("fetch posts from an api").map((c) => c.id)).toContain("data-loads");
  });

  it("does not duplicate criteria ids", () => {
    const criteria = extractAcceptanceCriteria("a calculator app with a form and a login");
    const ids = criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("definitionOfDoneInstruction", () => {
  it("formats criteria into a single 'verify against the running app' instruction", () => {
    const instruction = definitionOfDoneInstruction(extractAcceptanceCriteria("build a calculator"));
    expect(instruction).toContain("Definition of done");
    expect(instruction).toContain("RUNNING app");
    expect(instruction).toContain("digits-render");
  });

  it("returns null when there are no criteria", () => {
    expect(definitionOfDoneInstruction([])).toBeNull();
  });
});

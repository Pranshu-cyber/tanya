import { describe, expect, it } from "vitest";
import { clampActivityContent, visibleActivityItems, MAX_VISIBLE_ACTIVITY_ITEMS } from "../ActivityPanel";
import type { ActivityItem } from "../types";

function item(id: string): ActivityItem {
  return { id, kind: "tool", status: "done", summary: `tool ${id}`, startedAt: 0 };
}

describe("clampActivityContent", () => {
  it("keeps short content unchanged", () => {
    expect(clampActivityContent("a\nb\nc", 6)).toBe("a\nb\nc");
  });

  it("keeps only the last N lines of long content", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const clamped = clampActivityContent(content, 6);
    expect(clamped.split("\n")).toHaveLength(6);
    expect(clamped.split("\n").at(-1)).toBe("line 19");
    expect(clamped.split("\n")[0]).toBe("line 14");
  });
});

describe("visibleActivityItems", () => {
  it("shows everything when under the cap", () => {
    const items = [item("a"), item("b")];
    const { hiddenCount, visible } = visibleActivityItems(items, MAX_VISIBLE_ACTIVITY_ITEMS);
    expect(hiddenCount).toBe(0);
    expect(visible).toHaveLength(2);
  });

  it("caps to the last N and reports the hidden count (keeps the most recent / running items)", () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`t${i}`));
    const { hiddenCount, visible } = visibleActivityItems(items, 8);
    expect(hiddenCount).toBe(22);
    expect(visible).toHaveLength(8);
    expect(visible.at(-1)?.id).toBe("t29");
    expect(visible[0]?.id).toBe("t22");
  });
});

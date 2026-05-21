import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { MarkdownText } from "../markdown";

afterEach(() => {
  cleanup();
});

describe("MarkdownText", () => {
  it("renders inline styles and links for complete lines", () => {
    const { lastFrame } = render(<MarkdownText source={"**Bold** and *italic* with `code` and [docs](https://example.com)\n"} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Bold");
    expect(frame).toContain("italic");
    expect(frame).toContain("code");
    expect(frame).toContain("docs");
    expect(frame).toContain("https://example.com");
  });

  it("renders headings, lists, quotes, and fenced code blocks", () => {
    const { lastFrame } = render(
      <MarkdownText source={"# Heading\n- item\n> quote\n```python\nprint('hi')\n```\n"} />,
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Heading");
    expect(frame).toContain("• item");
    expect(frame).toContain("│ quote");
    expect(frame).toContain("print('hi')");
  });

  it("leaves partial trailing markdown raw until the line closes", () => {
    const { lastFrame } = render(<MarkdownText source="**bo" />);

    expect(lastFrame()).toContain("**bo");
  });
});

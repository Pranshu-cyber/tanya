// Keep only the last `maxLines` lines of a block of text. Used to bound the
// height of the live (streaming) region in the Ink UI: once the live region
// grows taller than the terminal, Ink can no longer repaint a sub-region and
// clears+redraws the whole viewport every frame (the full-screen blink). The
// full text is preserved in state and rendered in full once it finalizes into
// the <Static> scrollback — only the live tail is clamped.
export function clampToLastLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

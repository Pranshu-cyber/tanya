import React from "react";
import { Box, Text } from "ink";
import type { ActivityItem } from "./types";
import { Spinner } from "./Spinner";
import { clampToLastLines } from "./clampLines";

// The panel rendered EVERY tool item with its full content for the whole turn —
// completed items never left it. On a 30+ tool build the panel grew taller than
// the terminal window, and once the live region exceeds the screen Ink can no
// longer repaint a sub-region: it clears and redraws the whole viewport every
// frame (the full-screen blink). Capping the visible items and clamping each
// item's content keeps the live region bounded no matter how long the run goes.
export const MAX_VISIBLE_ACTIVITY_ITEMS = 8;
export const MAX_ACTIVITY_CONTENT_LINES = 6;

function activityGlyph(item: ActivityItem): string {
  if (item.kind === "reasoning") return "✻";
  if (item.status === "done") return "✓";
  if (item.status === "error") return "×";
  return "⏺";
}

function activityColor(item: ActivityItem): string {
  if (item.status === "error") return "red";
  if (item.status === "done") return "green";
  if (item.kind === "reasoning") return "magenta";
  return "yellow";
}

function reasoningTail(content: string | undefined, maxChars = 160): string | null {
  if (!content) return null;
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxChars) return compact;
  return `…${compact.slice(compact.length - maxChars)}`;
}

// Keep only the tail of an item's streamed content so a long tool output can't
// make the live region unbounded-tall on its own.
export function clampActivityContent(content: string, maxLines = MAX_ACTIVITY_CONTENT_LINES): string {
  return clampToLastLines(content, maxLines);
}

// Show only the most recent items (which include whatever is currently running);
// older completed steps are summarized as a count so they stop consuming height.
export function visibleActivityItems(items: ActivityItem[], maxItems = MAX_VISIBLE_ACTIVITY_ITEMS): {
  hiddenCount: number;
  visible: ActivityItem[];
} {
  if (items.length <= maxItems) return { hiddenCount: 0, visible: items };
  return { hiddenCount: items.length - maxItems, visible: items.slice(-maxItems) };
}

interface ActivityPanelProps {
  items: ActivityItem[];
  pendingStartedAt?: number | undefined;
  bootMessage?: string | undefined;
  bootStartedAt?: number | undefined;
}

function ActivityPanelView({ items, pendingStartedAt, bootMessage, bootStartedAt }: ActivityPanelProps) {
  const isBooting = bootMessage !== undefined && bootStartedAt !== undefined;
  const hasItems = items.length > 0;
  const isThinking = pendingStartedAt !== undefined;
  if (!isBooting && !hasItems && !isThinking) return null;

  const borderColor = isBooting ? "cyan" : "gray";
  const spinnerStartedAt = isBooting ? bootStartedAt! : isThinking ? pendingStartedAt! : null;
  const reasoningItem = items.find((item) => item.kind === "reasoning");
  const toolItems = items.filter((item) => item.kind === "tool");
  const reasoningPreview = reasoningTail(reasoningItem?.content);
  const { hiddenCount, visible } = visibleActivityItems(toolItems);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1} marginBottom={1}>
      {spinnerStartedAt !== null ? <Spinner startedAt={spinnerStartedAt} /> : null}
      {isBooting ? <Text dimColor>{bootMessage}</Text> : null}
      {reasoningPreview ? <Text dimColor italic wrap="wrap">{reasoningPreview}</Text> : null}
      {hiddenCount > 0 ? (
        <Text dimColor>… +{hiddenCount} earlier step{hiddenCount === 1 ? "" : "s"}</Text>
      ) : null}
      {visible.map((item) => (
        <Box key={item.id} flexDirection="column">
          <Text color={activityColor(item)}>
            {activityGlyph(item)} {item.summary}
          </Text>
          {item.content ? <Text dimColor wrap="wrap">{clampActivityContent(item.content)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

// Default shallow comparison: the reducer returns a NEW activityItems array
// exactly when activity changes, and pendingStartedAt/bootMessage/bootStartedAt
// change on their own events — so this re-renders precisely when needed and
// skips unrelated re-renders, without the previous last-item-only comparator
// that missed a non-last item flipping running→done (its glyph never repainted).
export const ActivityPanel = React.memo(ActivityPanelView);

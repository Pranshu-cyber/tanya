import React from "react";
import { Box, Text } from "ink";
import type { ActivityItem } from "./types";

function activityGlyph(item: ActivityItem): string {
  if (item.kind === "reasoning") return "⚙";
  if (item.status === "done") return "✓";
  if (item.status === "error") return "×";
  return "⚙";
}

function ActivityPanelView({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.map((item) => (
        <Box key={item.id} flexDirection="column">
          <Text color={item.status === "error" ? "red" : item.status === "done" ? "green" : "yellow"}>
            {activityGlyph(item)} {item.summary}
          </Text>
          {item.kind === "reasoning" && item.content ? <Text dimColor italic wrap="wrap">{item.content}</Text> : null}
          {item.kind === "tool" && item.content ? <Text dimColor wrap="wrap">{item.content}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function activityPanelPropsAreEqual(previous: { items: ActivityItem[] }, next: { items: ActivityItem[] }): boolean {
  const previousLast = previous.items.at(-1);
  const nextLast = next.items.at(-1);
  return previous.items.length === next.items.length &&
    previousLast?.id === nextLast?.id &&
    previousLast?.status === nextLast?.status &&
    previousLast?.summary === nextLast?.summary &&
    (previousLast?.content?.length ?? 0) === (nextLast?.content?.length ?? 0);
}

export const ActivityPanel = React.memo(ActivityPanelView, activityPanelPropsAreEqual);

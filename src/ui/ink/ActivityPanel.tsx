import React from "react";
import { Box, Text } from "ink";
import type { ActivityItem } from "./types";
import { Spinner } from "./Spinner";

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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} marginX={1} marginBottom={1}>
      {spinnerStartedAt !== null ? <Spinner startedAt={spinnerStartedAt} /> : null}
      {isBooting ? <Text dimColor>{bootMessage}</Text> : null}
      {reasoningPreview ? <Text dimColor italic wrap="wrap">{reasoningPreview}</Text> : null}
      {toolItems.map((item) => (
        <Box key={item.id} flexDirection="column">
          <Text color={activityColor(item)}>
            {activityGlyph(item)} {item.summary}
          </Text>
          {item.content ? <Text dimColor wrap="wrap">{item.content}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function activityPanelPropsAreEqual(previous: ActivityPanelProps, next: ActivityPanelProps): boolean {
  if (previous.pendingStartedAt !== next.pendingStartedAt) return false;
  if (previous.bootMessage !== next.bootMessage) return false;
  if (previous.bootStartedAt !== next.bootStartedAt) return false;
  const previousLast = previous.items.at(-1);
  const nextLast = next.items.at(-1);
  return previous.items.length === next.items.length &&
    previousLast?.id === nextLast?.id &&
    previousLast?.status === nextLast?.status &&
    previousLast?.summary === nextLast?.summary &&
    (previousLast?.content?.length ?? 0) === (nextLast?.content?.length ?? 0);
}

export const ActivityPanel = React.memo(ActivityPanelView, activityPanelPropsAreEqual);

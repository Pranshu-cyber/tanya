import React from "react";
import { Box, Text } from "ink";
import { formatUsd } from "../../memory/runLogs";
import { formatElapsed } from "../../utils/formatElapsed";
import type { InkSessionStats } from "./types";

function formatTokens(tokens: number | null): string {
  if (tokens === null) return "— tokens";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

function formatFooterCost(costUsd: number | null): string {
  if (costUsd === null) return "$—";
  if (costUsd === 0) return "$0.00";
  return formatUsd(costUsd);
}

function FooterView({ provider, model, sessionStartMs, stats, now, showColdStartHint = false }: {
  provider: string;
  model: string;
  sessionStartMs: number;
  stats: InkSessionStats;
  now: number;
  showColdStartHint?: boolean;
}) {
  const cost = formatFooterCost(stats.costUsd);
  return (
    <Box paddingX={2}>
      <Text dimColor>
        {showColdStartHint
          ? "First turn may take ~30-60s on DeepSeek V4-Pro (cold-start + skill loading)."
          : `${provider}:${model} · session ${formatElapsed(now - sessionStartMs)} · ${cost} · ${formatTokens(stats.totalTokens)} · /help`}
      </Text>
    </Box>
  );
}

// Memoized so unrelated App re-renders (activity items, message list, permission
// state changing during a build) don't repaint the footer; it updates only when
// its own props change — the once-per-second elapsed clock (now) and stats.
export const Footer = React.memo(FooterView);

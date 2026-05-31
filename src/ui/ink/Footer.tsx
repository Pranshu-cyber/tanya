import React from "react";
import { Box, Text } from "ink";
import { formatUsd } from "../../memory/runLogs";
import { formatElapsed } from "../../utils/formatElapsed";
import type { InflightTurn } from "./state";
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

function inflightTokenTotal(inflight: InflightTurn | undefined): number {
  if (!inflight) return 0;
  return inflight.promptTokens + inflight.completionTokens + inflight.reasoningTokens;
}

function FooterView({ provider, model, sessionStartMs, stats, inflight, now, showColdStartHint = false }: {
  provider: string;
  model: string;
  sessionStartMs: number;
  stats: InkSessionStats;
  inflight?: InflightTurn;
  now: number;
  showColdStartHint?: boolean;
}) {
  // Fold the live in-flight estimate into the session totals so the counter
  // ticks up in real time during a turn; "~" marks it as an estimate until the
  // turn completes and the provider-reported exact numbers snap in.
  const inflightTokens = inflightTokenTotal(inflight);
  const inflightCost = inflight?.costUsd ?? 0;
  const live = inflightTokens > 0 || inflightCost > 0;
  const liveCost = live ? (stats.costUsd ?? 0) + inflightCost : stats.costUsd;
  const liveTokens = inflightTokens > 0 ? (stats.totalTokens ?? 0) + inflightTokens : stats.totalTokens;
  const prefix = inflightTokens > 0 ? "~" : "";
  const cost = formatFooterCost(liveCost);
  return (
    <Box paddingX={2}>
      <Text dimColor>
        {showColdStartHint
          ? "First turn may take ~30-60s on DeepSeek V4-Pro (cold-start + skill loading)."
          : `${provider}:${model} · session ${formatElapsed(now - sessionStartMs)} · ${prefix}${cost} · ${prefix}${formatTokens(liveTokens)} · /help`}
      </Text>
    </Box>
  );
}

// Memoized so unrelated App re-renders (activity items, message list, permission
// state changing during a build) don't repaint the footer; it updates only when
// its own props change — the once-per-second elapsed clock (now) and stats.
export const Footer = React.memo(FooterView);

import { resolveProviderAdapter } from "../providers/adapters";
import type { ChatMessage } from "../providers/types";
import { estimateCompactTokens } from "../agent/compact";
import { resolveRoute } from "./load";
import type { EffectiveRouteTable, ResolvedRoute, RouteTarget, StepType } from "./types";

export class RouteContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteContextOverflowError";
  }
}

export class EscalationExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscalationExhaustedError";
  }
}

export function resolveRouteWithContextGuard(params: {
  stepType: StepType;
  table: EffectiveRouteTable;
  messages: ChatMessage[];
  routeText?: string;
}): ResolvedRoute {
  const primary = resolveRoute(params.stepType, params.table, params.routeText);
  const estimate = estimateCompactTokens(params.messages);
  const candidates: ResolvedRoute[] = [
    primary,
    ...(primary.fallback ? [routeFromTarget(primary.fallback, primary, "fallback")] : []),
    {
      provider: params.table.defaults.provider,
      model: params.table.defaults.model,
      match: "defaults",
      escalate: true,
      source: params.table.defaultSource,
      reason: "matched route defaults",
    },
  ];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = `${candidate.provider}/${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const window = contextWindowForTarget(candidate);
    if (estimate <= window) {
      return candidate === primary
        ? candidate
        : { ...candidate, reason: `${candidate.reason}; declined earlier route due to context-window guard` };
    }
  }

  throw new RouteContextOverflowError(
    `No route can fit estimated ${estimate} tokens for step ${params.stepType}.`,
  );
}

export function contextWindowForTarget(target: RouteTarget): number {
  return resolveProviderAdapter({ provider: target.provider }).capabilities.contextWindow;
}

function routeFromTarget(target: RouteTarget, primary: ResolvedRoute, label: "fallback"): ResolvedRoute {
  return {
    provider: target.provider,
    model: target.model,
    match: primary.match,
    escalate: primary.escalate,
    ...(primary.reasoningCap ? { reasoningCap: primary.reasoningCap } : {}),
    source: primary.source,
    reason: `matched ${label} for ${primary.provider}/${primary.model}`,
  };
}

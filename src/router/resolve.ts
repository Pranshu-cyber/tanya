import { resolveProviderAdapter } from "../providers/adapters";
import type { ChatMessage } from "../providers/types";
import type { TanyaRunContext } from "../context/runContext";
import { estimateCompactTokens } from "../agent/compact";
import { envValue } from "../config/envCompat";
import { looksLikeCodeEditingTask } from "./classify";
import { resolveRoute } from "./load";
import type { EffectiveRouteTable, ResolvedRoute, RouteAttempt, RouteTarget, StepType } from "./types";

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
  prompt?: string;
  cwd?: string;
  runContext?: TanyaRunContext;
  forcedRoute?: RouteTarget;
}): ResolvedRoute {
  const estimate = estimateCompactTokens(params.messages);
  const safetyFactor = routeSafetyFactor();

  if (params.forcedRoute) {
    return resolveForcedRoute(params.forcedRoute, params.stepType, estimate, safetyFactor);
  }

  const primary = resolveRoute(params.stepType, params.table, params.routeText);
  const guardedPrimary = codeEditingDeepSeekChatGuard(primary, params);
  const candidates: ResolvedRoute[] = [
    guardedPrimary,
    ...(guardedPrimary.fallback ? [routeFromTarget(guardedPrimary.fallback, guardedPrimary, "fallback")] : []),
    ...cascadeRoutesForStep(params.table, params.stepType),
  ];
  const seen = new Set<string>();
  const attempts: RouteAttempt[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.provider}/${candidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const attempt = routeAttempt(candidate, estimate, safetyFactor);
    attempts.push(attempt);
    if (estimate <= attempt.safetyLimit) {
      if (attempts.length === 1 && candidate === primary) return candidate;
      const reason = attempts.length > 1
        ? `${candidate.reason}; cascade-fit; declined earlier route due to context-window guard`
        : candidate.reason;
      return {
        ...candidate,
        reason,
        cascade: {
          reason: "cascade-fit",
          estimatedTokens: estimate,
          safetyFactor,
          attemptedRoutes: attempts,
          selectedRoute: attempt,
          selectedIndex: attempts.length - 1,
        },
      };
    }
  }

  const highest = highestAttempt(attempts);
  if (highest) {
    throw new RouteContextOverflowError(
      `Estimated ${estimate.toLocaleString("en-US")} tokens exceeds the largest configured route ${highest.provider}/${highest.model} ` +
        `(${highest.maxInputTokens.toLocaleString("en-US")} tokens × ${safetyFactor} safety = ${highest.safetyLimit.toLocaleString("en-US")}). ` +
        "Reduce prompt or add a higher-context route.",
    );
  }
  throw new RouteContextOverflowError(
    `No route can fit estimated ${estimate} tokens for step ${params.stepType}.`,
  );
}

export function contextWindowForTarget(target: RouteTarget): number {
  return target.maxInputTokens ?? modelContextWindow(target) ?? resolveProviderAdapter({ provider: target.provider }).capabilities.contextWindow;
}

function routeFromTarget(target: RouteTarget, primary: ResolvedRoute, label: "fallback"): ResolvedRoute {
  return {
    provider: target.provider,
    model: target.model,
    ...(target.maxInputTokens ? { maxInputTokens: target.maxInputTokens } : {}),
    match: primary.match,
    escalate: primary.escalate,
    ...(primary.reasoningCap ? { reasoningCap: primary.reasoningCap } : {}),
    source: primary.source,
    reason: `matched ${label} for ${primary.provider}/${primary.model}`,
  };
}

function cascadeRoutesForStep(table: EffectiveRouteTable, stepType: StepType): ResolvedRoute[] {
  return table.cascade
    .filter((entry) => !entry.stepTypes || entry.stepTypes.includes(stepType))
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      maxInputTokens: entry.maxInputTokens,
      match: "defaults" as const,
      escalate: true,
      source: entry.source,
      reason: `matched route cascade ${entry.provider}/${entry.model}`,
    }));
}

function resolveForcedRoute(target: RouteTarget, stepType: StepType, estimate: number, safetyFactor: number): ResolvedRoute {
  const candidate: ResolvedRoute = {
    provider: target.provider,
    model: target.model,
    ...(target.maxInputTokens ? { maxInputTokens: target.maxInputTokens } : {}),
    match: stepType,
    escalate: false,
    source: "session",
    reason: `forced route ${target.provider}/${target.model}`,
  };
  const attempt = routeAttempt(candidate, estimate, safetyFactor);
  if (estimate <= attempt.safetyLimit) return candidate;
  throw new RouteContextOverflowError(
    `Forced route ${target.provider}/${target.model} cannot fit estimated ${estimate.toLocaleString("en-US")} tokens ` +
      `(${attempt.maxInputTokens.toLocaleString("en-US")} tokens × ${safetyFactor} safety = ${attempt.safetyLimit.toLocaleString("en-US")}). ` +
      "Reduce prompt or choose a higher-context forced route.",
  );
}

function routeAttempt(route: ResolvedRoute, _estimate: number, safetyFactor: number): RouteAttempt {
  const maxInputTokens = contextWindowForTarget(route);
  return {
    provider: route.provider,
    model: route.model,
    maxInputTokens,
    safetyLimit: Math.floor(maxInputTokens * safetyFactor),
    source: route.source,
    reason: route.reason,
  };
}

function highestAttempt(attempts: RouteAttempt[]): RouteAttempt | null {
  return attempts.reduce<RouteAttempt | null>((highest, attempt) => {
    if (!highest || attempt.maxInputTokens > highest.maxInputTokens) return attempt;
    return highest;
  }, null);
}

function routeSafetyFactor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(envValue(env, "TANYA_ROUTE_SAFETY_FACTOR"));
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return 0.85;
  return raw;
}

function modelContextWindow(target: RouteTarget): number | null {
  const model = target.model.toLowerCase();
  if (target.provider === "claude" || model.startsWith("claude-")) return 1_000_000;
  if (target.provider === "gemini" || model.startsWith("gemini-")) return 2_000_000;
  if (model.includes("gpt-5-codex") || model.includes("o3-codex")) return 200_000;
  return null;
}

function codeEditingDeepSeekChatGuard(primary: ResolvedRoute, params: {
  stepType: StepType;
  table: EffectiveRouteTable;
  messages: ChatMessage[];
  prompt?: string;
  cwd?: string;
  runContext?: TanyaRunContext;
}): ResolvedRoute {
  if (params.stepType !== "unknown") return primary;
  if (!isDeepSeekChat(primary)) return primary;
  const codeTaskState = {
    messages: params.messages,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.runContext ? { runContext: params.runContext } : {}),
  };

  if (!looksLikeCodeEditingTask(codeTaskState)) {
    return primary;
  }

  const target = firstNonDeepSeekChatTarget([
    primary.fallback,
    params.table.defaults,
    { provider: "deepseek", model: "deepseek-reasoner" },
  ]);
  if (!target) return primary;
  return {
    ...routeFromTarget(target, primary, "fallback"),
    reason: `${primary.reason}; declined deepseek-chat for code-editing task`,
  };
}

function firstNonDeepSeekChatTarget(targets: Array<RouteTarget | undefined>): RouteTarget | null {
  return targets.find((target): target is RouteTarget => Boolean(target && !isDeepSeekChat(target))) ?? null;
}

function isDeepSeekChat(target: RouteTarget): boolean {
  return target.provider === "deepseek" && target.model === "deepseek-chat";
}

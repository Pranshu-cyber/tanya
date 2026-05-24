export type StepType = "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";

export type RouteMatch = StepType | { regex: string };

export interface RouteTarget {
  provider: string;
  model: string;
  maxInputTokens?: number;
}

export interface RouteRule extends RouteTarget {
  match: RouteMatch;
  fallback?: RouteTarget;
  escalate?: boolean;
  reasoningCap?: { maxTokens: number };
}

export interface RouteTable {
  version: 1;
  routes: RouteRule[];
  defaults: RouteTarget;
  cascade?: RouteCascadeEntry[];
}

export interface RouteCascadeEntry extends RouteTarget {
  maxInputTokens: number;
  stepTypes?: StepType[];
}

export type RouteSource = "project" | "user" | "built-in" | "session" | "runtime-default";

export interface SourcedRouteRule extends RouteRule {
  source: RouteSource;
}

export interface EffectiveRouteTable {
  version: 1;
  routes: SourcedRouteRule[];
  defaults: RouteTarget;
  defaultSource: RouteSource;
  cascade: SourcedRouteCascadeEntry[];
  cascadeSource: RouteSource;
  sources: string[];
}

export interface ResolvedRoute extends RouteTarget {
  match: RouteMatch | "defaults";
  fallback?: RouteTarget;
  escalate: boolean;
  reasoningCap?: { maxTokens: number };
  source: RouteSource;
  reason: string;
  cascade?: RouteCascadeSelection;
}

export interface SourcedRouteCascadeEntry extends RouteCascadeEntry {
  source: RouteSource;
}

export interface RouteAttempt {
  provider: string;
  model: string;
  maxInputTokens: number;
  safetyLimit: number;
  source: RouteSource;
  reason: string;
}

export interface RouteCascadeSelection {
  reason: "cascade-fit";
  estimatedTokens: number;
  safetyFactor: number;
  attemptedRoutes: RouteAttempt[];
  selectedRoute: RouteAttempt;
  selectedIndex: number;
}

export interface RouteSchemaIssue {
  path: string;
  message: string;
}

export type RouteSchemaResult =
  | { ok: true; value: RouteTable; issues: [] }
  | { ok: false; issues: RouteSchemaIssue[] };

export type StepType = "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";

export type RouteMatch = StepType | { regex: string };

export interface RouteTarget {
  provider: string;
  model: string;
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
  sources: string[];
}

export interface ResolvedRoute extends RouteTarget {
  match: RouteMatch | "defaults";
  fallback?: RouteTarget;
  escalate: boolean;
  reasoningCap?: { maxTokens: number };
  source: RouteSource;
  reason: string;
}

export interface RouteSchemaIssue {
  path: string;
  message: string;
}

export type RouteSchemaResult =
  | { ok: true; value: RouteTable; issues: [] }
  | { ok: false; issues: RouteSchemaIssue[] };

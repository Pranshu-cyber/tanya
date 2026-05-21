import type { ToolDefinition } from "../providers/types";
import type { Decision, PermissionContext } from "../safety/permissions/engine";
import type { TanyaFinalManifest, RunAgentResult } from "../agent/runner";

export type TaskFailurePolicy = "blocker" | "warning" | "ignore";

export interface SubAgentTaskRequest {
  prompt: string;
  workspace?: string;
  max_turns?: number;
  skill_pack_overrides?: string[];
  token_budget?: { max_usd?: number; max_tokens?: number };
  treat_failure_as?: TaskFailurePolicy;
  model?: { provider: string; model: string };
}

export interface SubAgentTaskResult {
  ok: boolean;
  subRunId: string;
  verdict: "passed" | "failed";
  blockers: string[];
  changedFiles: string[];
  summary: string;
  tokensUsed: { in: number; out: number; reasoning?: number };
  childRunIds: string[];
  manifest: TanyaFinalManifest;
  runResult: RunAgentResult;
  treatFailureAs: TaskFailurePolicy;
  cancelled?: boolean;
  reason?: "budget" | "cycle_detected" | "depth";
}

export interface ToolContext {
  workspace: string;
  runId?: string;
  onProgress?: (event: ToolProgressEvent) => void | Promise<void>;
  signal?: AbortSignal;
  runSubAgent?: (request: SubAgentTaskRequest) => Promise<SubAgentTaskResult>;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  output?: unknown;
  error?: string;
  files?: string[];
  cancelled?: boolean;
  partial_output?: string;
}

export type ToolProgressEvent = {
  stream: "stdout" | "stderr";
  chunk: string;
  timestamp: string;
};

export interface TanyaTool {
  name: string;
  description: string;
  definition: ToolDefinition;
  preferredModel?: { provider: string; model: string; match?: "tool_call" | "verification" };
  truncateLargeResults?: boolean;
  keepFullForVerifier?: boolean;
  canRun?: (input: unknown, context: PermissionContext) => Promise<Decision>;
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
}

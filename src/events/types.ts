export type TanyaEvent = ( 
  | { type: "status"; message: string }
  | { type: "message_start"; elapsedMs?: number; headingStartedAt?: number }
  | { type: "message_delta"; text: string }
  | { type: "message_end" }
  | { type: "reasoning_chunk"; content: string; provider: string; model: string; runId: string; turn?: number; tokens?: number }
  | { type: "reasoning_truncated"; provider: string; model: string; usedTokens: number; capTokens: number; stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown" }
  | { type: "tool_call"; id: string; tool: string; input: unknown }
  | { type: "tool_progress"; toolCallId: string; chunk: string; timestamp: string; stream: "stdout" | "stderr" }
  | { type: "tool_cancel_requested"; toolCallId: string; tool?: string; timestamp: string }
  | { type: "tool_cancelled"; toolCallId: string; tool?: string; timestamp: string; partialOutput?: string }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      input: unknown;
      matchedRule?: string;
      projectedCostUsd?: number;
      projectedTokens?: number;
    }
  | {
      type: "permission_decision";
      id: string;
      decision: "allow" | "deny";
      source: "user" | "rule" | "engine" | "bypass";
      persistAs?: "always" | "never";
      matchedRule?: string;
      projectedCostUsd?: number;
      projectedTokens?: number;
      thresholdUsd?: number;
      thresholdTokens?: number;
    }
  | {
      type: "tool_result";
      id: string;
      tool: string;
      ok: boolean;
      summary: string;
      output?: unknown;
      error?: string;
      reason?: string;
      modelView?: unknown;
      verifierView?: unknown;
    }
  | {
      type: "tool_call_parse_warning";
      reason: string;
      provider?: string;
      turn?: number;
      attempt?: number;
      toolCallId?: string;
      tool?: string;
    }
  | {
      type: "schema_flatten_warning";
      reason: string;
      path: string;
      provider?: string;
      tool?: string;
    }
  | { type: "provider_throttle"; provider: string; attempt: number; waitMs: number }
  | {
      type: "model_routed";
      stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";
      provider: string;
      model: string;
      reason: string;
      cacheImpact?: "hit" | "miss" | "unknown";
    }
  | {
      type: "provider.raw";
      provider?: string;
      model?: string;
      event: Record<string, unknown>;
    }
  | {
      type: "escalation_event";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      reason: "parse_failure" | "schema_failure" | "context_too_small";
      stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";
    }
  | {
      type: "compact_event";
      compactType: "auto" | "micro" | "snip";
      removedTokens: number;
      summaryTokens?: number;
      aggression?: "normal" | "heavy";
    }
  | {
      type: "prompt_budget_exceeded";
      droppedSections: string[];
      totalTokens: number;
      cap: number;
    }
  | {
      type: "subtask_started";
      subRunId: string;
      parentRunId: string;
      prompt: string;
      workspace: string;
    }
  | {
      type: "subtask_completed";
      subRunId: string;
      parentRunId: string;
      verdict: "passed" | "failed";
      summary: string;
      tokensUsed: { in: number; out: number; reasoning?: number };
    }
  | { type: "command_invoked"; name: string; args: string[]; runId?: string }
  | { type: "subtask_start"; subtask_id: string; title: string; files: string[] }
  | { type: "subtask_done"; subtask_id: string; files_changed: string[]; summary: string; ok: boolean }
  | {
      type: "final";
      message: string;
      suppressHumanMessage?: boolean;
      files?: string[];
      manifest?: Record<string, unknown>;
      metrics?: {
        durationMs: number;
        toolCallCount: number;
        toolErrorCount: number;
        changedFileCount: number;
        repairAttemptCount?: number;
        retryAttemptCount?: number;
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        costUsd?: number;
        systemPromptTokens?: number;
        repoMapTokens?: number;
        toolResultTokens?: number;
      };
    }
  | { type: "error"; message: string; detail?: string }
) & { subRunId?: string };

export type EventSink = (event: TanyaEvent) => void | Promise<void>;

import { decide } from "../safety/permissions/engine";
import { runIdDepth } from "../agent/subAgentContext";
import { envValue } from "../config/envCompat";
import type { TanyaTool, SubAgentTaskRequest } from "./types";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function parseTaskInput(input: unknown): SubAgentTaskRequest {
  const record = asRecord(input);
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt) throw new Error("Missing string field: prompt");
  const workspace = typeof record.workspace === "string" && record.workspace.trim() ? record.workspace.trim() : undefined;
  const maxTurns = typeof record.max_turns === "number" && Number.isFinite(record.max_turns)
    ? Math.max(1, Math.floor(record.max_turns))
    : undefined;
  const skillPackOverrides = Array.isArray(record.skill_pack_overrides)
    ? record.skill_pack_overrides.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;
  const tokenBudget = asRecord(record.token_budget);
  const maxUsd = typeof tokenBudget.max_usd === "number" && Number.isFinite(tokenBudget.max_usd) ? tokenBudget.max_usd : undefined;
  const maxTokens = typeof tokenBudget.max_tokens === "number" && Number.isFinite(tokenBudget.max_tokens) ? tokenBudget.max_tokens : undefined;
  const modelRecord = asRecord(record.model);
  const model = typeof modelRecord.provider === "string" && modelRecord.provider.trim() &&
    typeof modelRecord.model === "string" && modelRecord.model.trim()
    ? { provider: modelRecord.provider.trim(), model: modelRecord.model.trim() }
    : undefined;
  const rawFailurePolicy = record.treat_failure_as;
  const treatFailureAs = rawFailurePolicy === "warning" || rawFailurePolicy === "ignore" || rawFailurePolicy === "blocker"
    ? rawFailurePolicy
    : undefined;

  return {
    prompt,
    ...(workspace ? { workspace } : {}),
    ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}),
    ...(skillPackOverrides && skillPackOverrides.length > 0 ? { skill_pack_overrides: skillPackOverrides } : {}),
    ...(maxUsd !== undefined || maxTokens !== undefined
      ? { token_budget: { ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}), ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}) } }
      : {}),
    ...(model ? { model } : {}),
    ...(treatFailureAs ? { treat_failure_as: treatFailureAs } : {}),
  };
}

function subtaskMaxDepth(): number {
  const raw = envValue(process.env, "TANYA_SUBTASK_MAX_DEPTH").trim();
  if (!raw) return 2;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2;
}

export const taskTool: TanyaTool = {
  name: "task",
  description: "Delegate a scoped prompt to a child Tanya agent and return its verifier-aware result.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "task",
      description: "Spawn a child Tanya agent with inherited context, permissions, and workspace scope.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt for the child agent." },
          workspace: { type: "string", description: "Optional subdirectory of the parent workspace." },
          max_turns: { type: "number", description: "Maximum child turns. Defaults to 20." },
          skill_pack_overrides: { type: "array", description: "Optional skill pack ids to override for the child." },
          token_budget: {
            type: "object",
            description: "Optional child token or USD budget cap.",
            properties: {
              max_usd: { type: "number" },
              max_tokens: { type: "number" },
            },
            additionalProperties: false,
          },
          model: {
            type: "object",
            description: "Optional provider/model pin for the whole child run.",
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
            },
            additionalProperties: false,
          },
          treat_failure_as: {
            type: "string",
            description: "How the parent should treat a failed child: blocker, warning, or ignore.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  async canRun(input, context) {
    if (runIdDepth(context.runId) >= subtaskMaxDepth()) {
      return { decision: "deny", reason: "subtask-depth-limit", matchedRule: "task:<depth>" };
    }
    return decide("task", input, context);
  },
  async run(input, context) {
    if (runIdDepth(context.runId ?? "") >= subtaskMaxDepth()) {
      return {
        ok: false,
        summary: "Subtask depth limit reached.",
        error: `Subtask recursion depth is capped at ${subtaskMaxDepth()}.`,
        output: { ok: false, error: "subtask-depth-limit" },
      };
    }
    if (!context.runSubAgent) {
      return {
        ok: false,
        summary: "Sub-agent runner is unavailable.",
        error: "task can only run inside an active Tanya agent loop.",
      };
    }
    const request = parseTaskInput(input);
    const result = await context.runSubAgent(request);
    return {
      ok: result.ok,
      summary: `${result.verdict === "passed" ? "Subtask passed" : "Subtask failed"} (${result.subRunId}).`,
      output: {
        ok: result.ok,
        subRunId: result.subRunId,
        verdict: result.verdict,
        blockers: result.blockers,
        changedFiles: result.changedFiles,
        summary: result.summary,
        tokensUsed: result.tokensUsed,
        childRunIds: result.childRunIds,
        treatFailureAs: result.treatFailureAs,
        ...(result.cancelled ? { cancelled: result.cancelled, reason: result.reason } : {}),
      },
      files: result.changedFiles,
      ...(result.ok ? {} : { error: result.blockers.join("; ") || "subtask failed" }),
    };
  },
};

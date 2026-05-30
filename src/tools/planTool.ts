import type { TanyaTool, ToolContext, ToolResult } from "./types";
import { normalizeLedger, remainingSteps, renderLedger, saveLedger } from "../agent/taskLedger";

// update_plan gives the agent a durable checklist for multi-step work. Pass the
// full step list each call (idempotent, like a to-do board). The plan is
// persisted to the workspace for the whole run so the model never loses track of
// what's done vs. left — the core defence against the "stopped mid-task and
// forgot where it was" failure.
export const updatePlanTool: TanyaTool = {
  name: "update_plan",
  description:
    "Create or update your task plan for a multi-step job. Pass the FULL list of steps each time, each with a status (pending|in_progress|done). The plan is persisted for the whole run so you never lose track of what's done and what's left. Use it for any build with more than ~3 steps; keep exactly one step in_progress at a time and mark steps done as you finish them.",
  definition: {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Create or update the persistent task plan/checklist. Pass the full list of steps with their status each call.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "The full ordered list of plan steps.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "What the step does." },
                status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Step status (default pending)." },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        },
        required: ["steps"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context: ToolContext): Promise<ToolResult> {
    const rawSteps = (input as { steps?: unknown })?.steps;
    if (!Array.isArray(rawSteps)) {
      return { ok: false, summary: "update_plan requires a 'steps' array.", error: "missing steps array" };
    }
    const ledger = normalizeLedger(rawSteps as Array<{ text?: unknown; status?: unknown }>);
    if (ledger.steps.length === 0) {
      return { ok: false, summary: "Plan must contain at least one step with non-empty text.", error: "empty plan" };
    }
    await saveLedger(context.workspace, ledger);
    const remaining = remainingSteps(ledger).length;
    return {
      ok: true,
      summary: `Plan updated: ${ledger.steps.length} step${ledger.steps.length === 1 ? "" : "s"}, ${remaining} remaining.`,
      output: { plan: renderLedger(ledger), total: ledger.steps.length, remaining },
    };
  },
};

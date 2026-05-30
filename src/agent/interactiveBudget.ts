import type { TanyaRunContext } from "../context/runContext";
import { phaseAwareMaxTurns } from "./phaseBudget";
import { definitionOfDoneInstruction, extractAcceptanceCriteria } from "./acceptanceCriteria";

export interface InferredInteractiveRun {
  runContext?: TanyaRunContext;
  maxTurns?: number;
}

// Interactive chat used to call runAgent with no runContext and no maxTurns, so
// every build typed into the chat ran the bare 12-turn budget (runner default)
// AND skipped the coding keep-alive/repair logic (isCodingTask was false). The
// CLI `run` path never had this problem because it builds a runContext and a
// phase-aware budget. This infers the same for freeform chat prompts that are
// clearly asking for code/app work, so a "build an iOS calculator" in the chat
// gets the real budget and the verification gate, not the 12-turn floor.

const CODING_INTENT = [
  // action verb + code-ish object
  /\b(?:build|create|make|implement|write|code|scaffold|generate|add|fix|refactor|debug|wire|integrate|port|migrate|set\s*up)\b[\s\S]{0,40}\b(?:app|application|project|component|screen|endpoint|api|function|class|module|script|cli|backend|frontend|website|game|bot)\b/i,
  // explicit "from scratch" framing
  /\bfrom\s+scratch\b/i,
  // platform/stack mentions that are unambiguously technical (bare words that
  // double as common English — swift, express, flutter — are deliberately
  // excluded to avoid "Taylor Swift" / "express my thanks" false positives).
  /\b(?:xcode|xcodebuild|swiftui|jetpack\s*compose|react\s*native|next\.?js|fastapi|django|gradle)\b/i,
];

export function looksLikeInteractiveCoding(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length < 3) return false;
  return CODING_INTENT.some((pattern) => pattern.test(text));
}

function promptTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

export function inferInteractiveRun(prompt: string): InferredInteractiveRun {
  if (!looksLikeInteractiveCoding(prompt)) return {};
  // Compute the budget from the task + prompt ONLY — before injecting the
  // definition-of-done instructions, whose text ("verify ... ") would otherwise
  // pollute the phase keyword match and downgrade the budget.
  const taskContext: TanyaRunContext = { task: { kind: "coding", title: promptTitle(prompt) } };
  const maxTurns = phaseAwareMaxTurns(taskContext, prompt);
  const definitionOfDone = definitionOfDoneInstruction(extractAcceptanceCriteria(prompt));
  const runContext: TanyaRunContext = {
    ...taskContext,
    ...(definitionOfDone ? { instructions: [definitionOfDone] } : {}),
  };
  return { runContext, ...(maxTurns !== undefined ? { maxTurns } : {}) };
}

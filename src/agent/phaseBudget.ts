import type { TanyaRunContext } from "../context/runContext";

function boundedTurnBudget(value: number): number {
  return Math.max(1, Math.min(300, Math.floor(value)));
}

export function phaseAwareMaxTurns(runContext: TanyaRunContext | undefined, prompt: string, override?: number): number | undefined {
  if (override !== undefined) return boundedTurnBudget(override);
  const text = [
    runContext?.task?.title,
    runContext?.task?.summary,
    ...(runContext?.instructions ?? []),
    prompt,
  ].filter(Boolean).join("\n").toLowerCase();
  const isCoding = runContext?.task?.kind === "coding" ||
    /\b(?:coding|go-backend-|initialize\s+go\s+backend|backend\s+step|pre-seeded tasks)\b/.test(text);
  if (!isCoding) return undefined;
  if (/\b(?:foundation|go-backend-foundation)\b/.test(text)) {
    return 300;
  }
  if (/\b(?:setup|auth|initialize\s+go\s+backend|go-backend-(?:init|auth))\b/.test(text)) {
    return 200;
  }
  if (/\b(?:testing|verify|verification|go-backend-verify)\b/.test(text)) {
    return 50;
  }
  if (/\b(?:feature|addon|add-on|go-backend-(?:feature|addon))\b/.test(text)) {
    return 100;
  }
  return 100;
}

// "It compiled" is not "it works". The calculator built and launched but every
// digit button rendered "\(n)" and the operations did nothing — a pure
// behavioural failure that a build check can never catch. This derives the
// observable, checkable expectations implied by the prompt so the agent gets an
// explicit definition-of-done to verify against (and so a future behavioural/
// visual verifier has criteria to check the running app against).

export interface AcceptanceCriterion {
  id: string;
  text: string;
}

export function extractAcceptanceCriteria(prompt: string): AcceptanceCriterion[] {
  const text = prompt.toLowerCase();
  const criteria: AcceptanceCriterion[] = [];
  const add = (id: string, t: string) => {
    if (!criteria.some((c) => c.id === id)) criteria.push({ id, text: t });
  };

  // Baseline for anything app/UI shaped.
  add("builds-and-launches", "The app builds without errors and launches/opens without crashing.");

  if (/\bcalculator\b/.test(text)) {
    add("digits-render", "Every digit button (0-9) displays its actual number — not source/interpolation text like \\(n).");
    add("operations-work", "The operations (+ - × ÷ =) compute correctly and the display updates as you tap.");
  }
  if (/\b(?:login|log[\s-]?in|sign[\s-]?in|sign[\s-]?up|auth(?:entication)?)\b/.test(text)) {
    add("auth-flow", "The auth screen shows the credential fields and the submit action actually authenticates (no stub).");
  }
  if (/\b(?:list|feed|todo|to-do|tasks?|crud|items?)\b/.test(text)) {
    add("list-and-mutations", "The list renders its items and add/edit/remove visibly updates the view.");
  }
  if (/\bform\b/.test(text)) {
    add("form-validates", "The form accepts input, validates it, and the submit path does something observable.");
  }
  if (/\b(?:fetch|api|network|load|request)\b/.test(text)) {
    add("data-loads", "Data actually loads from its source and the UI reflects loading/empty/error states.");
  }

  return criteria;
}

// A single instruction string suitable for runContext.instructions, surfaced to
// the model as a "Caller instruction". Returns null when there's nothing useful
// to add.
export function definitionOfDoneInstruction(criteria: AcceptanceCriterion[]): string | null {
  if (criteria.length === 0) return null;
  const lines = criteria.map((c) => `(${c.id}) ${c.text}`);
  return [
    "Definition of done — before reporting complete, verify each of these against the RUNNING app, not just that it compiles:",
    ...lines.map((l) => `  • ${l}`),
  ].join("\n");
}

import type { EvalSuite, EvalTask } from "../schemas";

const prompts = [
  "Create a sanitized mobile onboarding screen and verify the asset manifest.",
  "Patch a backend route contract and keep the generated client shape stable.",
  "Update app icon metadata without touching local signing configuration.",
  "Repair a failing dependency install by using the existing package manager.",
  "Confirm a no-op when the requested feature is already present.",
  "Add a parameterized content card to a sanitized educational app fixture.",
  "Fix a database migration fixture and report the verification command.",
  "Update a push-notification settings fixture with no secret leakage.",
  "Repair a failed Android Gradle probe by using direct verification.",
  "Summarize untouched files after a read-only inspection task.",
];

export function cosmohqSuite(): EvalSuite {
  const tasks: EvalTask[] = prompts.map((prompt, index) => ({
    id: `cosmohq-${String(index + 1).padStart(2, "0")}`,
    repo_setup: { type: "local_fixture", path: `builtin:cosmohq/${index + 1}` },
    prompt,
    expected_files: index === 4 || index === 9 ? [] : [`app/fixture-${index + 1}.ts`],
    metadata: { sanitized: true, source: index % 2 === 0 ? "mobile-app-creator" : "backend-app-creator" },
  }));
  return { name: "cosmohq", version: "2026-05-sanitized", tasks };
}

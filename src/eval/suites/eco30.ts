import type { EvalSuite, EvalTask } from "../schemas";

const categories = [
  "long-file-read-dedup",
  "large-tool-result-truncation",
  "reasoning-heavy-planning",
  "system-prompt-budget",
  "repo-map-targeting",
  "fuzzy-edit-recovery",
] as const;

function ecoTask(index: number): EvalTask {
  const category = categories[index % categories.length] ?? "long-file-read-dedup";
  return {
    id: `eco-${String(index + 1).padStart(2, "0")}-${category}`,
    repo_setup: { type: "local_fixture", path: `builtin:eco-30/${category}` },
    prompt: ecoPrompt(category),
    expected_files: category === "long-file-read-dedup" ? [] : [`src/eco-${index + 1}.ts`],
    metadata: {
      category,
      providerTier: "cheap",
      measures: ["input_tokens", "output_tokens", "reasoning_tokens", "system_prompt_tokens", "cost_usd"],
    },
  };
}

export function eco30Suite(): EvalSuite {
  return {
    name: "eco-30",
    version: "2026-05",
    tasks: Array.from({ length: 30 }, (_, index) => ecoTask(index)),
  };
}

function ecoPrompt(category: string): string {
  switch (category) {
    case "long-file-read-dedup":
      return "Inspect a repeated long file read pattern and avoid resending unchanged content.";
    case "large-tool-result-truncation":
      return "Run a large-output verification command and use expand_result only for necessary ranges.";
    case "reasoning-heavy-planning":
      return "Plan a multi-file repair while staying within the reasoning token cap.";
    case "system-prompt-budget":
      return "Complete a small task under a tight system-prompt budget.";
    case "repo-map-targeting":
      return "Use structural context to identify the right file before reading broadly.";
    case "fuzzy-edit-recovery":
      return "Recover a near-match edit block without rewriting the entire file.";
    default:
      return "Complete the token-economy fixture.";
  }
}

import type { EvalSuite, EvalTask } from "../schemas";

const categories = [
  ["long-bash", "Repair a long shell verification command and report the exact failing line."],
  ["multi-file-edit", "Update two related TypeScript modules and keep their exports consistent."],
  ["broken-patch", "Recover from a patch that does not apply cleanly by re-reading the file."],
  ["dependency-install", "Add a tiny dependency and update the lockfile without unrelated churn."],
  ["noop-confirmation", "Inspect the repo and confirm no code change is needed."],
] as const;

function nativeTask(index: number): EvalTask {
  const [category, prompt] = categories[index % categories.length] ?? categories[0];
  return {
    id: `native-${String(index + 1).padStart(2, "0")}-${category}`,
    repo_setup: { type: "local_fixture", path: `builtin:tanya-native/${category}` },
    prompt,
    expected_files: category === "noop-confirmation" ? [] : [`src/task-${index + 1}.ts`],
    metadata: { category, expectedVerdict: index % 7 === 0 ? "failed" : "passed" },
  };
}

export function tanyaNativeSuite(): EvalSuite {
  return {
    name: "tanya-native",
    version: "2026-05",
    tasks: Array.from({ length: 25 }, (_, index) => nativeTask(index)),
  };
}

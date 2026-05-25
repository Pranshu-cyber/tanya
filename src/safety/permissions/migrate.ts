import { readRunLogs } from "../../memory/runLogs";
import type { PermissionRulesConfig } from "./schema";

export const BUILT_IN_ALWAYS_ALLOW_SEED = [
  "read_file:.*",
  "glob:.*",
  "list_files:.*",
  "run_shell:ls.*",
  "run_shell:git status.*",
  "run_shell:git diff.*",
];

export function suggestPermissionsFromRuns(workspace: string, limit = 100): PermissionRulesConfig {
  const counts = new Map<string, number>();
  for (const log of readRunLogs(workspace, limit)) {
    for (const file of log.changedFiles) {
      if (!file || file.startsWith(".tanya/") || file.startsWith(".tanya/")) continue;
      const escaped = escapeRegex(JSON.stringify(file));
      counts.set(`write_file:.*${escaped}.*`, (counts.get(`write_file:.*${escaped}.*`) ?? 0) + 1);
    }
    if (log.blockers.length === 0) {
      counts.set("run_command:.*node.*", (counts.get("run_command:.*node.*") ?? 0) + 1);
    }
  }

  const frequent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([pattern]) => pattern);

  return {
    version: 1,
    mode: "ask",
    alwaysAllow: unique([...BUILT_IN_ALWAYS_ALLOW_SEED, ...frequent]),
    alwaysDeny: [],
    alwaysAsk: [],
    pathRules: [],
    spendRules: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

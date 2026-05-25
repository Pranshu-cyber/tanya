#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const seed = [
  "read_file:.*",
  "glob:.*",
  "list_files:.*",
  "run_shell:ls.*",
  "run_shell:git status.*",
  "run_shell:git diff.*",
];

const cwdFlag = process.argv.indexOf("--cwd");
const limitFlag = process.argv.indexOf("--limit");
const workspace = resolve(cwdFlag >= 0 && process.argv[cwdFlag + 1] ? process.argv[cwdFlag + 1] : process.cwd());
const limit = limitFlag >= 0 && process.argv[limitFlag + 1] ? Number(process.argv[limitFlag + 1]) : 100;
const runsDir = join(workspace, ".tanya", "runs");
const counts = new Map();

if (existsSync(runsDir)) {
  for (const file of readdirSync(runsDir).filter((name) => name.endsWith(".json")).sort().reverse().slice(0, Number.isFinite(limit) ? limit : 100)) {
    try {
      const log = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
      for (const changed of Array.isArray(log.changedFiles) ? log.changedFiles : []) {
        if (typeof changed !== "string" || changed.startsWith(".tanya/") || changed.startsWith(".tanya/")) continue;
        const pattern = `write_file:.*${escapeRegex(JSON.stringify(changed))}.*`;
        counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
      }
      if (Array.isArray(log.blockers) && log.blockers.length === 0) {
        counts.set("run_command:.*node.*", (counts.get("run_command:.*node.*") ?? 0) + 1);
      }
    } catch {
      // Ignore malformed historical run files.
    }
  }
}

const frequent = [...counts.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 25)
  .map(([pattern]) => pattern);

process.stdout.write(`${JSON.stringify({
  version: 1,
  mode: "ask",
  alwaysAllow: [...new Set([...seed, ...frequent])],
  alwaysDeny: [],
  alwaysAsk: [],
  pathRules: [],
  spendRules: [],
}, null, 2)}\n`);

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

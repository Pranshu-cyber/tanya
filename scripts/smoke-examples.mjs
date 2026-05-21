import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const exampleReadmes = [
  "examples/01-hello-world/README.md",
  "examples/02-custom-provider/README.md",
  "examples/03-skill-pack/README.md",
  "examples/04-cosmochat-integration/README.md",
];

for (const relativePath of exampleReadmes) {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`Missing example README: ${relativePath}`);
  const content = readFileSync(absolutePath, "utf8");
  if (!content.includes("## Prerequisites")) throw new Error(`Missing prerequisites section: ${relativePath}`);
  if (!content.includes("## Run")) throw new Error(`Missing run section: ${relativePath}`);
  if (!/```bash[\s\S]+?```/.test(content)) throw new Error(`Missing bash command block: ${relativePath}`);
}

const topLevelHelp = execFileSync(process.execPath, ["dist/cli.js", "--help"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (!topLevelHelp.includes("ask") || !topLevelHelp.includes("run")) {
  throw new Error("CLI help no longer exposes ask/run commands used by examples.");
}

const runHelp = execFileSync(process.execPath, ["dist/cli.js", "run", "--help"], {
  cwd: repoRoot,
  encoding: "utf8",
});
for (const flag of ["--json", "--context-file", "--prompt-file"]) {
  if (!runHelp.includes(flag)) throw new Error(`CLI help no longer exposes ${flag}.`);
}

const skillPackOutput = execFileSync("npx", ["tsx", "examples/03-skill-pack/check.ts"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (!skillPackOutput.includes("framework/example")) {
  throw new Error("Skill-pack example did not load framework/example.");
}

console.log("Example smoke checks passed.");

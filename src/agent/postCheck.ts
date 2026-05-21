import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TanyaFinalManifest } from "./runner";

const POST_CHECK_TIMEOUT_MS = 25_000;

function hasPassingVerification(manifest: TanyaFinalManifest, pattern: RegExp): boolean {
  return manifest.verification.some(
    (line) => /->\s*passed\b/i.test(line) && pattern.test(line),
  );
}

function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function readPackageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const packageManager = parsed.packageManager?.split("@")[0];
    if (packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun") return packageManager;
  } catch {
    // fall through to lockfile detection
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function packageScriptCommand(
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  script: string,
): { cmd: string; args: string[] } {
  if (packageManager === "yarn") return { cmd: "yarn", args: [script] };
  return { cmd: packageManager, args: ["run", script] };
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { exitCode: number; output: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: false,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const exitCode = result.status ?? (result.error ? 1 : 0);
  return { exitCode, output };
}

function parseTypeScriptErrors(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => /\.tsx?:\d+:\d+\s*-?\s*error\s+TS\d+:/i.test(line) || /error TS\d+:/i.test(line))
    .slice(0, 5);
}

export async function detectPostRunBlockers(
  cwd: string,
  manifest: TanyaFinalManifest,
): Promise<string[]> {
  const blockers: string[] = [];
  const tsconfigExists =
    existsSync(join(cwd, "tsconfig.json")) || existsSync(join(cwd, "tsconfig.base.json"));
  const scripts = readPackageScripts(cwd);
  const packageManager = readPackageManager(cwd);

  if (tsconfigExists && !hasPassingVerification(manifest, /tsc|typecheck|type-check/i)) {
    const typecheckCommand = scripts.typecheck
      ? packageScriptCommand(packageManager, "typecheck")
      : { cmd: "npx", args: ["tsc", "--noEmit", "--pretty", "false"] };
    const { exitCode, output } = runCommand(typecheckCommand.cmd, typecheckCommand.args, cwd, POST_CHECK_TIMEOUT_MS);
    if (exitCode !== 0) {
      const errorLines = parseTypeScriptErrors(output);
      const summary = errorLines.length > 0
        ? `TypeScript errors after run:\n${errorLines.map((line) => `  ${line}`).join("\n")}`
        : "TypeScript compilation failed (post-run check)";
      blockers.push(summary);
    }
  }

  if (scripts.test && !hasPassingVerification(manifest, /\btest\b/i)) {
    const testCommand = packageScriptCommand(packageManager, "test");
    const { exitCode } = runCommand(testCommand.cmd, testCommand.args, cwd, POST_CHECK_TIMEOUT_MS);
    if (exitCode !== 0) {
      blockers.push("Tests failed after run (post-run check)");
    }
  }

  return blockers;
}

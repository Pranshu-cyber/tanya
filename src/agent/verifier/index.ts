import { existsSync, readFileSync } from "node:fs";
import type { TanyaRunContext } from "../../context/runContext";
import { noopShell, realShell } from "./shell";
import { builtinVerifiers } from "./registry";

function defaultShell() {
  if (process.env.VITEST === "true" || process.env.TANYA_VERIFIER_SHELL === "noop") {
    return noopShell;
  }
  return realShell;
}
import type {
  FinalStateVerification,
  Verifier,
  VerifierCheck,
  VerifierContext,
  VerifierShell,
} from "./types";

export type { FinalStateVerification, Verifier, VerifierCheck, VerifierShell } from "./types";

export type VerifyFinalStateOptions = {
  workspace: string;
  prompt?: string | undefined;
  runContext?: TanyaRunContext | undefined;
  shell?: VerifierShell | undefined;
  verifiers?: Verifier[] | undefined;
};

function buildContext(options: VerifyFinalStateOptions): VerifierContext {
  return {
    workspace: options.workspace,
    runContext: options.runContext,
    prompt: options.prompt ?? "",
    shell: options.shell ?? defaultShell(),
    fileExists: (path: string) => existsSync(path),
    readText: (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}

function uniquePlatforms<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export async function verifyFinalState(options: VerifyFinalStateOptions): Promise<FinalStateVerification> {
  const ctx = buildContext(options);
  const candidates = options.verifiers ?? builtinVerifiers;
  const applicable: Verifier[] = [];
  for (const verifier of candidates) {
    if (await verifier.appliesTo(ctx)) applicable.push(verifier);
  }

  const ranPlatforms = uniquePlatforms(applicable.map((verifier) => verifier.platform));
  const checks: VerifierCheck[] = [];
  for (const verifier of applicable) {
    try {
      const verifierChecks = await verifier.run(ctx);
      checks.push(...verifierChecks);
    } catch (err) {
      checks.push({
        id: `${verifier.id}-crash`,
        description: `${verifier.id} verifier crashed`,
        passed: false,
        authoritative: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const authoritativeChecks = checks.filter((check) => check.authoritative);
  const authoritativePassed = authoritativeChecks.length > 0 && authoritativeChecks.every((check) => check.passed);

  const formatFailedCheck = (check: VerifierCheck) =>
    `final-state check failed: ${check.description}${check.error ? ` (${check.error})` : ""}`;

  const newBlockers = checks
    .filter((check) => !check.passed && check.authoritative === true)
    .map(formatFailedCheck);

  const warnings = checks
    .filter((check) => !check.passed && check.authoritative !== true)
    .map((check) => `final-state check failed: ${check.description}${check.error ? ` (${check.error})` : ""}`);

  // Recovered failure commands are advisory: callers use them to mark soft probe failures.
  // We don't enumerate concrete commands here; the runner's existing recovery heuristics
  // already handle that classification. Returning the list lets future callers/tests
  // add finer-grained matching if needed.
  const recoveredFailureCommands: string[] = [];

  return {
    ranVerifiers: ranPlatforms,
    checks,
    authoritativePassed,
    newBlockers,
    warnings,
    recoveredFailureCommands,
  };
}

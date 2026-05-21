import type { EvalTask } from "./schemas";
import { runMvpVerifier, type MvpVerifierOutcome } from "./mvpVerifier";

export type VerifierExtensionOutcome = MvpVerifierOutcome;

export async function runVerifierExtension(task: EvalTask, workspace: string, repoRoot: string): Promise<VerifierExtensionOutcome | null> {
  if (!task.verifier_extension) return null;
  if (task.verifier_extension.includes("/mvp-fixtures/")) {
    return runMvpVerifier(task.id, workspace, repoRoot);
  }
  return null;
}

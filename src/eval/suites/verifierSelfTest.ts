import type { EvalSuite, EvalTask } from "../schemas";

export function verifierSelfTestSuite(): EvalSuite {
  const tasks: EvalTask[] = [
    verifierTask("verifier-self-01-correct-report", "passed", "Known-correct output includes changed files and passing verification."),
    verifierTask("verifier-self-02-missing-verification", "failed", "Known-incorrect output omits required verification evidence."),
    verifierTask("verifier-self-03-failed-test", "failed", "Known-incorrect output includes a failing test command."),
    verifierTask("verifier-self-04-noop-clean", "passed", "Known-correct no-op report has no changed files and no blockers."),
  ];
  return { name: "verifier-self-test", version: "2026-05", tasks };
}

function verifierTask(id: string, expectedVerdict: "passed" | "failed", prompt: string): EvalTask {
  return {
    id,
    repo_setup: { type: "local_fixture", path: `builtin:verifier-self-test/${id}` },
    prompt,
    metadata: {
      expectedVerifierVerdict: expectedVerdict,
      purpose: "assert verifier classification, not model output",
    },
  };
}

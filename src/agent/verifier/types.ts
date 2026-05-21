export type ChildFailureDisposition = "blocker" | "warning" | "ignore";

export type ChildVerdict = {
  subRunId: string;
  verdict: "passed" | "failed";
  blockers: string[];
  summary: string;
  changedFiles: string[];
  treatFailureAs: ChildFailureDisposition;
};

export type ReasoningAnnotation = {
  runId: string;
  turn?: number;
  provider: string;
  model: string;
  blocker?: string;
  excerpt: string;
  confidence: "advisory";
};

// ──────────────────────────────────────────────────────────
// Final-state verifier types (salvaged from F-fix.5+8 WIP)
// ──────────────────────────────────────────────────────────

import type { TanyaRunContext } from "../../context/runContext";

export type VerifierShellResult = {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  binaryMissing?: boolean;
};

export type VerifierShell = (
  cwd: string,
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<VerifierShellResult>;

export type VerifierCheck = {
  id: string;
  description: string;
  passed: boolean;
  authoritative: boolean;
  skipped?: boolean;
  evidence?: string;
  error?: string;
};

export function makeCheck(input: {
  id: string;
  description: string;
  passed: boolean;
  authoritative: boolean;
  skipped?: boolean | undefined;
  evidence?: string | undefined;
  error?: string | undefined;
}): VerifierCheck {
  const check: VerifierCheck = {
    id: input.id,
    description: input.description,
    passed: input.passed,
    authoritative: input.authoritative,
  };
  if (input.skipped !== undefined) check.skipped = input.skipped;
  if (input.evidence !== undefined) check.evidence = input.evidence;
  if (input.error !== undefined) check.error = input.error;
  return check;
}

export type VerifierPlatform =
  | "go-backend"
  | "node-backend"
  | "frontend"
  | "ios"
  | "android"
  | "generic";

export type VerifierContext = {
  workspace: string;
  runContext?: TanyaRunContext | undefined;
  prompt: string;
  shell: VerifierShell;
  fileExists: (path: string) => boolean;
  readText: (path: string) => string | null;
};

export type Verifier = {
  id: string;
  platform: VerifierPlatform;
  appliesTo(ctx: VerifierContext): boolean | Promise<boolean>;
  run(ctx: VerifierContext): Promise<VerifierCheck[]>;
};

export type FinalStateVerification = {
  ranVerifiers: VerifierPlatform[];
  checks: VerifierCheck[];
  authoritativePassed: boolean;
  newBlockers: string[];
  warnings: string[];
  recoveredFailureCommands: string[];
};

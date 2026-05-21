import { estimateRunCost } from "../../memory/runLogs";
import type { EvalSuite } from "../schemas";
import { eco30Suite } from "./eco30";
import { mvpSuite } from "./mvp";
import { sweBenchLiteSuite } from "./sweBenchLite";
import { tanyaNativeSuite } from "./tanya-native";
import { verifierSelfTestSuite } from "./verifierSelfTest";
import { loadIntegrationEvalSuites } from "./integrations";

export type EvalSuiteName = "swe-bench-lite" | "tanya-native" | "eco-30" | "mvp" | "verifier-self-test";

const suiteLoaders: Record<EvalSuiteName, () => EvalSuite> = {
  "swe-bench-lite": sweBenchLiteSuite,
  "tanya-native": tanyaNativeSuite,
  "eco-30": eco30Suite,
  mvp: mvpSuite,
  "verifier-self-test": verifierSelfTestSuite,
};

export type EvalDryRun = {
  suite: string;
  suiteVersion: string;
  taskCount: number;
  estimatedCostUsd: number | null;
  model: string;
};

function builtInSuiteNames(): EvalSuiteName[] {
  return Object.keys(suiteLoaders) as EvalSuiteName[];
}

export function listEvalSuites(): string[] {
  const names = new Set<string>(builtInSuiteNames());
  for (const suite of loadIntegrationEvalSuites()) {
    if (!names.has(suite.name)) names.add(suite.name);
  }
  return [...names];
}

export function loadEvalSuite(name: string): EvalSuite {
  const loader = suiteLoaders[name as EvalSuiteName];
  if (loader) return loader();

  const suite = loadIntegrationEvalSuites().find((candidate) => candidate.name === name);
  if (suite) return suite;

  throw new Error(`Unknown eval suite "${name}". Available: ${listEvalSuites().join(", ")}`);
}

export function dryRunEvalSuite(suite: EvalSuite, provider: string | undefined, model: string): EvalDryRun {
  const estimatedPromptTokens = suite.tasks.length * 14_000;
  const estimatedCompletionTokens = suite.tasks.length * 3_000;
  const estimate = estimateRunCost({
    ...(provider ? { provider } : {}),
    model,
    promptTokens: estimatedPromptTokens,
    completionTokens: estimatedCompletionTokens,
  });
  return {
    suite: suite.name,
    suiteVersion: suite.version,
    taskCount: suite.tasks.length,
    estimatedCostUsd: estimate.usd,
    model,
  };
}

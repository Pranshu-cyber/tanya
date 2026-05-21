import { readFileSync } from "node:fs";
import { discoverIntegrationEntries } from "../../integrations/discovery";
import type { EvalSuite, EvalTask } from "../schemas";
import { formatEvalSchemaIssues, validateEvalSuite } from "../schemas";

export type IntegrationSuiteFile = {
  name: string;
  version: string;
  tasks: EvalTask[];
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseIntegrationSuite(path: string): EvalSuite | null {
  const parsed = readJson(path);
  const result = validateEvalSuite(parsed);
  if (result.ok) return result.data;
  console.warn(`[eval] Skipping integration suite ${path}: ${formatEvalSchemaIssues(result.issues)}`);
  return null;
}

export function loadIntegrationEvalSuites(): EvalSuite[] {
  return discoverIntegrationEntries("suites")
    .filter((entry) => entry.path.toLowerCase().endsWith(".json"))
    .map((entry) => parseIntegrationSuite(entry.path))
    .filter((suite): suite is EvalSuite => suite !== null);
}

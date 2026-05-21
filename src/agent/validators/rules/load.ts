import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverIntegrationEntries } from "../../../integrations/discovery";
import { builtInValidatorRuleFiles } from "./index";
import type {
  BackendSetupEnvironmentRule,
  DocumentationRequirement,
  PlaceholderRequirement,
  RequiredEnvValueRule,
  ValidatorRule,
  ValidatorRuleFile,
  ValidatorRuleIssue,
  ValidatorRulePattern,
  ValidatorRulePatternIssue,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function pattern(value: unknown): ValidatorRulePattern | undefined {
  if (!isRecord(value) || typeof value.pattern !== "string" || value.pattern.trim().length === 0) return undefined;
  return {
    pattern: value.pattern,
    ...(typeof value.flags === "string" ? { flags: value.flags } : {}),
  };
}

function patterns(value: unknown): ValidatorRulePattern[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(pattern).filter((item): item is ValidatorRulePattern => Boolean(item));
  return values.length > 0 ? values : undefined;
}

function severity(value: unknown): "error" | "warning" | undefined {
  return value === "error" || value === "warning" ? value : undefined;
}

function issue(value: unknown): ValidatorRuleIssue | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.message !== "string") return undefined;
  const parsedSeverity = severity(value.severity);
  if (!parsedSeverity) return undefined;
  const parsed: ValidatorRuleIssue = {
    id: value.id,
    severity: parsedSeverity,
    message: value.message,
  };
  const files = stringArray(value.files);
  if (files) parsed.files = files;
  return parsed;
}

function patternIssue(value: unknown): ValidatorRulePatternIssue | undefined {
  const parsedPattern = pattern(value);
  const parsedIssue = issue(value);
  return parsedPattern && parsedIssue ? { ...parsedPattern, ...parsedIssue } : undefined;
}

function placeholderRequirement(value: unknown): PlaceholderRequirement | undefined {
  if (!isRecord(value)) return undefined;
  const unclearIssue = issue(value.unclearIssue);
  if (!unclearIssue) return undefined;
  const parsed: PlaceholderRequirement = {
    unclearIssue,
  };
  if (typeof value.acceptedExplicitPlaceholder === "boolean") parsed.acceptedExplicitPlaceholder = value.acceptedExplicitPlaceholder;
  const allowedPatterns = patterns(value.allowedPatterns);
  if (allowedPatterns) parsed.allowedPatterns = allowedPatterns;
  return parsed;
}

function requiredEnvValueRule(value: unknown): RequiredEnvValueRule | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) return undefined;
  const missingIssue = issue(value.missingIssue);
  if (!missingIssue) return undefined;
  const forbiddenValues = Array.isArray(value.forbiddenValues)
    ? value.forbiddenValues.map(patternIssue).filter((item): item is ValidatorRulePatternIssue => Boolean(item))
    : undefined;
  const parsed: RequiredEnvValueRule = {
    name: value.name,
    missingIssue,
  };
  if (forbiddenValues && forbiddenValues.length > 0) parsed.forbiddenValues = forbiddenValues;
  const placeholder = placeholderRequirement(value.placeholder);
  if (placeholder) parsed.placeholder = placeholder;
  return parsed;
}

function documentationRequirement(value: unknown): DocumentationRequirement | undefined {
  if (!isRecord(value)) return undefined;
  const parsedIssue = issue(value.issue);
  if (!parsedIssue) return undefined;
  const parsed: DocumentationRequirement = {
    issue: parsedIssue,
  };
  const all = patterns(value.all);
  if (all) parsed.all = all;
  const any = patterns(value.any);
  if (any) parsed.any = any;
  return parsed;
}

function backendSetupEnvironmentRule(value: unknown): BackendSetupEnvironmentRule | undefined {
  if (!isRecord(value) || value.kind !== "backend_setup_environment" || typeof value.id !== "string") return undefined;
  const requiredEnv = Array.isArray(value.requiredEnv)
    ? value.requiredEnv.map(requiredEnvValueRule).filter((item): item is RequiredEnvValueRule => Boolean(item))
    : undefined;
  const documentation = Array.isArray(value.documentation)
    ? value.documentation.map(documentationRequirement).filter((item): item is DocumentationRequirement => Boolean(item))
    : undefined;
  const parsed: BackendSetupEnvironmentRule = {
    kind: "backend_setup_environment",
    id: value.id,
  };
  if (typeof value.envFile === "string") parsed.envFile = value.envFile;
  const docsFiles = stringArray(value.docsFiles);
  if (docsFiles) parsed.docsFiles = docsFiles;
  if (requiredEnv && requiredEnv.length > 0) parsed.requiredEnv = requiredEnv;
  if (documentation && documentation.length > 0) parsed.documentation = documentation;
  return parsed;
}

function validatorRule(value: unknown): ValidatorRule | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "backend_setup_environment") return backendSetupEnvironmentRule(value);
  return undefined;
}

function validatorRuleFile(value: unknown): ValidatorRuleFile | undefined {
  if (!isRecord(value) || !Array.isArray(value.rules)) return undefined;
  const rules = value.rules.map(validatorRule).filter((item): item is ValidatorRule => Boolean(item));
  return { version: 1, rules };
}

function safeStat(path: string): { isFile(): boolean; isDirectory(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function jsonFiles(path: string): string[] {
  const stat = safeStat(path);
  if (!stat) return [];
  if (stat.isFile()) return path.endsWith(".json") ? [path] : [];
  if (!stat.isDirectory()) return [];

  try {
    return readdirSync(path, { withFileTypes: true })
      .flatMap((entry) => jsonFiles(join(path, entry.name)))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function readRuleFile(path: string): ValidatorRuleFile | undefined {
  try {
    return validatorRuleFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

function discoveredValidatorRuleFiles(): ValidatorRuleFile[] {
  return discoverIntegrationEntries("validators")
    .flatMap((entry) => jsonFiles(entry.path))
    .map(readRuleFile)
    .filter((file): file is ValidatorRuleFile => Boolean(file));
}

export function loadValidatorRules(): ValidatorRule[] {
  return [...builtInValidatorRuleFiles, ...discoveredValidatorRuleFiles()]
    .flatMap((file) => file.rules);
}

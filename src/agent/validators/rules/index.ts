import { cosmohqValidatorRuleFile } from "./cosmohq";
import type { ValidatorRuleFile } from "./types";

export const builtInValidatorRuleFiles: ValidatorRuleFile[] = [
  cosmohqValidatorRuleFile,
];

export type {
  BackendSetupEnvironmentRule,
  DocumentationRequirement,
  PlaceholderRequirement,
  RequiredEnvValueRule,
  ValidatorRule,
  ValidatorRuleFile,
  ValidatorRuleIssue,
  ValidatorRulePattern,
  ValidatorRulePatternIssue,
  ValidatorRuleSeverity,
} from "./types";

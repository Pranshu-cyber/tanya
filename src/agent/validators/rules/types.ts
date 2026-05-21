export type ValidatorRuleSeverity = "error" | "warning";

export type ValidatorRulePattern = {
  pattern: string;
  flags?: string;
};

export type ValidatorRuleIssue = {
  id: string;
  severity: ValidatorRuleSeverity;
  message: string;
  files?: string[];
};

export type ValidatorRulePatternIssue = ValidatorRulePattern & ValidatorRuleIssue;

export type PlaceholderRequirement = {
  acceptedExplicitPlaceholder?: boolean;
  allowedPatterns?: ValidatorRulePattern[];
  unclearIssue: ValidatorRuleIssue;
};

export type RequiredEnvValueRule = {
  name: string;
  missingIssue: ValidatorRuleIssue;
  forbiddenValues?: ValidatorRulePatternIssue[];
  placeholder?: PlaceholderRequirement;
};

export type DocumentationRequirement = {
  all?: ValidatorRulePattern[];
  any?: ValidatorRulePattern[];
  issue: ValidatorRuleIssue;
};

export type BackendSetupEnvironmentRule = {
  kind: "backend_setup_environment";
  id: string;
  envFile?: string;
  docsFiles?: string[];
  requiredEnv?: RequiredEnvValueRule[];
  documentation?: DocumentationRequirement[];
};

export type ValidatorRule = BackendSetupEnvironmentRule;

export type ValidatorRuleFile = {
  version: 1;
  rules: ValidatorRule[];
};

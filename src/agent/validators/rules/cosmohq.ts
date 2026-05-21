import type { ValidatorRuleFile } from "./types";

export const cosmohqValidatorRuleFile = {
  version: 1,
  rules: [
    {
      kind: "backend_setup_environment",
      id: "cosmohq.backendSetupEnvironment",
      envFile: ".env.example",
      docsFiles: [".env.example", "README.md"],
      requiredEnv: [
        {
          name: "DATABASE_URL",
          missingIssue: {
            id: "backend-setup-postgres-placeholder-missing",
            severity: "error",
            message: "DATABASE_URL must be present in .env.example as a placeholder.",
            files: [".env.example"],
          },
          forbiddenValues: [
            {
              pattern: "postgres(?:ql)?://[^\"'\\s]*localhost|postgres(?:ql)?://[^\"'\\s]*127\\.0\\.0\\.1|postgres(?:ql)?://postgres:postgres@",
              flags: "i",
              id: "backend-setup-postgres-localhost-hardcoded",
              severity: "error",
              message: "DATABASE_URL must use a placeholder-only value, not a concrete localhost PostgreSQL URL.",
              files: [".env.example"],
            },
          ],
          placeholder: {
            acceptedExplicitPlaceholder: true,
            allowedPatterns: [{ pattern: "(?:\\bcosmohq\\b|\\bazure\\b)", flags: "i" }],
            unclearIssue: {
              id: "backend-setup-postgres-placeholder-unclear",
              severity: "warning",
              message: "DATABASE_URL should be clearly marked as a placeholder in .env.example.",
              files: [".env.example"],
            },
          },
        },
        {
          name: "DIRECT_URL",
          missingIssue: {
            id: "backend-setup-postgres-placeholder-missing",
            severity: "error",
            message: "DIRECT_URL must be present in .env.example as a placeholder.",
            files: [".env.example"],
          },
          forbiddenValues: [
            {
              pattern: "postgres(?:ql)?://[^\"'\\s]*localhost|postgres(?:ql)?://[^\"'\\s]*127\\.0\\.0\\.1|postgres(?:ql)?://postgres:postgres@",
              flags: "i",
              id: "backend-setup-postgres-localhost-hardcoded",
              severity: "error",
              message: "DIRECT_URL must use a placeholder-only value, not a concrete localhost PostgreSQL URL.",
              files: [".env.example"],
            },
          ],
          placeholder: {
            acceptedExplicitPlaceholder: true,
            allowedPatterns: [{ pattern: "(?:\\bcosmohq\\b|\\bazure\\b)", flags: "i" }],
            unclearIssue: {
              id: "backend-setup-postgres-placeholder-unclear",
              severity: "warning",
              message: "DIRECT_URL should be clearly marked as a placeholder in .env.example.",
              files: [".env.example"],
            },
          },
        },
      ],
      documentation: [
        {
          all: [
            { pattern: "CosmoHQ Deploy", flags: "i" },
            { pattern: "Azure PostgreSQL", flags: "i" },
            { pattern: "DATABASE_URL", flags: "i" },
            { pattern: "DIRECT_URL", flags: "i" },
            { pattern: "(seed|mock|test-account)", flags: "i" },
          ],
          issue: {
            id: "backend-setup-deploy-provisioning-note-missing",
            severity: "error",
            message: "Backend setup must document that CosmoHQ Deploy provisions Azure PostgreSQL and DATABASE_URL/DIRECT_URL before seed/mock/test-account actions.",
            files: [".env.example", "README.md"],
          },
        },
      ],
    },
  ],
} satisfies ValidatorRuleFile;

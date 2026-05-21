import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCodingTask } from "../src/agent/validators";

const noIntegrationsDir = join(tmpdir(), "tanya-no-integrations-for-validator-tests");

function stubBackendSetupValidatorRule(): void {
  const integrationsRoot = mkdtempSync(join(tmpdir(), "tanya-validators-backend-rule-integrations-"));
  vi.stubEnv("TANYA_INTEGRATIONS_DIR", integrationsRoot);
  mkdirSync(join(integrationsRoot, "acme", "validators"), { recursive: true });
  const localhostPattern = "postgres(?:ql)?://[^\"'\\s]*localhost|postgres(?:ql)?://[^\"'\\s]*127\\.0\\.0\\.1|postgres(?:ql)?://postgres:postgres@";
  writeFileSync(join(integrationsRoot, "acme", "validators", "backend-setup.json"), JSON.stringify({
    version: 1,
    rules: [
      {
        kind: "backend_setup_environment",
        id: "acme.backendSetupEnvironment",
        envFile: ".env.example",
        docsFiles: [".env.example", "README.md"],
        requiredEnv: ["DATABASE_URL", "DIRECT_URL"].map((name) => ({
          name,
          missingIssue: {
            id: "backend-setup-postgres-placeholder-missing",
            severity: "error",
            message: `${name} must be present in .env.example as a placeholder.`,
            files: [".env.example"],
          },
          forbiddenValues: [
            {
              pattern: localhostPattern,
              flags: "i",
              id: "backend-setup-postgres-localhost-hardcoded",
              severity: "error",
              message: `${name} must use a placeholder-only value, not a concrete localhost PostgreSQL URL.`,
              files: [".env.example"],
            },
          ],
          placeholder: {
            acceptedExplicitPlaceholder: true,
            allowedPatterns: [{ pattern: "(?:\\bacme\\b|\\bmanaged\\b)", flags: "i" }],
            unclearIssue: {
              id: "backend-setup-postgres-placeholder-unclear",
              severity: "warning",
              message: `${name} should be clearly marked as a placeholder in .env.example.`,
              files: [".env.example"],
            },
          },
        })),
        documentation: [
          {
            all: [
              { pattern: "Managed PostgreSQL", flags: "i" },
              { pattern: "DATABASE_URL", flags: "i" },
              { pattern: "DIRECT_URL", flags: "i" },
              { pattern: "(seed|mock|test-account)", flags: "i" },
            ],
            issue: {
              id: "backend-setup-deploy-provisioning-note-missing",
              severity: "error",
              message: "Backend setup must document managed PostgreSQL provisioning and DATABASE_URL/DIRECT_URL before seed/mock/test-account actions.",
              files: [".env.example", "README.md"],
            },
          },
        ],
      },
    ],
  }));
}

beforeEach(() => {
  vi.stubEnv("TANYA_INTEGRATIONS_DIR", noIntegrationsDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("coding validators", () => {
  it("flags forbidden files and likely secret leaks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-core-"));
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgres://real-secret-value-123456\n");
    writeFileSync(join(cwd, "config.ts"), "export const apiKey = 'sk_live_1234567890abcdef';\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [".env", "config.ts"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Backend setup" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.id)).toContain("core-scope-forbidden-file");
    expect(result.issues.map((issue) => issue.id)).toContain("core-secrets-possible-leak");
  });

  it("does not treat token/password variable references as leaked secrets", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-token-vars-"));
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    writeFileSync(join(cwd, "scripts/test-live-endpoints.mjs"), [
      "const state = { accessToken: '', refreshToken: '' };",
      "const result = await request('POST', '/auth/refresh', { body: { refreshToken: state.refreshToken } });",
      "if (data?.accessToken) state.accessToken = data.accessToken;",
      "if (data?.refreshToken) state.refreshToken = data.refreshToken;",
      "const password = process.env.TEST_ACCOUNT_PASSWORD || 'PLACEHOLDER-CHANGE-ME-123!';",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["scripts/test-live-endpoints.mjs"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Backend setup" },
      expected_report: { verification: true },
    });

    expect(result.issues.map((issue) => issue.id)).not.toContain("core-secrets-possible-leak");
  });

  it("does not flag bare camelCase identifiers as leaked secrets (sample MainActivity.kt regression)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-bare-ident-"));
    mkdirSync(join(cwd, "android/app/src/main/java/com/cosmohq/cosanostra"), { recursive: true });
    writeFileSync(join(cwd, "android/app/src/main/java/com/cosmohq/cosanostra/MainActivity.kt"), [
      "// Consume pending Google identity token",
      "val pendingToken = pendingGoogleIdToken",
      "if (pendingToken != null) {",
      "    pendingGoogleIdToken = null",
      "}",
    ].join("\n"));
    const result = await validateCodingTask(cwd, {
      changedFiles: ["android/app/src/main/java/com/cosmohq/cosanostra/MainActivity.kt"],
      verification: ["Verification: ./gradlew test -> passed"],
    }, {
      task: { kind: "coding", title: "Android auth" },
      expected_report: { verification: true },
    });
    expect(result.issues.map((i) => i.id)).not.toContain("core-secrets-possible-leak");
  });

  describe("tone-of-voice validator", () => {
    it("flags Loading... in a feature screen when brand.md declares formal tone", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-tone-formal-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "brand.md"), "Tom de voz: autoritário, sóbrio, profissional.\n");
      writeFileSync(join(cwd, "ios/CosaNostra/AlertsScreen.swift"), [
        "import SwiftUI",
        "struct AlertsScreen: View { var body: some View { Text(\"Loading...\") } }",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/AlertsScreen.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).toContain("tone-of-voice-generic-copy");
    });

    it("does not flag when brand.md doesn't declare a strong tone", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-tone-neutral-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "brand.md"), "Brand colors: #FF0000\n");
      writeFileSync(join(cwd, "ios/CosaNostra/AlertsScreen.swift"), `Text("Loading...")\n`);
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/AlertsScreen.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).not.toContain("tone-of-voice-generic-copy");
    });
  });

  describe("accessibility validator", () => {
    it("flags Image(systemName:) with no accessibilityLabel on iOS", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-a11y-ios-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "ios/CosaNostra/DashboardScreen.swift"), [
        "import SwiftUI",
        "struct DashboardScreen: View {",
        "    var body: some View {",
        "        Image(systemName: \"bell\")",
        "    }",
        "}",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/DashboardScreen.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).toContain("a11y-image-missing-label");
    });

    it("does not flag Image when accessibilityLabel is present", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-a11y-ok-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "ios/CosaNostra/DashboardScreen.swift"), [
        "Image(systemName: \"bell\")",
        "    .accessibilityLabel(\"Notificações\")",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/DashboardScreen.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).not.toContain("a11y-image-missing-label");
    });
  });

  describe("brand fidelity validator", () => {
    it("flags inline hex code in an iOS feature screen", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-brand-fidelity-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "ios/CosaNostra/DashboardScreen.swift"), [
        "import SwiftUI",
        "struct DashboardScreen: View {",
        "    var body: some View {",
        "        Color(hex: \"#A52A2A\")",
        "    }",
        "}",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/DashboardScreen.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 Dashboard — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).toContain("brand-fidelity-inline-hex");
    });

    it("does not flag hex codes in token files (where they belong)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-brand-fidelity-tokens-"));
      mkdirSync(join(cwd, "ios/CosaNostra"), { recursive: true });
      writeFileSync(join(cwd, "ios/CosaNostra/Colors.swift"), [
        "import SwiftUI",
        "enum Theme {",
        "    static let primary = Color(hex: \"#A52A2A\")",
        "    static let accent = Color(hex: \"#DAA520\")",
        "}",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "ios"), {
        changedFiles: ["CosaNostra/Colors.swift"],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 Dashboard — iOS" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).not.toContain("brand-fidelity-inline-hex");
    });

    it("does not flag inline hex in non-feature paths (e.g. tests)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-brand-fidelity-tests-"));
      mkdirSync(join(cwd, "android/app/src/test/java/com/cosmohq"), { recursive: true });
      writeFileSync(join(cwd, "android/app/src/test/java/com/cosmohq/SomeTest.kt"), [
        "// Helper: expected color from API response is 0xFFA52A2A",
        "val expected = 0xFFA52A2A.toInt()",
      ].join("\n"));
      const result = await validateCodingTask(join(cwd, "android"), {
        changedFiles: ["app/src/test/java/com/cosmohq/SomeTest.kt"],
        verification: ["Verification: ./gradlew test -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — Android" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).not.toContain("brand-fidelity-inline-hex");
    });
  });

  describe("schema migration validator", () => {
    it("blocks schema.prisma changes when no migration exists in the repo", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-schema-mig-1-"));
      mkdirSync(join(cwd, "backend/prisma"), { recursive: true });
      const workspace = join(cwd, "backend");
      writeFileSync(join(workspace, "prisma/schema.prisma"), [
        "generator client { provider = \"prisma-client-js\" }",
        "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }",
        "model VerificationCode { id String @id; userId String @unique }",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["prisma/schema.prisma"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Backend auth" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("task-schema-migration-missing");
      expect(result.passed).toBe(false);
    });

    it("passes when schema.prisma changes ship with a fresh migration file", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-schema-mig-2-"));
      const workspace = join(cwd, "backend");
      mkdirSync(join(workspace, "prisma/migrations/20260501_add_verification_code"), { recursive: true });
      writeFileSync(join(workspace, "prisma/schema.prisma"), "model VerificationCode { id String @id }");
      writeFileSync(
        join(workspace, "prisma/migrations/20260501_add_verification_code/migration.sql"),
        "CREATE TABLE \"VerificationCode\" (\"id\" TEXT NOT NULL);",
      );
      const result = await validateCodingTask(workspace, {
        changedFiles: [
          "prisma/schema.prisma",
          "prisma/migrations/20260501_add_verification_code/migration.sql",
        ],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Backend auth" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).not.toContain("task-schema-migration-missing");
    });

    it("does not fire on non-backend platforms even when prisma/schema.prisma is touched", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-schema-mig-3-"));
      const workspace = join(cwd, "ios");
      mkdirSync(workspace, { recursive: true });
      const result = await validateCodingTask(workspace, {
        changedFiles: ["prisma/schema.prisma"],
        verification: ["Verification: xcodebuild -> passed"],
      }, {
        task: { kind: "coding", title: "iOS feature" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).not.toContain("task-schema-migration-missing");
    });
  });

  describe("deploy shape validator", () => {
    it("flags Dockerfile that uses prisma db push", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-deploy-shape-1-"));
      const workspace = join(cwd, "backend");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "Dockerfile"), [
        "FROM node:22-slim",
        "WORKDIR /app",
        "COPY . .",
        "CMD [\"sh\", \"-c\", \"prisma db push && npm start\"]",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["Dockerfile"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Backend deploy" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("task-deploy-shape-uses-db-push");
      expect(result.passed).toBe(false);
    });

    it("flags Dockerfile that runs prisma migrate in a background subshell", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-deploy-shape-2-"));
      const workspace = join(cwd, "backend");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "Dockerfile"), [
        "FROM node:22-slim",
        "CMD sh -c '(npx prisma migrate deploy) & exec npm start'",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["Dockerfile"],
        verification: [],
      }, {
        task: { kind: "coding", title: "Backend deploy" },
        expected_report: { verification: false },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("task-deploy-shape-async-prisma-on-boot");
    });

    it("passes a Dockerfile that runs migrate deploy synchronously with DATABASE_URL guard", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-deploy-shape-3-"));
      const workspace = join(cwd, "backend");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "Dockerfile"), [
        "FROM node:22-slim",
        "CMD [\"sh\", \"-c\", \"if [ -z \\\"${DATABASE_URL:-}\\\" ]; then exit 1; fi; npx prisma migrate deploy && exec npm start\"]",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["Dockerfile"],
        verification: [],
      }, {
        task: { kind: "coding", title: "Backend deploy" },
        expected_report: { verification: false },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).not.toContain("task-deploy-shape-uses-db-push");
      expect(ids).not.toContain("task-deploy-shape-async-prisma-on-boot");
      expect(ids).not.toContain("task-deploy-shape-no-database-url-guard");
    });
  });

  describe("external API contract validator", () => {
    it("flags lib/email.ts that passes FROM_EMAIL whole to Brevo's sender.email", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-ext-api-1-"));
      const workspace = join(cwd, "backend");
      mkdirSync(join(workspace, "lib"), { recursive: true });
      writeFileSync(join(workspace, "lib/email.ts"), [
        "export async function sendEmail(p: { to: string; subject: string }) {",
        "  const fromEmail = process.env.FROM_EMAIL || 'a@b.com';",
        "  await fetch('https://api.brevo.com/v3/smtp/email', {",
        "    method: 'POST',",
        "    body: JSON.stringify({ sender: { name: 'X', email: fromEmail }, to: [{ email: p.to }] }),",
        "  });",
        "}",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["lib/email.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Backend email" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("task-external-api-contract-from-email-rfc822");
      expect(result.passed).toBe(false);
    });

    it("does not fire when FROM_EMAIL is parsed before being passed to sender.email", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-ext-api-2-"));
      const workspace = join(cwd, "backend");
      mkdirSync(join(workspace, "lib"), { recursive: true });
      writeFileSync(join(workspace, "lib/email.ts"), [
        "export async function sendEmail(p: { to: string; subject: string }) {",
        "  const fromRaw = process.env.FROM_EMAIL || 'a@b.com';",
        "  const rfcMatch = /^\\s*(.*?)\\s*<\\s*([^<>\\s]+@[^<>\\s]+)\\s*>\\s*$/.exec(fromRaw);",
        "  const senderEmail = rfcMatch?.[2]?.trim() || fromRaw.trim();",
        "  await fetch('https://api.brevo.com/v3/smtp/email', {",
        "    method: 'POST',",
        "    body: JSON.stringify({ sender: { name: 'X', email: senderEmail }, to: [{ email: p.to }] }),",
        "  });",
        "}",
      ].join("\n"));
      const result = await validateCodingTask(workspace, {
        changedFiles: ["lib/email.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Backend email" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).not.toContain("task-external-api-contract-from-email-rfc822");
    });
  });

  describe("platform isolation validator", () => {
    it("flags an iOS step that wrote files in android/", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-platform-iso-ios-"));
      mkdirSync(join(cwd, "ios"), { recursive: true });
      const workspace = join(cwd, "ios");
      const result = await validateCodingTask(workspace, {
        changedFiles: [
          "ios/CosaNostra/FeatureScreens.swift",
          "android/app/src/main/java/com/cosmohq/cosanostra/search/SearchApi.kt",
          "android/app/src/main/java/com/cosmohq/cosanostra/search/SearchRepository.kt",
        ],
        verification: ["Verification: xcodebuild build -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — iOS" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("core-platform-isolation-violated");
      expect(result.passed).toBe(false);
    });

    it("does not flag a single-platform step", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-platform-iso-clean-"));
      mkdirSync(join(cwd, "android"), { recursive: true });
      const workspace = join(cwd, "android");
      const result = await validateCodingTask(workspace, {
        changedFiles: [
          "android/app/src/main/java/com/cosmohq/cosanostra/MainActivity.kt",
          "android/app/src/test/java/com/cosmohq/cosanostra/Tests.kt",
        ],
        verification: ["Verification: ./gradlew test -> passed"],
      }, {
        task: { kind: "coding", title: "feature/1 — Android" },
        expected_report: { verification: true },
      });
      expect(result.issues.map((i) => i.id)).not.toContain("core-platform-isolation-violated");
    });
  });

  it("enforces configured allowed paths", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-scope-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["ios/App.swift", "android/MainActivity.kt"],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "iOS task" },
      expected_report: { verification: true },
      metadata: { allowedPaths: ["ios/**"] },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core-scope-outside-allowed-paths", files: ["android/MainActivity.kt"] }),
    ]));
  });

  it("requires automatic brief artifact candidates to be considered before changing files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-auto-brief-artifacts-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["src/index.ts"],
      contextFilesRead: ["README.md"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Patch implementation" },
      expected_report: { verification: true, artifact_reuse: true, context_review: true },
      metadata: {
        autoBriefEnforceArtifacts: true,
        autoBrief: {
          artifacts: [{ path: "artifacts/backend/HealthRoute.ts" }],
          contextFiles: [{ path: "README.md" }],
        },
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core-auto-brief-artifact-not-considered", severity: "error" }),
    ]));
  });

  it("warns when automatic brief context files were not read before changing files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-auto-brief-context-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["src/index.ts"],
      artifactsRead: ["artifacts/backend/HealthRoute.ts"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Patch implementation" },
      expected_report: { verification: true, context_review: true },
      metadata: {
        autoBrief: {
          contextFiles: [{ path: "README.md" }],
        },
      },
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core-context-review-missing", severity: "warning" }),
    ]));
  });

  it("does not fail host-driven runs on unmarked exact verification commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-cosmo-verification-soft-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["src/index.ts"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Backend task" },
      expected_report: { verification: true },
      verification: { commands: ["npm run typecheck"] },
      metadata: { caller: "cosmochat" },
    });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core-verification-requested-command-missing", severity: "warning" }),
    ]));
  });

  it("fails host-driven runs on explicitly strict verification commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-cosmo-verification-strict-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["src/index.ts"],
      verification: ["Verification: npm test -> passed"],
    }, {
      task: { kind: "coding", title: "Backend task" },
      expected_report: { verification: true },
      verification: { commands: ["npm run typecheck"] },
      metadata: { caller: "cosmochat", exactVerificationCommands: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core-verification-requested-command-missing", severity: "error" }),
    ]));
  });

  it("accepts piped/cwd-prefixed verification lines that contain the requested command verbatim", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-piped-verification-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["app/build.gradle.kts"],
      verification: [
        "Verification: cd /path/sample-app/android && set -o pipefail && ./gradlew test --no-daemon 2>&1 | tail -20 -> passed",
        "Verification: cd /path/sample-app/android && set -o pipefail && ./gradlew assembleDebug --no-daemon 2>&1 | tail -10 -> passed",
        "Verification: cd /path/sample-app/backend && npm run prisma:generate 2>&1 -> passed",
        "Verification: cd /path/sample-app/ios && xcodebuild -list 2>&1 | head -30 -> passed",
      ],
    }, {
      task: { kind: "coding", title: "Cosa Nostra coding task" },
      expected_report: { verification: true },
      verification: {
        commands: [
          "./gradlew test --no-daemon",
          "./gradlew assembleDebug --no-daemon",
          "npm run prisma:generate",
          "xcodebuild -list",
        ],
      },
      metadata: { caller: "cosmochat", exactVerificationCommands: true },
    });

    const missing = result.issues.filter((issue) => issue.id === "core-verification-requested-command-missing");
    expect(missing).toEqual([]);
  });

  it("does not match a requested command when the captured line is unrelated", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-piped-mismatch-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["src/index.ts"],
      verification: ["Verification: cd /tmp && ls -la 2>&1 -> passed"],
    }, {
      task: { kind: "coding", title: "Backend task" },
      expected_report: { verification: true },
      verification: { commands: ["npm run typecheck"] },
      metadata: { caller: "cosmochat", exactVerificationCommands: true },
    });

    const missing = result.issues.filter((issue) => issue.id === "core-verification-requested-command-missing");
    expect(missing).toEqual([
      expect.objectContaining({ id: "core-verification-requested-command-missing", severity: "error" }),
    ]);
  });

  it("rejects backend setup env examples with concrete localhost postgres URLs", async () => {
    stubBackendSetupValidatorRule();
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-backend-setup-env-"));
    writeFileSync(join(cwd, ".env.example"), [
      'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app_db"',
      'DIRECT_URL="postgresql://postgres:postgres@localhost:5432/app_db"',
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["package.json"],
      verification: ["Verification: npm run typecheck -> passed"],
    }, {
      task: { kind: "coding", title: "Setup Environment - Backend" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.id)).toContain("backend-setup-postgres-localhost-hardcoded");
    expect(result.issues.map((issue) => issue.id)).toContain("backend-setup-deploy-provisioning-note-missing");
  });

  it("detects backend setup env violations from a full reference prompt when task title is generic", async () => {
    stubBackendSetupValidatorRule();
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-backend-setup-cosmo-prompt-"));
    writeFileSync(join(cwd, ".env.example"), [
      'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cosa_nostra"',
      'DIRECT_URL="postgresql://postgres:postgres@localhost:5432/cosa_nostra"',
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["package.json"],
      verification: ["Verification: npm run typecheck -> passed"],
    }, {
      task: { kind: "coding", title: "IMPORTANT: Follow all rules in brand/safety.md" },
      expected_report: { verification: true },
      metadata: {
        validationPrompt: "Set up backend for Cosa Nostra. Configure PostgreSQL with .env.example placeholders only; never hardcode a localhost DATABASE_URL as production.",
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.id)).toContain("backend-setup-postgres-localhost-hardcoded");
  });

  it("accepts backend setup env examples with deploy-owned postgres placeholders", async () => {
    stubBackendSetupValidatorRule();
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-backend-setup-env-ok-"));
    writeFileSync(join(cwd, ".env.example"), [
      "# ACME Deploy provisions Managed PostgreSQL.",
      "# Set DATABASE_URL and DIRECT_URL before seed:mock-data and seed:test-account actions.",
      'DATABASE_URL="replace-me-acme-managed-postgresql-url"',
      'DIRECT_URL="replace-me-acme-managed-postgresql-direct-url"',
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["package.json"],
      verification: ["Verification: npm run typecheck -> passed"],
    }, {
      task: { kind: "coding", title: "Setup Environment - Backend" },
      expected_report: { verification: true },
    });

    expect(result.issues.map((issue) => issue.id)).not.toContain("backend-setup-postgres-localhost-hardcoded");
    expect(result.issues.map((issue) => issue.id)).not.toContain("backend-setup-deploy-provisioning-note-missing");
  });

  it("loads discovered backend setup validator rules from integrations", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-discovered-rule-workspace-"));
    const integrationsRoot = mkdtempSync(join(tmpdir(), "tanya-validators-discovered-rule-integrations-"));
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", integrationsRoot);
    mkdirSync(join(integrationsRoot, "acme", "validators"), { recursive: true });
    writeFileSync(join(integrationsRoot, "acme", "validators", "backend-setup.json"), JSON.stringify({
      version: 1,
      rules: [
        {
          kind: "backend_setup_environment",
          id: "acme.backendSetupEnvironment",
          docsFiles: [".env.example", "README.md"],
          documentation: [
            {
              all: [{ pattern: "ACME Managed Postgres", flags: "i" }],
              issue: {
                id: "acme-backend-setup-note-missing",
                severity: "error",
                message: "Backend setup must document ACME Managed Postgres ownership.",
                files: [".env.example", "README.md"],
              },
            },
          ],
        },
      ],
    }));
    writeFileSync(join(cwd, ".env.example"), [
      "# Managed Postgres is provisioned by deploy automation.",
      "# Set DATABASE_URL and DIRECT_URL before seed:mock-data and seed:test-account actions.",
      'DATABASE_URL="replace-me-acme-managed-postgres-url"',
      'DIRECT_URL="replace-me-acme-managed-postgres-direct-url"',
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["package.json"],
      verification: ["Verification: npm run typecheck -> passed"],
    }, {
      task: { kind: "coding", title: "Setup Environment - Backend" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "acme-backend-setup-note-missing", severity: "error" }),
    ]));
  });

  it("keeps core validators free of extracted product rule literals", () => {
    const source = readFileSync(join(process.cwd(), "src/agent/validators/core.ts"), "utf8");

    expect(source).not.toMatch(/cosmohq|CosmoHQ/);
  });

  it("validates a passing iOS splash task", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-splash-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "private let brandRed = Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255)",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  @State private var pulse = false",
      "  var body: some View {",
      "    ZStack {",
      "      LinearGradient(colors: [brandRed, .black], startPoint: .top, endPoint: .bottom)",
      "      VStack {",
      "        RoundedRectangle(cornerRadius: 28).shadow(radius: pulse ? 28 : 14).scaleEffect(pulse ? 1.04 : 0.98).overlay(Image(\"SplashIcon\"))",
      "        Text(\"Cosa Nostra\")",
      "      }",
      "    }.onAppear { pulse = true; Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "      .animation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), value: pulse)",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("accepts a simple iOS splash when the task asks for solid color and fade only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-splash-minimal-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  var body: some View {",
      "    Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255).overlay(Image(\"SplashIcon\"))",
      "      .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS", summary: "Background: solid brand color. Brief fade-in animation on the icon, nothing else." },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("rejects a rich iOS splash when the task asks for solid color and fade only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-splash-rich-rejected-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "private let brandRed = Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255)",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  @State private var pulse = false",
      "  var body: some View {",
      "    LinearGradient(colors: [brandRed, .black], startPoint: .top, endPoint: .bottom)",
      "      .overlay(RoundedRectangle(cornerRadius: 28).scaleEffect(pulse ? 1.04 : 0.98).overlay(Image(\"SplashIcon\")))",
      "      .onAppear { pulse = true; Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "      .animation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), value: pulse)",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS", summary: "Background: solid brand color. Brief fade-in animation on the icon, nothing else." },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ios-splash-solid-background-violated" }),
      expect.objectContaining({ id: "ios-splash-extra-animation" }),
    ]));
  });

  it("rejects iOS splash text when the task asks for icon only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-splash-text-rejected-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "private let brandRed = Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255)",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  @State private var iconVisible = false",
      "  var body: some View {",
      "    brandRed.overlay(VStack { Image(\"SplashIcon\").opacity(iconVisible ? 1 : 0); Text(\"Cosa Nostra\") })",
      "      .onAppear { iconVisible = true; Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS", summary: "No taglines, no text; centered Image(\"SplashIcon\") only." },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ios-splash-text-forbidden" }),
    ]));
  });

  it("validates Android splash resource wiring", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-splash-"));
    mkdirSync(join(cwd, "app/src/main/res/values"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/res/drawable"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example"), { recursive: true });
    writeFileSync(join(cwd, "app/src/main/res/values/splash_theme.xml"), "<resources><style name=\"App.Splash\" parent=\"Theme.SplashScreen\"><item name=\"windowSplashScreenAnimatedIcon\">@drawable/ic_splash_logo</item></style></resources>");
    writeFileSync(join(cwd, "app/src/main/AndroidManifest.xml"), "<manifest><application android:theme=\"@style/App.Splash\" /></manifest>");
    writeFileSync(join(cwd, "app/src/main/java/com/example/MainActivity.kt"), "fun onCreate() { installSplashScreen() }\n");
    writeFileSync(join(cwd, "app/src/main/res/drawable/ic_splash_logo.png"), "png");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "app/src/main/res/values/splash_theme.xml",
        "app/src/main/AndroidManifest.xml",
        "app/src/main/java/com/example/MainActivity.kt",
        "app/src/main/res/drawable/ic_splash_logo.png",
      ],
      verification: ["Verification: ./gradlew assembleDebug --no-daemon -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
  });

  it("requires Gradle wrapper verification for Android tasks when gradlew exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-gradle-required-"));
    mkdirSync(join(cwd, "app/src/main/res/values"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/res/drawable"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example"), { recursive: true });
    writeFileSync(join(cwd, "gradlew"), "#!/bin/sh\necho BUILD SUCCESSFUL\n");
    writeFileSync(join(cwd, "build.gradle.kts"), "plugins { id(\"org.jlleitschuh.gradle.ktlint\") version \"12.1.1\" apply false }\n");
    writeFileSync(join(cwd, "app/src/main/res/values/splash_theme.xml"), "<resources><style name=\"App.Splash\" parent=\"Theme.SplashScreen\"><item name=\"windowSplashScreenAnimatedIcon\">@drawable/ic_splash_logo</item></style></resources>");
    writeFileSync(join(cwd, "app/src/main/AndroidManifest.xml"), "<manifest><application android:theme=\"@style/App.Splash\" /></manifest>");
    writeFileSync(join(cwd, "app/src/main/java/com/example/MainActivity.kt"), "fun onCreate() { installSplashScreen() }\n");
    writeFileSync(join(cwd, "app/src/main/res/drawable/ic_splash_logo.png"), "png");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "app/src/main/res/values/splash_theme.xml",
        "app/src/main/AndroidManifest.xml",
        "app/src/main/java/com/example/MainActivity.kt",
        "app/src/main/res/drawable/ic_splash_logo.png",
      ],
      verification: ["Verification: file presence checks -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "android-gradle-assembledebug-missing" }),
      expect.objectContaining({ id: "android-gradle-ktlintcheck-missing" }),
    ]));
  });

  it("validates Android foundation structure and dependencies", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-foundation-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/data"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/navigation"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/theme"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/components"), { recursive: true });
    writeFileSync(join(cwd, "build.gradle.kts"), "plugins { id(\"com.google.devtools.ksp\") version \"1.9.24-1.0.20\" apply false }\n");
    writeFileSync(join(cwd, "app/build.gradle.kts"), [
      "plugins { id(\"com.google.devtools.ksp\") }",
      "dependencies {",
      "implementation(\"androidx.navigation:navigation-compose:2.8.3\")",
      "implementation(\"androidx.room:room-runtime:2.6.1\")",
      "implementation(\"androidx.room:room-ktx:2.6.1\")",
      "ksp(\"androidx.room:room-compiler:2.6.1\")",
      "}",
    ].join("\n"));
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/data/AppDatabase.kt"), "@Entity data class Item(@PrimaryKey val id: Long)\n@Dao interface ItemDao\n@Database(entities = [Item::class], version = 1) abstract class AppDatabase : RoomDatabase()\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/navigation/AppNavigation.kt"), "fun x() { rememberNavController(); NavHost(null, \"home\") {}; NavigationBarItem(selected = true, onClick = {}, icon = {}, label = {}) }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt"), "@Composable fun AppTheme() { MaterialTheme(colorScheme = darkColorScheme()) {} }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/components/FoundationStates.kt"), "fun EmptyState() {}\nfun LoadingState() {}\nfun ErrorState() {}\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "build.gradle.kts",
        "app/build.gradle.kts",
        "app/src/main/java/com/example/app/data/AppDatabase.kt",
        "app/src/main/java/com/example/app/navigation/AppNavigation.kt",
        "app/src/main/java/com/example/app/ui/theme/AppTheme.kt",
        "app/src/main/java/com/example/app/ui/components/FoundationStates.kt",
      ],
      artifactsRead: ["artifacts/android/ThemeSystem.kt", "artifacts/android/NavigationSetup.kt", "artifacts/android/RoomSetup.kt"],
      verification: ["Verification: ./gradlew assembleDebug --no-daemon -> passed"],
    }, {
      task: { kind: "coding", title: "Fundações - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
  });

  it("rejects Android base layout that omits requested feature modules and premium gating", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-base-layout-features-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/navigation"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/search"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/favorites"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/alerts"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/dashboard"), { recursive: true });
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/navigation/AppNavigation.kt"), [
      "sealed class AppRoute(val path: String, val label: String) {",
      "  data object Dashboard : AppRoute(\"dashboard\", \"Painel\")",
      "  data object Search : AppRoute(\"search\", \"Busca\")",
      "  data object Favorites : AppRoute(\"favorites\", \"Favoritos\")",
      "  data object Alerts : AppRoute(\"alerts\", \"Alertas\")",
      "  data object Settings : AppRoute(\"settings\", \"Ajustes\")",
      "}",
      "fun AppNavHost() { NavHost(null, AppRoute.Dashboard.path) { composable(AppRoute.Search.path) {} }; NavigationBarItem(selected = true, onClick = {}, icon = {}, label = {}) }",
    ].join("\n"));
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/search/SearchScreen.kt"), "fun SearchScreen() { print(\"Busca Avancada de Jurisprudencia por Juiz\") }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/favorites/FavoritesScreen.kt"), "fun FavoritesScreen() { print(\"Organizacao e Favoritacao de Casos\") }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/alerts/AlertsScreen.kt"), "fun AlertsScreen() { print(\"Alertas Personalizados\") }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/dashboard/DashboardScreen.kt"), "fun DashboardScreen() { print(\"Painel Dashboard de Visao Geral com metricas de performance\") }\n");

    const validationPrompt = [
      "Build base layout for Cosa Nostra Android.",
      "Features:",
      "- **Busca Avançada de Jurisprudência com Filtros por Juiz** (medium) [premium] — Sem descricao definida.",
      "- **Perfis de Juízes com Métricas de Performance** (medium) [premium] — Sem descricao definida.",
      "- **Sistema de Alertas Personalizados** (medium) [premium] — Sem descricao definida.",
      "- **Organização e Favoritação de Casos/Decisões** (medium) [premium] — Sem descricao definida.",
      "- **Painel (Dashboard) de Visão Geral** (medium) [premium] — Sem descricao definida.",
      "Tasks: 1) Bottom navigation with feature tabs 2) Placeholder screens per feature 3) Wire navigation.",
    ].join("\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: ["app/src/main/java/com/example/app/navigation/AppNavigation.kt"],
      verification: [
        "Verification: ./gradlew assembleDebug --no-daemon -> passed",
        "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
      ],
    }, {
      task: { kind: "coding", title: "Layout Base + Componentes - Android" },
      expected_report: { verification: true },
      metadata: { validationPrompt },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "android-base-layout-feature-missing" }),
      expect.objectContaining({ id: "android-base-layout-premium-gate-missing" }),
    ]));
  });

  it("accepts Android base layout with exact feature modules and premium gate", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-base-layout-complete-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/navigation"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/features"), { recursive: true });
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/navigation/AppNavigation.kt"), [
      "sealed class AppRoute(val path: String, val label: String) {",
      "  data object SearchCases : AppRoute(\"search_cases\", \"Busca\")",
      "  data object JudgeProfiles : AppRoute(\"judge_profiles\", \"Juizes\")",
      "  data object Alerts : AppRoute(\"alerts\", \"Alertas\")",
      "  data object Favorites : AppRoute(\"favorites\", \"Favoritos\")",
      "  data object Dashboard : AppRoute(\"dashboard\", \"Painel\")",
      "}",
      "fun AppNavHost() { NavHost(null, AppRoute.Dashboard.path) { composable(AppRoute.JudgeProfiles.path) {} }; NavigationBarItem(selected = true, onClick = {}, icon = {}, label = {}) }",
    ].join("\n"));
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/features/FeatureScreens.kt"), [
      "fun PremiumGate(isPaidFeature: Boolean, content: () -> Unit) = content()",
      "fun SearchCasesScreen() { PremiumGate(true) { print(\"Busca avancada de jurisprudencia com filtros por juiz\") } }",
      "fun JudgeProfilesScreen() { PremiumGate(true) { print(\"Perfis de juizes com metricas de performance\") } }",
      "fun AlertsScreen() { PremiumGate(true) { print(\"Sistema de alertas personalizados\") } }",
      "fun FavoritesScreen() { PremiumGate(true) { print(\"Organizacao e Favoritacao de Casos Decisoes\") } }",
      "fun DashboardScreen() { PremiumGate(true) { print(\"Painel Dashboard de visao geral\") } }",
    ].join("\n"));

    const validationPrompt = [
      "Build base layout for Cosa Nostra Android.",
      "Features:",
      "- **Busca Avançada de Jurisprudência com Filtros por Juiz** (medium) [premium] — Sem descricao definida.",
      "- **Perfis de Juízes com Métricas de Performance** (medium) [premium] — Sem descricao definida.",
      "- **Sistema de Alertas Personalizados** (medium) [premium] — Sem descricao definida.",
      "- **Organização e Favoritação de Casos/Decisões** (medium) [premium] — Sem descricao definida.",
      "- **Painel (Dashboard) de Visão Geral** (medium) [premium] — Sem descricao definida.",
      "Tasks: 1) Bottom navigation with feature tabs 2) Placeholder screens per feature 3) Wire navigation.",
    ].join("\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "app/src/main/java/com/example/app/navigation/AppNavigation.kt",
        "app/src/main/java/com/example/app/ui/features/FeatureScreens.kt",
      ],
      verification: [
        "Verification: ./gradlew assembleDebug --no-daemon -> passed",
        "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
      ],
    }, {
      task: { kind: "coding", title: "Layout Base + Componentes - Android" },
      expected_report: { verification: true },
      metadata: { validationPrompt },
    });

    expect(result.passed).toBe(true);
  });

  it("rejects incomplete iOS foundation dark-mode and manual font setup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-foundation-incomplete-"));
    mkdirSync(join(cwd, "CosaNostra"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Colors.swift"), [
      "import SwiftUI",
      "extension Color {",
      "  static let brandPrimary = Color(red: 26 / 255, green: 47 / 255, blue: 75 / 255)",
      "  static let brandSecondary = Color(red: 200 / 255, green: 174 / 255, blue: 127 / 255)",
      "  static let brandWhite = Color.white",
      "}",
    ].join("\n"));
    writeFileSync(join(cwd, "CosaNostra/Typography.swift"), "import SwiftUI\nenum AppTypography { static let title = Font.custom(\"PlayfairDisplay-Regular\", size: 28) /* manual action required: add font files */ }\n");
    writeFileSync(join(cwd, "CosaNostra/CosaNostraApp.swift"), "import SwiftUI\nimport SwiftData\n@main struct CosaNostraApp: App { @AppStorage(\"isDarkMode\") var isDarkMode = false; var body: some Scene { WindowGroup { ContentView().preferredColorScheme(isDarkMode ? .dark : nil).modelContainer(for: [UserProfile.self]) } } }\n");
    writeFileSync(join(cwd, "CosaNostra/SwiftDataModels.swift"), "import SwiftData\n@Model final class UserProfile { var id: String = \"\" }\n");
    writeFileSync(join(cwd, "CosaNostra/NavigationView.swift"), "import SwiftUI\nstruct RootTabView: View { var body: some View { TabView { NavigationStack { Text(\"Dashboard\") } } } }\n");
    writeFileSync(join(cwd, "CosaNostra/ViewModifiers.swift"), "import SwiftUI\nstruct CardStyle: ViewModifier { func body(content: Content) -> some View { content.foregroundStyle(Color.brandWhite) } }\nstruct PrimaryButtonStyle: ButtonStyle { func makeBody(configuration: Configuration) -> some View { configuration.label } }\nstruct EmptyStateView: View { var body: some View { Text(\"Empty\") } }\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/Colors.swift",
        "CosaNostra/Typography.swift",
        "CosaNostra/CosaNostraApp.swift",
        "CosaNostra/SwiftDataModels.swift",
        "CosaNostra/NavigationView.swift",
        "CosaNostra/ViewModifiers.swift",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Fundações - iOS", summary: "Follow brand rules, typography, and ensure dark mode support." },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ios-foundation-dark-mode-control-missing" }),
      expect.objectContaining({ id: "ios-foundation-manual-font-action" }),
    ]));
  });

  it("validates Android foundation against existing project files, not only changed files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-foundation-existing-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/data"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/navigation"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/theme"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/components"), { recursive: true });
    writeFileSync(join(cwd, "app/build.gradle.kts"), [
      "dependencies {",
      "implementation(\"androidx.navigation:navigation-compose:2.8.3\")",
      "implementation(\"androidx.room:room-runtime:2.6.1\")",
      "implementation(\"androidx.room:room-ktx:2.6.1\")",
      "ksp(\"androidx.room:room-compiler:2.6.1\")",
      "}",
    ].join("\n"));
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/data/AppDatabase.kt"), "@Entity data class Item(@PrimaryKey val id: Long)\n@Dao interface ItemDao\n@Database(entities = [Item::class], version = 1) abstract class AppDatabase : RoomDatabase()\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/navigation/AppNavigation.kt"), "fun x() { rememberNavController(); NavHost(null, \"home\") {}; NavigationBarItem(selected = true, onClick = {}, icon = {}, label = {}) }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt"), "@Composable fun AppTheme() { MaterialTheme(colorScheme = darkColorScheme()) {} }\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/components/FoundationStates.kt"), "fun EmptyState() {}\nfun LoadingState() {}\nfun ErrorState() {}\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "app/src/main/java/com/example/app/ui/theme/AppTheme.kt",
        "app/src/main/java/com/example/app/navigation/AppNavigation.kt",
      ],
      artifactsRead: ["artifacts/android/ThemeSystem.kt", "artifacts/android/NavigationSetup.kt", "artifacts/android/RoomSetup.kt"],
      verification: ["Verification: ./gradlew assembleDebug --no-daemon -> passed"],
    }, {
      task: { kind: "coding", title: "Fundações - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
  });

  it("does not select unrelated validators from raw caller prompts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-raw-prompt-scope-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  var body: some View {",
      "    Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255).overlay(Image(\"SplashIcon\"))",
      "      .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS", summary: "Background: solid brand color. Brief fade-in animation on the icon, nothing else." },
      expected_report: { verification: true },
      metadata: {
        caller: "cosmochat",
        validationPrompt: "Also includes unrelated words: Android splash, setup environment, Fastlane, SwiftLint, Gradle, API client, auth, backend, RevenueCat, app icon, title.",
      },
    });

    expect(result.passed).toBe(true);
    expect(result.issues.map((issue) => issue.id)).not.toEqual(expect.arrayContaining([
      "android-splash-theme-missing",
      "setup-ios-fastlane-missing",
      "setup-android-gradle-missing",
      "api-client-files-missing",
      "auth-session-files-missing",
      "backend-api-files-missing",
      "revenuecat-files-missing",
      "ios-splash-app-name-missing",
    ]));
  });

  it("uses raw prompt constraints inside the selected iOS splash validator", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-raw-constraints-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  var body: some View {",
      "    Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255).overlay(VStack { Image(\"SplashIcon\"); Text(\"Cosa Nostra\") })",
      "      .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS" },
      expected_report: { verification: true },
      metadata: {
        caller: "cosmochat",
        validationPrompt: "Create splash screen. No taglines, no text. Brief fade-in animation on the icon, nothing else.",
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ios-splash-text-forbidden" }),
    ]));
    expect(result.issues.map((issue) => issue.id)).not.toContain("ios-splash-app-name-missing");
  });

  it("does not run iOS splash validation for non-splash tasks that touch SplashScreenView", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-foundation-splash-touch-"));
    mkdirSync(join(cwd, "CosaNostra"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "struct SplashScreenView: View {",
      "  var body: some View {",
      "    Color.brandPrimary",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["CosaNostra/SplashScreenView.swift"],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Fundações - iOS", summary: "Build iOS foundation and theme." },
      expected_report: { verification: true },
    });

    expect(result.issues.map((issue) => issue.id)).not.toContain("ios-splash-asset-json-missing");
    expect(result.issues.map((issue) => issue.id)).not.toContain("ios-splash-icon-image");
  });

  it("lets explicit solid-background instructions override artifact gradient wording", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-splash-solid-over-gradient-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}");
    writeFileSync(join(cwd, "CosaNostra/SplashScreenView.swift"), [
      "import SwiftUI",
      "struct SplashScreenView<Content: View>: View {",
      "  @State private var isReady = false",
      "  var body: some View {",
      "    Color(red: 165 / 255, green: 42 / 255, blue: 42 / 255).overlay(Image(\"SplashIcon\"))",
      "      .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/SplashScreenView.swift",
        "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
      ],
      artifactsRead: ["artifacts/ios/SplashScreenPattern.swift"],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Splash Screen - iOS" },
      expected_report: { verification: true },
      metadata: {
        caller: "cosmochat",
        validationPrompt: "Matched artifact says brand gradient, but task requires a solid brand color. No gradients. No text.",
      },
    });

    expect(result.issues.map((issue) => issue.id)).not.toContain("ios-splash-gradient-missing");
    expect(result.issues.map((issue) => issue.id)).not.toContain("ios-splash-solid-background-violated");
  });

  it("rejects incomplete Android foundation output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-foundation-bad-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/app/ui/theme"), { recursive: true });
    writeFileSync(join(cwd, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt"), "@Composable fun AppTheme() { MaterialTheme {} }\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: ["app/src/main/java/com/example/app/ui/theme/AppTheme.kt"],
      artifactsRead: ["artifacts/android/ThemeSystem.kt", "artifacts/android/NavigationSetup.kt", "artifacts/android/RoomSetup.kt"],
      verification: ["Verification: ./gradlew assembleDebug --no-daemon -> passed"],
    }, {
      task: { kind: "coding", title: "Fundações - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "android-foundation-room-missing" }),
      expect.objectContaining({ id: "android-foundation-navigation-missing" }),
      expect.objectContaining({ id: "android-foundation-room-dependency-missing" }),
    ]));
  });

  it("validates Apple app icon Contents.json and listed PNGs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-apple-icon-"));
    mkdirSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    for (const file of ["iphone.png", "ipad.png", "marketing.png"]) {
      writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset", file), "png");
    }
    writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({
      images: [
        { idiom: "iphone", filename: "iphone.png" },
        { idiom: "ipad", filename: "ipad.png" },
        { idiom: "ios-marketing", filename: "marketing.png" },
      ],
    }));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
        "App/Assets.xcassets/AppIcon.appiconset/iphone.png",
        "App/Assets.xcassets/AppIcon.appiconset/ipad.png",
        "App/Assets.xcassets/AppIcon.appiconset/marketing.png",
      ],
      verification: [
        "Verification: validate_apple_app_icon_set -> passed",
        "Verification: xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator' -> passed",
      ],
    }, {
      task: { kind: "coding", title: "Create App Icon - iOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
  });

  it("requires xcodebuild build verification for Apple app icon tasks", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-apple-icon-build-"));
    mkdirSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    for (const file of ["iphone.png", "ipad.png", "marketing.png"]) {
      writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset", file), "png");
    }
    writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({
      images: [
        { idiom: "iphone", filename: "iphone.png" },
        { idiom: "ipad", filename: "ipad.png" },
        { idiom: "ios-marketing", filename: "marketing.png" },
      ],
    }));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
        "App/Assets.xcassets/AppIcon.appiconset/iphone.png",
        "App/Assets.xcassets/AppIcon.appiconset/ipad.png",
        "App/Assets.xcassets/AppIcon.appiconset/marketing.png",
      ],
      verification: ["Verification: validate_apple_app_icon_set -> passed"],
    }, {
      task: { kind: "coding", title: "Create App Icon - iOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "apple-app-icon-xcodebuild-missing" }),
    ]));
  });

  it("detects Portuguese Apple app icon prompts from the raw validation prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-apple-icon-portuguese-"));
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    for (const file of ["iphone.png", "ipad.png", "marketing.png"]) {
      writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/AppIcon.appiconset", file), "png");
    }
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({
      images: [
        { idiom: "iphone", filename: "iphone.png" },
        { idiom: "ipad", filename: "ipad.png" },
        { idiom: "ios-marketing", filename: "marketing.png" },
      ],
    }));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "CosaNostra/Assets.xcassets/AppIcon.appiconset/Contents.json",
        "CosaNostra/Assets.xcassets/AppIcon.appiconset/iphone.png",
        "CosaNostra/Assets.xcassets/AppIcon.appiconset/ipad.png",
        "CosaNostra/Assets.xcassets/AppIcon.appiconset/marketing.png",
      ],
      verification: ["Verification: validate_apple_app_icon_set -> passed"],
    }, {
      task: { kind: "coding", title: "Criar Ícone do App" },
      expected_report: { verification: true },
      metadata: {
        validationPrompt: "Create Assets.xcassets/AppIcon.appiconset/ with the icon for iOS and macOS. Verify with xcodebuild.",
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "apple-app-icon-xcodebuild-missing" }),
    ]));
  });

  it("requires macOS Apple app icon slots when the task asks for macOS", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-apple-icon-mac-"));
    mkdirSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    for (const file of ["iphone.png", "ipad.png", "marketing.png"]) {
      writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset", file), "png");
    }
    writeFileSync(join(cwd, "App/Assets.xcassets/AppIcon.appiconset/Contents.json"), JSON.stringify({
      images: [
        { idiom: "iphone", size: "60x60", filename: "iphone.png" },
        { idiom: "ipad", size: "76x76", filename: "ipad.png" },
        { idiom: "ios-marketing", size: "1024x1024", filename: "marketing.png" },
      ],
    }));

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "App/Assets.xcassets/AppIcon.appiconset/Contents.json",
        "App/Assets.xcassets/AppIcon.appiconset/iphone.png",
        "App/Assets.xcassets/AppIcon.appiconset/ipad.png",
        "App/Assets.xcassets/AppIcon.appiconset/marketing.png",
      ],
      verification: [
        "Verification: validate_apple_app_icon_set -> passed",
        "Verification: xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator' -> passed",
      ],
    }, {
      task: { kind: "coding", title: "Create App Icon - iOS and macOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "apple-app-icon-mac-size-missing" }),
      expect.objectContaining({ id: "apple-app-icon-mac-slots-incomplete" }),
    ]));
  });

  it("rejects iOS onboarding when skip is in the bottom stack and final page is not a CTA slide", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-onboarding-"));
    mkdirSync(join(cwd, "App/Views"), { recursive: true });
    writeFileSync(join(cwd, "App/Views/OnboardingView.swift"), [
      "import SwiftUI",
      "struct OnboardingView: View {",
      "  @AppStorage(\"hasSeenOnboarding\") private var hasSeenOnboarding = false",
      "  @State private var currentPage = 0",
      "  private let totalPages = 4",
      "  private let slides = [",
      "    (title: \"Bem-vindo\", subtitle: \"Intro\"),",
      "    (title: \"Busca Avançada\", subtitle: \"Feature\"),",
      "    (title: \"Métricas\", subtitle: \"Feature\"),",
      "    (title: \"Alertas Personalizados\", subtitle: \"Feature\")",
      "  ]",
      "  var body: some View {",
      "    ZStack {",
      "      TabView(selection: $currentPage) { Text(\"slide\") }.tabViewStyle(.page(indexDisplayMode: .never))",
      "      VStack {",
      "        Spacer()",
      "        if currentPage < totalPages - 1 { Button(\"Pular\") { currentPage = totalPages - 1 } }",
      "        Button(\"Começar grátis\") { hasSeenOnboarding = true }",
      "        Button(\"Já tenho conta\") { hasSeenOnboarding = true }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["App/Views/OnboardingView.swift"],
      verification: ["Verification: xcodebuild build -> passed"],
    }, {
      task: { kind: "coding", title: "Onboarding — iOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "ios-onboarding-skip-not-top-right" }),
      expect.objectContaining({ id: "ios-onboarding-final-cta-slide-missing" }),
    ]));
  });

  it("rejects Android onboarding when the final pager page is not CTA and key is snake_case", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-onboarding-"));
    mkdirSync(join(cwd, "app/src/main/java/com/example/ui/onboarding"), { recursive: true });
    mkdirSync(join(cwd, "app/src/main/java/com/example/data"), { recursive: true });
    writeFileSync(join(cwd, "gradlew"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(cwd, "app/src/main/java/com/example/ui/onboarding/OnboardingScreen.kt"), [
      "package test",
      "data class OnboardingPage(val title: String, val subtitle: String)",
      "val pages = listOf(",
      "  OnboardingPage(title = \"Bem-vindo\", subtitle = \"Intro\"),",
      "  OnboardingPage(title = \"Busca\", subtitle = \"Feature\"),",
      "  OnboardingPage(title = \"Métricas\", subtitle = \"Feature\"),",
      "  OnboardingPage(title = \"Organização e Favoritos\", subtitle = \"Feature\"),",
      ")",
      "@Composable fun OnboardingScreen() {",
      "  HorizontalPager(pageCount = pages.size) {}",
      "  TextButton(onClick = {}) { Text(\"Pular\") }",
      "  Button(onClick = {}) { Text(\"Começar grátis\") }",
      "  TextButton(onClick = {}) { Text(\"Já tenho conta\") }",
      "}",
    ].join("\n"));
    writeFileSync(join(cwd, "app/src/main/java/com/example/data/OnboardingDataStore.kt"), "val key = booleanPreferencesKey(\"has_seen_onboarding\")\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: [
        "app/src/main/java/com/example/ui/onboarding/OnboardingScreen.kt",
        "app/src/main/java/com/example/data/OnboardingDataStore.kt",
      ],
      verification: ["Verification: ./gradlew assembleDebug --no-daemon -> passed"],
    }, {
      task: { kind: "coding", title: "Onboarding — Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "android-onboarding-final-cta-slide-missing" }),
      expect.objectContaining({ id: "android-onboarding-storage-key-missing" }),
    ]));
  });

  it("flags Android app icon tasks without mipmap launcher PNGs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-android-icon-"));

    const result = await validateCodingTask(cwd, {
      changedFiles: ["app/src/main/res/drawable/ic_launcher.png"],
      verification: ["Verification: validate_android_launcher_icon_set -> failed"],
    }, {
      task: { kind: "coding", title: "Create App Icon - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "android-app-icon-mipmap-pngs-missing" }),
    ]));
  });

  it("validates iOS setup environment files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-ios-setup-"));
    mkdirSync(join(cwd, "fastlane"), { recursive: true });
    writeFileSync(join(cwd, "fastlane/Fastfile"), "default_platform(:ios)\nplatform :ios do\n  lane :build do\n  end\nend\n");
    writeFileSync(join(cwd, ".swiftlint.yml"), "disabled_rules: []\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: ["fastlane/Fastfile", ".swiftlint.yml"],
      verification: ["Verification: fastlane ios build -> passed"],
    }, {
      task: { kind: "coding", title: "Setup Environment - iOS" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(true);
  });

  it("flags insecure auth token storage", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-validators-auth-"));
    writeFileSync(join(cwd, "AuthSessionStore.kt"), "class AuthSessionStore { fun save(token: String) { SharedPreferences.Editor().putString(\"token\", token) } }\n");

    const result = await validateCodingTask(cwd, {
      changedFiles: ["AuthSessionStore.kt"],
      verification: ["Verification: ./gradlew test -> passed"],
    }, {
      task: { kind: "coding", title: "Auth Session - Android" },
      expected_report: { verification: true },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "auth-session-insecure-storage" }),
    ]));
  });

  describe("backend auth-posture validator", () => {
    it("flags endpoints in api_features.md missing auth-posture declaration", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-undecl-"));
      mkdirSync(join(cwd, "backend"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        `# API Features\n\n## /api/cases\n\nList legal cases.\n\n## /api/judges\n\nList judges.\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: [],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("auth-posture-undeclared");
      expect(result.issues.filter((i) => i.id === "auth-posture-undeclared").length).toBeGreaterThanOrEqual(2);
    });

    it("flags a route declared authenticated-read but missing withAuth", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-missing-withauth-"));
      mkdirSync(join(cwd, "backend/app/api/users"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        `# API\n\n## /api/users\n\n- auth-posture: authenticated-read\n\nList users.\n`,
      );
      writeFileSync(
        join(cwd, "backend/app/api/users/route.ts"),
        `export async function GET() { return Response.json({ items: [] }); }\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: ["app/api/users/route.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("auth-posture-missing-withauth");
    });

    it("does not flag a route correctly using withAuth for authenticated posture", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-correct-"));
      mkdirSync(join(cwd, "backend/app/api/users"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        `# API\n\n## /api/users\n\n- auth-posture: authenticated-read\n\n`,
      );
      writeFileSync(
        join(cwd, "backend/app/api/users/route.ts"),
        `import { withAuth } from "@/middleware/auth";\nexport const GET = withAuth(async () => Response.json({}));\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: ["app/api/users/route.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).not.toContain("auth-posture-missing-withauth");
    });

    it("flags an owner-only route that uses withAuth but doesn't filter by userId", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-owner-no-scope-"));
      mkdirSync(join(cwd, "backend/app/api/bookmarks"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        `# API\n\n## /api/bookmarks\n\n- auth-posture: owner-only\n`,
      );
      writeFileSync(
        join(cwd, "backend/app/api/bookmarks/route.ts"),
        `import { withAuth } from "@/middleware/auth";\nexport const GET = withAuth(async () => prisma.bookmark.findMany());\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: ["app/api/bookmarks/route.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("auth-posture-owner-only-missing-ownership-check");
    });

    it("warns about a public-read route that still wraps in withAuth (contract drift)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-public-with-auth-"));
      mkdirSync(join(cwd, "backend/app/api/cases"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        `# API\n\n## /api/cases\n\n- auth-posture: public-read\n`,
      );
      writeFileSync(
        join(cwd, "backend/app/api/cases/route.ts"),
        `import { withAuth } from "@/middleware/auth";\nexport const GET = withAuth(async () => prisma.case.findMany());\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: ["app/api/cases/route.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      expect(ids).toContain("auth-posture-public-read-with-auth");
    });

    it("parses bullet-style endpoints with /api stripped (sample format)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "tanya-auth-posture-bullet-"));
      mkdirSync(join(cwd, "backend/app/api/cases"), { recursive: true });
      mkdirSync(join(cwd, "backend/app/api/alerts"), { recursive: true });
      mkdirSync(join(cwd, "brand"), { recursive: true });
      writeFileSync(
        join(cwd, "brand/api_features.md"),
        [
          "# Cosa Nostra API",
          "",
          "## Base URL",
          "`/api`",
          "",
          "## Cases",
          "- `GET /cases` — auth-posture: public-read. Paginated search.",
          "",
          "## Alerts",
          "- `GET /alerts` — auth-posture: owner-only. List the user's alerts.",
          "- `POST /alerts` — auth-posture: owner-only. Create an alert.",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(cwd, "backend/app/api/cases/route.ts"),
        `export const GET = async () => Response.json({ items: [] });\n`,
      );
      writeFileSync(
        join(cwd, "backend/app/api/alerts/route.ts"),
        `export const GET = async () => prisma.alert.findMany();\n`,
      );
      const workspace = join(cwd, "backend");
      const result = await validateCodingTask(workspace, {
        changedFiles: ["app/api/cases/route.ts", "app/api/alerts/route.ts"],
        verification: ["Verification: npm test -> passed"],
      }, {
        task: { kind: "coding", title: "Fundações — Backend" },
        expected_report: { verification: true },
      });
      const ids = result.issues.map((i) => i.id);
      // /cases is public-read with no withAuth → no missing-withauth issue
      expect(ids).not.toContain("auth-posture-missing-withauth");
      // /alerts is owner-only without withAuth → must flag
      expect(ids).toContain("auth-posture-owner-only-missing-withauth");
      // No undeclared endpoints (all bullets had inline posture)
      expect(ids).not.toContain("auth-posture-undeclared");
    });
  });
});

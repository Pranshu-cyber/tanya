import type { TanyaRunContext } from "../../context/runContext";
import {
  constraintText,
  findWorkspaceFiles,
  hasChanged,
  inferPrimaryPlatform,
  readWorkspaceFile,
  uniqueSorted,
  workspaceFileExists,
  type ValidationIssue,
  type ValidationManifest,
} from "./core";

export async function validateGoBackendConfigEnvConsistency(workspace: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const envExample = await readWorkspaceFile(workspace, ".env.example");
  if (!envExample) return [];

  const configFiles = await findWorkspaceFiles(
    workspace,
    (filePath) => /(?:^|\/)internal\/config\/.*\.go$/.test(filePath) || /(?:^|\/)config\.go$/.test(filePath),
    { roots: ["internal", "."], limit: 20 },
  );
  if (configFiles.length === 0) return [];

  const configText = (await Promise.all(
    configFiles.map(async (filePath) => await readWorkspaceFile(workspace, filePath) ?? ""),
  )).join("\n");
  const configKeys = uniqueSorted(
    [...configText.matchAll(/\b(?:envOr|envDuration|parseIntOr|parseDurationOr|os\.Getenv)\(\s*"([A-Z][A-Z0-9_]*)"/g)]
      .map((match) => match[1] ?? ""),
  );
  if (configKeys.length === 0) return [];

  const exampleKeys = new Set(
    [...envExample.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1] ?? ""),
  );
  const missing = configKeys.filter((key) => !exampleKeys.has(key));
  for (const key of missing) {
    issues.push({
      id: "backend-config-env-example-key-missing",
      severity: "error",
      message: `internal/config reads ${key}, but .env.example does not document that exact key. Keep Config.Load and .env.example names identical.`,
      files: [".env.example", ...configFiles.slice(0, 3)],
    });
  }

  return issues;
}

export async function validateGoBackendAuthQuality(workspace: string, manifest: ValidationManifest, runContext?: TanyaRunContext): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const text = constraintText(runContext);
  const isBackendWorkspace = inferPrimaryPlatform(workspace) === "backend" || /(?:^|\/)backend(?:\/|$)/.test(workspace);
  const authTask = /\b(auth|authentication|jwe|nextauth|refresh\s+token|sign-?in|sign-?out)\b/i.test(text);
  const touchedAuth = hasChanged(manifest, /(?:^|\/)internal\/auth\/.*\.go$/) ||
    hasChanged(manifest, /(?:^|\/)internal\/handlers\/auth(?:_test)?\.go$/) ||
    hasChanged(manifest, /(?:^|\/)sql\/queries\/refresh_tokens\.sql$/);
  if (!isBackendWorkspace || (!authTask && !touchedAuth)) return [];

  const discoveredAuthFiles = await findWorkspaceFiles(
    workspace,
    (filePath) => /(?:^|\/)internal\/(?:auth\/.*\.go|handlers\/auth(?:_test)?\.go)$/.test(filePath) ||
      /(?:^|\/)sql\/queries\/refresh_tokens\.sql$/.test(filePath),
    { roots: ["internal", "sql"], limit: 80 },
  );
  const candidateFiles = uniqueSorted([
    ...manifest.changedFiles.filter((file) =>
      /(?:^|\/)internal\/(?:auth\/.*\.go|handlers\/auth(?:_test)?\.go)$/.test(file) ||
      /(?:^|\/)sql\/queries\/refresh_tokens\.sql$/.test(file)
    ),
    ...discoveredAuthFiles,
  ]);

  const testFiles = candidateFiles.filter((file) => /(?:^|\/)internal\/(?:auth|handlers)\/.*_test\.go$/.test(file));
  const handlerTestFiles = testFiles.filter((file) => /(?:^|\/)internal\/handlers\/.*_test\.go$/.test(file));
  const authTestFiles = testFiles.filter((file) => /(?:^|\/)internal\/auth\/.*_test\.go$/.test(file));
  const sourceFiles = candidateFiles.filter((file) => /(?:^|\/)internal\/handlers\/auth\.go$/.test(file));

  const handlerTests = (await Promise.all(handlerTestFiles.map(async (file) => await readWorkspaceFile(workspace, file) ?? ""))).join("\n");
  const authTests = (await Promise.all(authTestFiles.map(async (file) => await readWorkspaceFile(workspace, file) ?? ""))).join("\n");
  const authSources = (await Promise.all(sourceFiles.map(async (file) => await readWorkspaceFile(workspace, file) ?? ""))).join("\n");

  if (/RegisterPublicAuth\s*\([\s\S]{0,240},\s*nil\s*,/m.test(handlerTests) || /\bnil\s+pool\b/i.test(handlerTests)) {
    issues.push({
      id: "go-auth-test-nil-pool",
      severity: "error",
      message: "Go auth route tests must not pass a nil *pgxpool.Pool or skip refresh because the pool is nil. Use a real test pool/harness so transaction paths execute.",
      files: handlerTestFiles,
    });
  }

  if (/verified\s+by\s+code\s+review|comments?-only|manual\s+review\s+test/i.test(handlerTests)) {
    issues.push({
      id: "go-auth-comments-only-test",
      severity: "error",
      message: "Go auth tests must assert runtime behavior. Do not use comments, t.Log, or 'verified by code review' as test evidence.",
      files: handlerTestFiles,
    });
  }

  const hasRefreshRouteMention = /["'`]\/(?:v1\/)?auth\/refresh["'`]/.test(handlerTests);
  const hasRefreshHTTPExercise =
    /(?:httptest\.NewRequest|http\.NewRequest|NewRequest)\s*\([\s\S]{0,500}["'`]\/(?:v1\/)?auth\/refresh["'`][\s\S]{0,1200}(?:ServeHTTP|Do\s*\(|RoundTrip)/m.test(handlerTests) ||
    /["'`]\/(?:v1\/)?auth\/refresh["'`][\s\S]{0,1200}(?:ServeHTTP|Do\s*\(|RoundTrip)/m.test(handlerTests);
  if (handlerTestFiles.length > 0 && (!hasRefreshRouteMention || !hasRefreshHTTPExercise)) {
    issues.push({
      id: "go-auth-refresh-http-test-missing",
      severity: "error",
      message: "Go auth work must include a real HTTP/handler test for POST /v1/auth/refresh. OpenAPI/spec-only checks do not prove refresh rotation, expiry, or reuse behavior.",
      files: handlerTestFiles,
    });
  }

  const registerMatch = authSources.match(/func\s+registerRegister\s*\([^)]*\)\s*\{[\s\S]*?(?=\nfunc\s+register|\n\/\/\s*-{3,}|\nfunc\s+Register|$)/);
  const registerBody = registerMatch?.[0] ?? "";
  if (registerBody && /\bCreateUser\b/.test(registerBody) && /\b(?:CreateRefreshToken|issuer\.Issue|Issue\s*\()/.test(registerBody) && !/\b(?:WithTx|Begin|db\.WithTx)\b/.test(registerBody)) {
    issues.push({
      id: "go-auth-register-not-transactional",
      severity: "error",
      message: "Registration creates a user and first refresh token without a transaction. User creation and initial refresh-token persistence must commit or roll back together.",
      files: sourceFiles,
    });
  }

  const hasJWEImplementation = candidateFiles.some((file) => /(?:^|\/)internal\/auth\/jwe\.go$/.test(file)) ||
    await workspaceFileExists(workspace, "internal/auth/jwe.go");
  const hasJWEFixture = /\b(?:fixture|golden|known\s+token|jose|nextauth|NextAuth\.js|generated\s+by\s+nextauth)\b/i.test(authTests);
  const hasOnlyRoundTripEvidence = /\b(?:SignForTest|Encrypt|Issue|DecodeNextAuthJWE|round[-\s]?trip)\b/i.test(authTests);
  if (hasJWEImplementation && authTestFiles.length > 0 && hasOnlyRoundTripEvidence && !hasJWEFixture) {
    issues.push({
      id: "go-auth-nextauth-fixture-missing",
      severity: "error",
      message: "JWE tests must include a fixed NextAuth/Jose-compatible fixture. A Go sign/decode round trip only proves internal symmetry, not NextAuth compatibility.",
      files: authTestFiles,
    });
  }

  return issues;
}

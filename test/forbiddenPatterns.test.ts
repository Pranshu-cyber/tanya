import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForbiddenPatterns } from "../src/agent/forbiddenPatterns";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "tanya-forbidden-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(relPath: string, content: string) {
  const full = join(workspace, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("scanForbiddenPatterns", () => {
  it("flags HttpLoggingInterceptor.Level.BODY in production Kotlin", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/data/ApiClient.kt",
      `package com.cosmohq.data\nimport okhttp3.logging.HttpLoggingInterceptor\nval logger = HttpLoggingInterceptor().apply {\n    level = HttpLoggingInterceptor.Level.BODY\n}\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/data/ApiClient.kt",
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.id).toBe("android-http-logging-body");
    expect(issues[0]!.severity).toBe("error");
  });

  it("does not flag Level.BODY inside test directories", async () => {
    write(
      "android/app/src/androidTest/java/com/cosmohq/data/ApiClientTest.kt",
      `level = HttpLoggingInterceptor.Level.BODY\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/androidTest/java/com/cosmohq/data/ApiClientTest.kt",
    ]);
    expect(issues).toHaveLength(0);
  });

  it("flags commented Google Sign In stub in iOS LoginView.swift", async () => {
    write(
      "ios/CosaNostra/LoginView.swift",
      `import SwiftUI\n// MARK: - Google Sign In (optional)\n// Uncomment when Google Sign In SDK is configured\n// GoogleSignInButton()\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/LoginView.swift"]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.id === "ios-google-signin-stub")).toBe(true);
  });

  it("does not flag a fully implemented GoogleSignIn call", async () => {
    write(
      "ios/CosaNostra/LoginView.swift",
      `import GoogleSignIn\nlet result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/LoginView.swift"]);
    expect(issues).toHaveLength(0);
  });

  it("flags console.log of accessToken", async () => {
    write(
      "backend/lib/auth.ts",
      `export function logAuth(token: string) { console.log("got accessToken", accessToken); }\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["backend/lib/auth.ts"]);
    expect(issues.some((i) => i.id === "leaked-token-console-log")).toBe(true);
  });

  it("returns empty for clean files", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/data/ApiClient.kt",
      `level = HttpLoggingInterceptor.Level.NONE\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/data/ApiClient.kt",
    ]);
    expect(issues).toHaveLength(0);
  });

  it("flags dangerouslySetInnerHTML without sanitizer", async () => {
    write(
      "src/components/Card.tsx",
      `export function Card({html}: {html: string}) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />\n}\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["src/components/Card.tsx"]);
    expect(issues.some((i) => i.id === "react-dangerouslysetinnerhtml-without-sanitizer")).toBe(true);
  });

  it("does not flag dangerouslySetInnerHTML wrapped with DOMPurify", async () => {
    write(
      "src/components/Card.tsx",
      `import DOMPurify from "dompurify";\nexport function Card({html}: {html: string}) {\n  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />\n}\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["src/components/Card.tsx"]);
    expect(issues.some((i) => i.id === "react-dangerouslysetinnerhtml-without-sanitizer")).toBe(false);
  });

  it("flags eval()", async () => {
    write("src/lib/dynamic.ts", `export function run(code: string) { return eval(code); }\n`);
    const issues = await scanForbiddenPatterns(workspace, ["src/lib/dynamic.ts"]);
    expect(issues.some((i) => i.id === "javascript-eval")).toBe(true);
  });

  it("does not flag method-name eval like obj.eval()", async () => {
    write("src/lib/x.ts", `myObject.eval(\"foo\");\n`);
    const issues = await scanForbiddenPatterns(workspace, ["src/lib/x.ts"]);
    expect(issues.some((i) => i.id === "javascript-eval")).toBe(false);
  });

  it("flags hardcoded Bearer JWT", async () => {
    write(
      "src/lib/api.ts",
      `const headers = { Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.example.sig" };\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["src/lib/api.ts"]);
    expect(issues.some((i) => i.id === "hardcoded-bearer-token")).toBe(true);
  });

  it("flags storing access tokens in plain SharedPreferences", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/data/PlainStore.kt",
      `val prefs = context.getSharedPreferences("auth", 0)\nprefs.edit().putString("accessToken", token).apply()\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/data/PlainStore.kt",
    ]);
    expect(issues.some((i) => i.id === "android-plain-shared-preferences-for-tokens")).toBe(true);
  });

  it("verification-only run still scans committed files when caller passes them in", async () => {
    // The motivating bug: agent committed Level.BODY in a prior attempt; the
    // current verification-only attempt has changedFiles: []. The gate must
    // still flag the violation if caller passes the committed file list.
    write(
      "android/app/src/main/java/com/cosmohq/auth/AuthRepository.kt",
      `import okhttp3.logging.HttpLoggingInterceptor\nval logging = HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BODY }\n`,
    );
    const issuesIfNotScanned = await scanForbiddenPatterns(workspace, []);
    expect(issuesIfNotScanned).toHaveLength(0);
    const issuesWhenScanned = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/auth/AuthRepository.kt",
    ]);
    expect(issuesWhenScanned.some((i) => i.id === "android-http-logging-body")).toBe(true);
  });

  it("records fire-counter metrics to .tanya/memory/forbidden-patterns-metrics.json", async () => {
    const apiClient = "android/app/src/main/java/com/cosmohq/data/ApiClient.kt";
    write(apiClient, `level = HttpLoggingInterceptor.Level.BODY\n`);
    await scanForbiddenPatterns(workspace, [apiClient]);
    const metricsPath = join(workspace, ".tanya", "memory", "forbidden-patterns-metrics.json");
    expect(existsSync(metricsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(metricsPath, "utf8"));
    expect(parsed.totals["android-http-logging-body"]).toBe(1);
    expect(typeof parsed.lastFiredAt["android-http-logging-body"]).toBe("string");
    expect(parsed.totalScans).toBe(1);

    // Second scan increments existing counters
    await scanForbiddenPatterns(workspace, [apiClient]);
    const parsed2 = JSON.parse(readFileSync(metricsPath, "utf8"));
    expect(parsed2.totals["android-http-logging-body"]).toBe(2);
    expect(parsed2.totalScans).toBe(2);
  });

  it("does not write metrics file when no patterns fire", async () => {
    write("android/app/src/main/java/Clean.kt", `level = HttpLoggingInterceptor.Level.NONE\n`);
    await scanForbiddenPatterns(workspace, ["android/app/src/main/java/Clean.kt"]);
    const metricsPath = join(workspace, ".tanya", "memory", "forbidden-patterns-metrics.json");
    expect(existsSync(metricsPath)).toBe(false);
  });

  it("flags '// TODO: Send email via Brevo' in an auth route handler (2026-05-01 audit gap)", async () => {
    write(
      "backend/app/api/auth/password/request-reset/route.ts",
      `if (process.env.BREVO_API_KEY) {\n  // TODO: Send email via Brevo API\n}\nreturn ok({ message: 'sent' });`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["backend/app/api/auth/password/request-reset/route.ts"]);
    expect(issues.some((i) => i.id === "stub-todo-in-auth-or-billing-route")).toBe(true);
  });

  it("flags '// FIXME: implement Stripe webhook' in a billing route", async () => {
    write(
      "backend/app/api/webhooks/stripe/route.ts",
      `// FIXME: implement Stripe webhook signature verification\nreturn ok({});`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["backend/app/api/webhooks/stripe/route.ts"]);
    expect(issues.some((i) => i.id === "stub-todo-in-auth-or-billing-route")).toBe(true);
  });

  it("does NOT flag a TODO in a non-security route", async () => {
    write(
      "backend/app/api/cases/route.ts",
      `// TODO: add pagination cursor support\nreturn ok({ items: [] });`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["backend/app/api/cases/route.ts"]);
    expect(issues.some((i) => i.id === "stub-todo-in-auth-or-billing-route")).toBe(false);
  });

  it("does NOT flag a TODO that isn't a stub-implementation", async () => {
    write(
      "backend/app/api/auth/me/route.ts",
      `// TODO: rename this to /profile in v2\nreturn ok({ user });`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["backend/app/api/auth/me/route.ts"]);
    expect(issues.some((i) => i.id === "stub-todo-in-auth-or-billing-route")).toBe(false);
  });

  it("flags empty / placeholder onSubscribeClick in Kotlin (2026-05-01 audit gap)", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/cosanostra/navigation/AppNavigation.kt",
      `PaywallScreen(\n  onDismiss = { showPaywall = false },\n  onSubscribeClick = { /* RevenueCat integration placeholder */ },\n)`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/cosanostra/navigation/AppNavigation.kt",
    ]);
    expect(issues.some((i) => i.id === "android-paywall-empty-callback")).toBe(true);
  });

  it("does not flag onSubscribeClick wired to billing.purchase()", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/cosanostra/navigation/AppNavigation.kt",
      `onSubscribeClick = { billing.purchase(activity, product) }`,
    );
    const issues = await scanForbiddenPatterns(workspace, [
      "android/app/src/main/java/com/cosmohq/cosanostra/navigation/AppNavigation.kt",
    ]);
    expect(issues.some((i) => i.id === "android-paywall-empty-callback")).toBe(false);
  });

  it("flags `Purchases.logLevel = .debug` unconditionally in iOS Swift (2026-05-01 audit gap)", async () => {
    write(
      "ios/CosaNostra/RevenueCatManager.swift",
      `import RevenueCat\nfunc configure() {\n  Purchases.configure(withAPIKey: key)\n  Purchases.logLevel = .debug\n}\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/RevenueCatManager.swift"]);
    const hit = issues.find((i) => i.id === "ios-purchases-loglevel-debug");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("error");
  });

  it("does not flag `Purchases.logLevel = .info` in iOS Swift", async () => {
    write(
      "ios/CosaNostra/RevenueCatManager.swift",
      `Purchases.logLevel = .info\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/RevenueCatManager.swift"]);
    expect(issues.some((i) => i.id === "ios-purchases-loglevel-debug")).toBe(false);
  });

  it("flags YOUR_WEB_CLIENT_ID_HERE in Android strings.xml (2026-05-01 audit gap)", async () => {
    write(
      "android/app/src/main/res/values/strings.xml",
      `<resources><string name="default_web_client_id" translatable="false">YOUR_WEB_CLIENT_ID_HERE</string></resources>`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["android/app/src/main/res/values/strings.xml"]);
    expect(issues.some((i) => i.id === "android-missing-google-client-id-literal")).toBe(true);
  });

  it("flags TODO-REPLACE-WITH-PRODUCTION-PINNED-HASH in Swift (2026-05-01 audit gap)", async () => {
    write(
      "ios/CosaNostra/SessionStore.swift",
      `private let pinnedHashes = [\n  "TODO-REPLACE-WITH-PRODUCTION-PINNED-HASH-1",\n  "TODO-REPLACE-WITH-PRODUCTION-PINNED-HASH-2"\n]`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/SessionStore.swift"]);
    expect(issues.some((i) => i.id === "ios-todo-replace-pinned-hash")).toBe(true);
  });

  it("does not flag a valid SHA-256 pin hash", async () => {
    write(
      "ios/CosaNostra/SessionStore.swift",
      `private let pinnedHashes = [\n  "0jZQK9WhAa7CnNPS6/y8DZJSWBdzILMGUsQ1Iu8SkP4=",\n  "rL4jVDb1xWg6+0ZX7IWLOLzWl08gv0VGKiVvwJk7XnY="\n]`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/SessionStore.swift"]);
    expect(issues.some((i) => i.id === "ios-todo-replace-pinned-hash")).toBe(false);
  });

  it("does not flag .debug when wrapped in #if DEBUG/#else/.error/#endif", async () => {
    write(
      "ios/CosaNostra/RevenueCatManager.swift",
      [
        "import RevenueCat",
        "func configure() {",
        "    Purchases.configure(withAPIKey: key)",
        "#if DEBUG",
        "    Purchases.logLevel = .debug",
        "#else",
        "    Purchases.logLevel = .error",
        "#endif",
        "}",
      ].join("\n"),
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/RevenueCatManager.swift"]);
    expect(issues.some((i) => i.id === "ios-purchases-loglevel-debug")).toBe(false);
  });

  it("flags RoundedRectangle in iOS feature screen (rolled-own primitive)", async () => {
    write(
      "ios/CosaNostra/DashboardScreen.swift",
      `RoundedRectangle(cornerRadius: 12).fill(Color.red)\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/DashboardScreen.swift"]);
    expect(issues.some((i) => i.id === "ios-rolled-own-rounded-rect")).toBe(true);
  });

  it("does not flag RoundedRectangle in BrandedComponents.swift (where it belongs)", async () => {
    write(
      "ios/CosaNostra/BrandedComponents.swift",
      `RoundedRectangle(cornerRadius: 16).fill(Theme.surface)\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["ios/CosaNostra/BrandedComponents.swift"]);
    expect(issues.some((i) => i.id === "ios-rolled-own-rounded-rect")).toBe(false);
  });

  it("flags Card(modifier=...) in Android feature screen (rolled-own primitive)", async () => {
    write(
      "android/app/src/main/java/com/cosmohq/cosanostra/ui/features/AlertsScreen.kt",
      `Card(modifier = Modifier.padding(16.dp)) { Text("Alert") }\n`,
    );
    const issues = await scanForbiddenPatterns(workspace, ["android/app/src/main/java/com/cosmohq/cosanostra/ui/features/AlertsScreen.kt"]);
    expect(issues.some((i) => i.id === "android-rolled-own-card")).toBe(true);
  });

  it("flags `prisma db push` inside a Dockerfile", async () => {
    write("Dockerfile", "FROM node:22\nCMD prisma db push && npm start\n");
    const issues = await scanForbiddenPatterns(workspace, ["Dockerfile"]);
    expect(issues.some((i) => i.id === "backend-prisma-db-push-in-deploy")).toBe(true);
  });

  it("flags `|| true` after prisma migrate in a Dockerfile (silent drift)", async () => {
    write("Dockerfile", "FROM node:22\nCMD sh -c 'npx prisma migrate deploy || true; exec npm start'\n");
    const issues = await scanForbiddenPatterns(workspace, ["Dockerfile"]);
    expect(issues.some((i) => i.id === "backend-silent-db-failure-in-boot")).toBe(true);
  });

  it("flags prisma output redirected to /tmp (hidden from log streams)", async () => {
    write("Dockerfile", "FROM node:22\nCMD sh -c 'npx prisma migrate deploy > /tmp/prisma.log 2>&1; npm start'\n");
    const issues = await scanForbiddenPatterns(workspace, ["Dockerfile"]);
    expect(issues.some((i) => i.id === "backend-db-bootstrap-redirected-to-tmp")).toBe(true);
  });

  it("flags Dockerfile that runs npm ci before COPY prisma/", async () => {
    write("Dockerfile", [
      "FROM node:22",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "RUN npm ci --omit=dev",
      "COPY prisma ./prisma/",
    ].join("\n"));
    const issues = await scanForbiddenPatterns(workspace, ["Dockerfile"]);
    expect(issues.some((i) => i.id === "backend-prisma-postinstall-without-schema")).toBe(true);
  });

  it("does not flag a Dockerfile that copies prisma/ before npm ci", async () => {
    write("Dockerfile", [
      "FROM node:22",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "COPY prisma ./prisma/",
      "RUN npm ci --omit=dev",
    ].join("\n"));
    const issues = await scanForbiddenPatterns(workspace, ["Dockerfile"]);
    expect(issues.some((i) => i.id === "backend-prisma-postinstall-without-schema")).toBe(false);
  });

  it("flags lib/email.ts that puts process.env.FROM_EMAIL straight into sender.email (Brevo rejects)", async () => {
    write("lib/email.ts", [
      "const fromEmail = process.env.FROM_EMAIL || 'a@b.com';",
      "await fetch('https://api.brevo.com/v3/smtp/email', { body: JSON.stringify({ sender: { name: 'X', email: fromEmail } }) });",
    ].join("\n"));
    const issues = await scanForbiddenPatterns(workspace, ["lib/email.ts"]);
    expect(issues.some((i) => i.id === "backend-from-email-rfc822-passed-to-provider")).toBe(true);
  });

  it("loads project-level forbidden patterns from .tanya/forbidden-patterns.json", async () => {
    write(
      ".tanya/forbidden-patterns.json",
      JSON.stringify({
        patterns: [
          {
            id: "project-no-foo-import",
            pattern: 'from\\s+["\'\\u0060]foo["\'\\u0060]',
            filePattern: "\\.ts$",
            message: "do not import from foo (project rule)",
            severity: "error",
          },
        ],
      }),
    );
    write("src/uses-foo.ts", `import { bar } from "foo";\n`);
    const issues = await scanForbiddenPatterns(workspace, ["src/uses-foo.ts"]);
    expect(issues.some((i) => i.id === "project-no-foo-import")).toBe(true);
  });
});

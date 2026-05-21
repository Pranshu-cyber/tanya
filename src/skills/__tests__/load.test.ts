import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillPacks, loadSkillPacksFromRoot } from "../load";
import type { SkillPackContext } from "../types";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function write(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function pack(
  title: string,
  slug: string,
  options: { priority?: number; loadWhen?: string; body?: string } = {},
): string {
  return [
    "---",
    `slug: ${slug}`,
    `title: ${title}`,
    "loadWhen:",
    options.loadWhen ?? "  - kind: workspace.has\n    path: never-present",
    "sizeTarget: 100",
    `priority: ${options.priority ?? 5}`,
    "---",
    "",
    `# ${title}`,
    "",
    options.body ?? "Body.",
  ].join("\n");
}

function baseContext(workspace: string, overrides: Partial<SkillPackContext> = {}): SkillPackContext {
  return {
    workspace,
    hints: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("loadSkillPacks", () => {
  it("loads the production skills tree without requiring a matching workspace", () => {
    const workspace = makeTempRoot("tanya-skills-empty-workspace-");
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", join(makeTempRoot("tanya-skills-integrations-"), "missing"));

    const loaded = loadSkillPacks(baseContext(workspace));

    expect(loaded).toHaveLength(6);
    expect(loaded.map((skill) => skill.slug).sort()).toEqual([
      "failure-modes/analyze-mode",
      "failure-modes/artifact-lookup",
      "failure-modes/forbidden-literals",
      "failure-modes/implement-vs-execute",
      "failure-modes/speculative-edits",
      "failure-modes/verify-mode",
    ]);
    expect(loaded.every((skill) => skill.reason === "always")).toBe(true);
  });

  it("loads integration skill packs alongside bundled packs", () => {
    const workspace = makeTempRoot("tanya-skills-integration-workspace-");
    const integrationsRoot = makeTempRoot("tanya-skills-integrations-");
    write(integrationsRoot, "acme/skills/acme-always.md", pack("Acme Always", "integration/acme-always", {
      loadWhen: "  - kind: always",
      priority: 4,
      body: "Integration body.",
    }));
    vi.stubEnv("TANYA_INTEGRATIONS_DIR", integrationsRoot);

    const loaded = loadSkillPacks(baseContext(workspace));

    expect(loaded.map((skill) => skill.slug)).toEqual(expect.arrayContaining([
      "failure-modes/analyze-mode",
      "integration/acme-always",
    ]));
    expect(loaded.find((skill) => skill.slug === "integration/acme-always")).toMatchObject({
      title: "Acme Always",
      content: "# Acme Always\n\nIntegration body.",
      reason: "always",
    });
  });

  it("loads failure-mode packs as always, even without matching frontmatter", () => {
    const workspace = makeTempRoot("tanya-skills-workspace-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(skillsRoot, "failure-modes/analyze-mode.md", pack("Analyze Mode", "failure-modes/analyze-mode"));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded).toEqual([
      expect.objectContaining({
        slug: "failure-modes/analyze-mode",
        reason: "always",
      }),
    ]);
  });

  it("loads packs from frontmatter-only conditions without implicit path rules", () => {
    const workspace = makeTempRoot("tanya-skills-frontmatter-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(workspace, "marker.txt", "present\n");
    write(skillsRoot, "custom/frontmatter-only.md", pack("Frontmatter Only", "custom/frontmatter-only", {
      loadWhen: "  - kind: workspace.has\n    path: marker.txt",
    }));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded).toEqual([
      expect.objectContaining({
        slug: "custom/frontmatter-only",
        reason: "workspace",
      }),
    ]);
  });

  it("strips frontmatter from loaded pack content", () => {
    const workspace = makeTempRoot("tanya-skills-strip-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(skillsRoot, "failure-modes/analyze-mode.md", pack("Analyze Mode", "failure-modes/analyze-mode", {
      body: "Visible body.",
    }));

    const [loaded] = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded).toBeDefined();
    expect(loaded!.content).toBe("# Analyze Mode\n\nVisible body.");
    expect(loaded!.content).not.toContain("---");
    expect(loaded!.content).not.toContain("loadWhen:");
  });

  it("warns and skips a pack when frontmatter cannot be parsed", () => {
    const workspace = makeTempRoot("tanya-skills-invalid-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    write(skillsRoot, "custom/bad.md", [
      "---",
      "slug: custom/bad",
      "title: Bad Pack",
      "loadWhen:",
      "  - kind: always",
      "priority: 0",
      "---",
      "# Bad Pack",
    ].join("\n"));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse frontmatter"));
    warn.mockRestore();
  });

  it("detects iOS, SwiftData, and StoreKit fallback packs from workspace probes", () => {
    const workspace = makeTempRoot("tanya-skills-ios-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(workspace, "Package.swift", "// swift-tools-version: 6.0\n");
    write(workspace, "App/Models/Item.swift", "import SwiftData\n@Model final class Item {}\n");
    write(skillsRoot, "lang/swift.md", pack("Swift", "lang/swift"));
    write(skillsRoot, "framework/swiftdata.md", pack("SwiftData", "framework/swiftdata"));
    write(skillsRoot, "framework/storekit2.md", pack("StoreKit 2", "framework/storekit2"));
    write(skillsRoot, "stack/ios-cosmohq.md", pack("iOS Reference", "stack/ios-cosmohq"));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded.map((skill) => skill.slug).sort()).toEqual([
      "framework/storekit2",
      "framework/swiftdata",
      "lang/swift",
      "stack/ios-cosmohq",
    ]);
    expect(loaded.every((skill) => skill.reason === "workspace")).toBe(true);
  });

  it("detects Go house-style and Huma/sqlc backend packs", () => {
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(skillsRoot, "lang/go.md", pack("Go", "lang/go"));
    write(skillsRoot, "framework/chi-pgx.md", pack("chi pgx", "framework/chi-pgx"));
    write(skillsRoot, "framework/huma-sqlc.md", pack("Huma sqlc", "framework/huma-sqlc"));
    write(skillsRoot, "stack/go-backend-cosmohq.md", pack("Go Backend", "stack/go-backend-cosmohq"));

    const houseWorkspace = makeTempRoot("tanya-skills-go-house-");
    write(houseWorkspace, "go.mod", "module example.com/house\n");
    write(houseWorkspace, "pkg/chat/migrations/00001_init.sql", "-- +goose Up\n");
    write(houseWorkspace, "pkg/chat/module.go", "func (m Module) Attach(router, authMW any) {}\n// Module.Attach\n");

    const humaWorkspace = makeTempRoot("tanya-skills-go-huma-");
    write(humaWorkspace, "go.mod", "module example.com/huma\n");
    write(humaWorkspace, "go.sum", "github.com/danielgtaylor/huma/v2 v2.0.0 h1:test\n");

    expect(loadSkillPacksFromRoot(baseContext(houseWorkspace), skillsRoot).map((skill) => skill.slug).sort()).toEqual([
      "framework/chi-pgx",
      "lang/go",
      "stack/go-backend-cosmohq",
    ]);
    expect(loadSkillPacksFromRoot(baseContext(humaWorkspace), skillsRoot).map((skill) => skill.slug).sort()).toEqual([
      "framework/huma-sqlc",
      "lang/go",
      "stack/go-backend-cosmohq",
    ]);
  });

  it("loads production Go house-style packs from workspace probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-go-house-");
    write(workspace, "go.mod", "module example.com/house\n");
    write(workspace, "pkg/test/migrations/00001_init.sql", "-- +goose Up\n");
    write(workspace, "pkg/test/module.go", [
      "package test",
      "func (m Module) Attach(router, authMW any) {}",
      "const header = \"X-Service-Token\"",
      "const _ = \"Module.Attach\"",
    ].join("\n"));

    const loaded = loadSkillPacks(baseContext(workspace));
    const slugs = loaded.map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/go",
      "framework/chi-pgx",
      "framework/goose-migrations",
      "framework/service-tokens",
      "stack/go-backend-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/huma-sqlc");
    for (const slug of ["lang/go", "framework/chi-pgx", "framework/goose-migrations", "framework/service-tokens", "stack/go-backend-cosmohq"]) {
      expect(loaded.find((skill) => skill.slug === slug)?.reason).toBe("workspace");
    }
  });

  it("loads production Huma/sqlc packs without house-style chi-pgx", () => {
    const workspace = makeTempRoot("tanya-skills-prod-go-huma-");
    mkdirSync(join(workspace, "internal/store/gen"), { recursive: true });
    write(workspace, "go.mod", "module example.com/huma\n");
    write(workspace, "internal/store/gen/db.go", "package gen\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/go",
      "framework/huma-sqlc",
      "stack/go-backend-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/chi-pgx");
  });

  it("loads both Go style packs when both style signals are present", () => {
    const workspace = makeTempRoot("tanya-skills-prod-go-ambiguous-");
    mkdirSync(join(workspace, "internal/store/gen"), { recursive: true });
    write(workspace, "go.mod", "module example.com/ambiguous\n");
    write(workspace, "internal/store/gen/db.go", "package gen\n");
    write(workspace, "pkg/test/migrations/00001_init.sql", "-- +goose Up\n");
    write(workspace, "pkg/test/module.go", "package test\nfunc (m Module) Attach(router, authMW any) {}\nconst _ = \"Module.Attach\"\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "framework/chi-pgx",
      "framework/huma-sqlc",
      "framework/goose-migrations",
      "stack/go-backend-cosmohq",
    ]));
  });

  it("loads production iOS RevenueCat packs from workspace probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-ios-revenuecat-");
    write(workspace, "Package.swift", "// swift-tools-version: 6.0\n");
    write(workspace, "Sources/App/Models/Item.swift", "import SwiftData\n@Model final class Item {}\n");
    write(workspace, "Sources/App/Services/SubscriptionManager.swift", "import RevenueCat\nfinal class SubscriptionManager {}\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/swift",
      "framework/swiftui",
      "framework/swiftdata",
      "framework/revenuecat-ios",
      "stack/ios-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/storekit2");
  });

  it("loads StoreKit fallback when an iOS SwiftData workspace has no RevenueCat signal", () => {
    const workspace = makeTempRoot("tanya-skills-prod-ios-storekit-");
    write(workspace, "Package.swift", "// swift-tools-version: 6.0\n");
    write(workspace, "Sources/App/Models/Item.swift", "import SwiftData\n@Model final class Item {}\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/swift",
      "framework/swiftui",
      "framework/swiftdata",
      "framework/storekit2",
      "stack/ios-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/revenuecat-ios");
  });

  it("loads baseline iOS packs from Package.swift without SwiftData", () => {
    const workspace = makeTempRoot("tanya-skills-prod-ios-package-");
    write(workspace, "Package.swift", "// swift-tools-version: 6.0\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/swift",
      "framework/swiftui",
      "framework/storekit2",
      "stack/ios-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/swiftdata");
    expect(slugs).not.toContain("framework/revenuecat-ios");
  });

  it("loads production Android packs from full workspace probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-android-full-");
    write(workspace, "build.gradle.kts", "plugins { kotlin(\"android\") }\n");
    write(workspace, "gradle/libs.versions.toml", "room = \"2.8.4\"\nrevenuecat = \"8.10.7\"\n");
    write(workspace, "app/src/main/java/com/example/Main.kt", "package com.example\n");
    write(workspace, "app/src/main/java/com/example/Api.kt", "package com.example\nimport retrofit2.http.GET\n");
    write(workspace, "app/src/main/java/com/example/Subscription.kt", "package com.example\nimport com.revenuecat.purchases.Purchases\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/kotlin",
      "framework/jetpack-compose",
      "framework/room-hilt",
      "framework/retrofit-okhttp",
      "framework/revenuecat-android",
      "stack/android-cosmohq",
    ]));
  });

  it("loads Android packs from a Kotlin Gradle build script without Kotlin source", () => {
    const workspace = makeTempRoot("tanya-skills-prod-android-build-only-");
    write(workspace, "build.gradle.kts", "plugins { kotlin(\"android\") }\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/kotlin",
      "framework/jetpack-compose",
      "stack/android-cosmohq",
    ]));
  });

  it("loads baseline Android packs without optional Room, Retrofit, or RevenueCat probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-android-baseline-");
    write(workspace, "build.gradle.kts", "plugins { kotlin(\"android\") }\n");
    write(workspace, "gradle/libs.versions.toml", "androidx-core = \"1.0.0\"\n");
    write(workspace, "app/src/main/java/com/example/Main.kt", "package com.example\nclass Main\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/kotlin",
      "framework/jetpack-compose",
      "stack/android-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/room-hilt");
    expect(slugs).not.toContain("framework/retrofit-okhttp");
    expect(slugs).not.toContain("framework/revenuecat-android");
  });

  it("loads production landing packs from Next, Tailwind v4, and shadcn probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-landing-full-");
    write(workspace, "next.config.ts", "import type { NextConfig } from \"next\";\nexport default {} satisfies NextConfig;\n");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    write(workspace, "components.json", "{\"tsx\":true}\n");
    write(workspace, "src/app/globals.css", "@import \"tailwindcss\";\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/typescript",
      "framework/nextjs-app-router",
      "framework/tailwind-v4",
      "framework/shadcn-ui",
      "stack/nextjs-cosmohq",
    ]));
  });

  it("loads shadcn from a local components/ui directory without components.json", () => {
    const workspace = makeTempRoot("tanya-skills-prod-landing-shadcn-ui-dir-");
    write(workspace, "next.config.ts", "export default {};\n");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    write(workspace, "components/ui/button.tsx", "export function Button() { return null; }\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toContain("framework/shadcn-ui");
  });

  it("loads shadcn from a local src/components/ui directory without components.json", () => {
    const workspace = makeTempRoot("tanya-skills-prod-landing-shadcn-src-ui-dir-");
    write(workspace, "next.config.ts", "export default {};\n");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    write(workspace, "src/components/ui/button.tsx", "export function Button() { return null; }\n");

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toContain("framework/shadcn-ui");
  });

  it("loads baseline Next.js packs without optional shadcn probes", () => {
    const workspace = makeTempRoot("tanya-skills-prod-landing-baseline-");
    write(workspace, "next.config.ts", "export default {};\n");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "lang/typescript",
      "framework/nextjs-app-router",
      "framework/tailwind-v4",
      "stack/nextjs-cosmohq",
    ]));
    expect(slugs).not.toContain("framework/shadcn-ui");
  });

  it("does not load landing packs from package.json alone without Next config", () => {
    const workspace = makeTempRoot("tanya-skills-prod-landing-package-only-");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));

    const slugs = loadSkillPacks(baseContext(workspace)).map((skill) => skill.slug);

    expect(slugs).not.toContain("lang/typescript");
    expect(slugs).not.toContain("framework/nextjs-app-router");
    expect(slugs).not.toContain("stack/nextjs-cosmohq");
  });

  it("loads all domain packs when an Apple stack matches", () => {
    const workspace = makeTempRoot("tanya-skills-prod-domain-ios-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(workspace, "Package.swift", "// swift-tools-version: 6.0\n");
    write(workspace, "Sources/App/Models/Item.swift", "import SwiftData\n@Model final class Item {}\n");
    write(workspace, "Sources/App/Services/SubscriptionManager.swift", "import RevenueCat\nfinal class SubscriptionManager {}\n");
    for (const slug of [
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
    ]) {
      write(skillsRoot, `${slug}.md`, pack(slug, slug));
    }

    const slugs = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
    ]));
  });

  it("loads all domain packs and Go deploy ops when a Go stack matches", () => {
    const workspace = makeTempRoot("tanya-skills-prod-domain-go-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(workspace, "go.mod", "module example.com/domain\n");
    for (const slug of [
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
      "platform-ops/deploy-go-backend",
    ]) {
      write(skillsRoot, `${slug}.md`, pack(slug, slug));
    }

    const slugs = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
      "platform-ops/deploy-go-backend",
    ]));
  });

  it("loads all domain packs when a landing stack matches", () => {
    const workspace = makeTempRoot("tanya-skills-prod-domain-landing-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(workspace, "next.config.ts", "export default {};\n");
    write(workspace, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    for (const slug of [
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
    ]) {
      write(skillsRoot, `${slug}.md`, pack(slug, slug));
    }

    const slugs = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot).map((skill) => skill.slug);

    expect(slugs).toEqual(expect.arrayContaining([
      "domain/auth-jwt",
      "domain/sign-in-apple",
      "domain/sign-in-google",
      "domain/auth-email-password",
      "domain/revenuecat",
      "domain/stripe",
      "domain/deep-links",
      "domain/push-notifications",
      "domain/splash-icon",
      "domain/api-contract",
      "domain/lgpd",
    ]));
  });

  it("adds Android packs from a Kotlin language hint without requiring workspace probes", () => {
    const workspace = makeTempRoot("tanya-skills-hints-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    write(skillsRoot, "lang/kotlin.md", pack("Kotlin", "lang/kotlin"));
    write(skillsRoot, "framework/jetpack-compose.md", pack("Jetpack Compose", "framework/jetpack-compose"));
    write(skillsRoot, "stack/android-cosmohq.md", pack("Android", "stack/android-cosmohq"));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace, {
      hints: {
        languages: ["kotlin"],
      },
    }), skillsRoot);

    expect(loaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "lang/kotlin", reason: "hint" }),
      expect.objectContaining({ slug: "framework/jetpack-compose", reason: "hint" }),
      expect.objectContaining({ slug: "stack/android-cosmohq", reason: "hint" }),
    ]));
  });

  it("keeps failure-mode and stack packs when trimming to the token budget", () => {
    const workspace = makeTempRoot("tanya-skills-budget-");
    const skillsRoot = makeTempRoot("tanya-skills-root-");
    const largeBody = "x".repeat(12_000);
    write(workspace, "go.mod", "module example.com/budget\n");
    write(skillsRoot, "failure-modes/analyze-mode.md", pack("Analyze", "failure-modes/analyze-mode", { priority: 0, body: largeBody }));
    write(skillsRoot, "stack/go-backend-cosmohq.md", pack("Go Backend", "stack/go-backend-cosmohq", { priority: 3, body: largeBody }));
    write(skillsRoot, "domain/auth-jwt.md", pack("Auth JWT", "domain/auth-jwt", { priority: 10, body: largeBody }));

    const loaded = loadSkillPacksFromRoot(baseContext(workspace), skillsRoot);

    expect(loaded.map((skill) => skill.slug)).toEqual([
      "failure-modes/analyze-mode",
      "stack/go-backend-cosmohq",
    ]);
  });
});

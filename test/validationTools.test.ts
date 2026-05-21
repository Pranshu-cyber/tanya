import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scanSecretsTool,
  validateAndroidProjectConfigTool,
  validateApiContractRoutesTool,
  validateAppleProjectFilesTool,
  validatePrismaSchemaTool,
} from "../src/tools/fsTools";

describe("validation tools", () => {
  it("compares markdown API route contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-validation-tools-"));
    mkdirSync(join(root, "brand"), { recursive: true });
    mkdirSync(join(root, "backend"), { recursive: true });
    writeFileSync(join(root, "brand", "api_features.md"), "- `GET /cases`\n- `POST /cases`\n");
    writeFileSync(join(root, "backend", "API_FEATURES.md"), "- `GET /cases`\n- `POST /cases`\n");

    const result = await validateApiContractRoutesTool.run(
      { source: "brand/api_features.md", target: "backend/API_FEATURES.md" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
  });

  it("validates Android manifest icon references and SDK levels", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-android-config-"));
    mkdirSync(join(root, "app/src/main"), { recursive: true });
    writeFileSync(join(root, "app/src/main/AndroidManifest.xml"), `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"/></manifest>`);
    writeFileSync(join(root, "app/build.gradle.kts"), "android { compileSdk = 35 defaultConfig { minSdk = 26 targetSdk = 35 } }\n");

    const result = await validateAndroidProjectConfigTool.run(
      { manifestPath: "app/src/main/AndroidManifest.xml", gradlePath: "app/build.gradle.kts" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
  });

  it("validates required Apple project files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-apple-project-"));
    mkdirSync(join(root, "App.xcodeproj"), { recursive: true });
    mkdirSync(join(root, "App/Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    writeFileSync(join(root, "App.xcodeproj/project.pbxproj"), "SplashScreenView.swift\nAppIcon.appiconset\n");
    writeFileSync(join(root, "App/SplashScreenView.swift"), "import SwiftUI\n");

    const result = await validateAppleProjectFilesTool.run(
      {
        xcodeprojPath: "App.xcodeproj",
        requiredPaths: ["App/SplashScreenView.swift", "App/Assets.xcassets/AppIcon.appiconset"],
        requireProjectReferences: true,
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
  });

  it("validates Prisma schema model names", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-prisma-schema-"));
    mkdirSync(join(root, "prisma"), { recursive: true });
    writeFileSync(join(root, "prisma/schema.prisma"), "model User { id String @id }\nmodel Case { id String @id }\n");

    const result = await validatePrismaSchemaTool.run(
      { requiredModels: ["User", "Case"], forbiddenModels: ["Jurisprudence"] },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
  });

  it("detects likely hardcoded secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "tanya-secret-scan-"));
    writeFileSync(join(root, "config.ts"), "export const API_SECRET = 'sk_live_1234567890abcdef1234567890abcdef';\n");

    const result = await scanSecretsTool.run({}, { workspace: root });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("API_SECRET");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyArtifactTool, commitPlatformChangesTool, copyDirTool, copyFileTool, createAndroidFoundationTool, createAndroidSplashTool, createIosSplashTool, defaultTools, runCommandTool, runShellTool, validateFastlaneConfigTool, writeFileTool } from "../src/tools/fsTools";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-mobile-tools-"));
}

describe("mobile-oriented tools", () => {
  it("registers commit_platform_changes with the files schema", () => {
    const tool = defaultTools().find((candidate) => candidate.name === "commit_platform_changes");
    expect(tool).toBeDefined();
    const parameters = tool?.definition.function.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.properties).toHaveProperty("files");
    expect(parameters.properties).not.toHaveProperty("paths");
    expect(parameters.required).toEqual(["files", "message"]);
  });

  it("copies files and directories inside the workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, ".tanya", "artifacts", "ios"), { recursive: true });
    mkdirSync(join(root, ".tanya", "artifacts", "Assets.xcassets", "SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(root, ".tanya", "artifacts", "ios", "ThemeSystem.swift"), "theme\n");
    writeFileSync(join(root, ".tanya", "artifacts", "Assets.xcassets", "SplashIcon.imageset", "Contents.json"), "{}\n");

    const fileResult = await copyFileTool.run(
      { source: ".tanya/artifacts/ios/ThemeSystem.swift", destination: "App/Theme/ThemeSystem.swift" },
      { workspace: root },
    );
    const dirResult = await copyDirTool.run(
      { source: ".tanya/artifacts/Assets.xcassets/SplashIcon.imageset", destination: "App/Assets.xcassets/SplashIcon.imageset" },
      { workspace: root },
    );

    expect(fileResult.ok).toBe(true);
    expect(dirResult.ok).toBe(true);
    expect(readFileSync(join(root, "App", "Theme", "ThemeSystem.swift"), "utf8")).toBe("theme\n");
    expect(readFileSync(join(root, "App", "Assets.xcassets", "SplashIcon.imageset", "Contents.json"), "utf8")).toBe("{}\n");
  });

  it("applies materialized artifacts to target paths", async () => {
    const root = makeProject();
    mkdirSync(join(root, ".tanya", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(root, ".tanya", "artifacts", "ios", "SplashScreenPattern.swift"), "pattern\n");

    const result = await applyArtifactTool.run(
      { artifactPath: ".tanya/artifacts/ios/SplashScreenPattern.swift", targetPath: "App/SplashScreenView.swift" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["App/SplashScreenView.swift"]);
    expect(readFileSync(join(root, "App", "SplashScreenView.swift"), "utf8")).toBe("pattern\n");
  });

  it("runs commands and shell snippets from subdirectories", async () => {
    const root = makeProject();
    mkdirSync(join(root, "ios"));
    writeFileSync(join(root, "ios", "marker.txt"), "ok\n");

    const commandResult = await runCommandTool.run(
      { command: "pwd", cwd: "ios", timeoutMs: 5_000 },
      { workspace: root },
    );
    const shellResult = await runShellTool.run(
      { script: "test -f marker.txt && echo present", cwd: "ios", timeoutMs: 5_000 },
      { workspace: root },
    );
    const shellCommandAliasResult = await runShellTool.run(
      { command: "test -f marker.txt && echo alias-present", cwd: "ios", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(commandResult.ok).toBe(true);
    expect(String(commandResult.output)).toContain("/ios");
    expect(shellResult.ok).toBe(true);
    expect(shellResult.output).toBe("present");
    expect(shellCommandAliasResult.ok).toBe(true);
    expect(shellCommandAliasResult.output).toBe("alias-present");
  });

  it("accepts absolute cwd paths that stay inside the workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "ios"));
    writeFileSync(join(root, "ios", "marker.txt"), "ok\n");

    const result = await runShellTool.run(
      { script: "test -f marker.txt && echo present", cwd: join(root, "ios"), timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("present");
  });

  it("filters TypeScript compiler errors from run_command failures", async () => {
    const root = makeProject();
    writeFileSync(join(root, "tsc"), [
      "#!/bin/sh",
      "echo 'large noisy prelude'",
      "echo 'src/index.ts:1:7 - error TS2322: Type string is not assignable to type number.'",
      "echo 'const value: number = \"x\";'",
      "echo 'large noisy tail'",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await runCommandTool.run(
      { command: "./tsc", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(String(result.output)).toContain("TypeScript errors (filtered):");
    expect(String(result.output)).toContain("src/index.ts:1:7 - error TS2322");
    expect(String(result.output)).toContain("const value: number");
    expect(String(result.output)).not.toContain("large noisy prelude");
    expect(String(result.output)).not.toContain("large noisy tail");
  });

  it("filters TypeScript compiler errors from run_shell failures", async () => {
    const root = makeProject();
    writeFileSync(join(root, "tsc"), [
      "#!/bin/sh",
      "echo 'large noisy prelude'",
      "echo 'src/App.tsx:2:3 - error TS2304: Cannot find name Missing.'",
      "echo '  <Missing />'",
      "echo 'large noisy tail'",
      "exit 2",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = await runShellTool.run(
      { script: "PATH=$PWD:$PATH tsc", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(String(result.output)).toContain("TypeScript errors (filtered):");
    expect(String(result.output)).toContain("src/App.tsx:2:3 - error TS2304");
    expect(String(result.output)).toContain("<Missing />");
    expect(String(result.output)).not.toContain("large noisy prelude");
    expect(String(result.output)).not.toContain("large noisy tail");
  });

  it("creates high-level iOS and Android splash resources", async () => {
    const root = makeProject();
    const iosResult = await createIosSplashTool.run(
      { viewPath: "App/SplashScreenView.swift", brandHex: "#A52A2A", durationMs: 1000 },
      { workspace: root },
    );
    const androidResult = await createAndroidSplashTool.run(
      { resDir: "app/src/main/res", brandHex: "#A52A2A", themeName: "Theme.App.Starting" },
      { workspace: root },
    );

    expect(iosResult.ok).toBe(true);
    expect(androidResult.ok).toBe(true);
    const iosSplash = readFileSync(join(root, "App", "SplashScreenView.swift"), "utf8");
    expect(iosSplash).toContain("Image(\"SplashIcon\")");
    expect(iosSplash).toContain("brandColor");
    expect(iosSplash).toContain("opacity(iconVisible");
    expect(iosSplash).toContain("easeOut(duration: 0.6)");
    expect(iosSplash).not.toContain(".transition(");
    expect(iosSplash).not.toContain("value: isReady");
    expect(readFileSync(join(root, "App", "Assets.xcassets", "SplashIcon.imageset", "Contents.json"), "utf8")).toContain("SplashIcon.png");
    expect(existsSync(join(root, "App", "Assets.xcassets", "SplashIcon.imageset", "SplashIcon.png"))).toBe(true);
    expect(readFileSync(join(root, "app", "src", "main", "res", "values", "splash_theme.xml"), "utf8")).toContain("Theme.SplashScreen");
  });

  it("allows create_ios_splash to read an explicit absolute source icon while writing inside the workspace", async () => {
    const root = makeProject();
    const outside = mkdtempSync(join(tmpdir(), "tanya-mobile-tools-source-"));
    const sourceIcon = join(outside, "icon-1024.png");
    writeFileSync(
      sourceIcon,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
    );

    const result = await createIosSplashTool.run(
      { viewPath: "App/SplashScreenView.swift", sourceIcon, brandHex: "#A52A2A", durationMs: 1000 },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "App", "Assets.xcassets", "SplashIcon.imageset", "SplashIcon.png"))).toBe(true);
    expect(readFileSync(join(root, "App", "SplashScreenView.swift"), "utf8")).toContain("Image(\"SplashIcon\")");
  });

  it("creates a deterministic Android foundation", async () => {
    const root = makeProject();
    writeFileSync(join(root, "build.gradle.kts"), [
      "plugins {",
      "    id(\"com.android.application\") version \"8.5.2\" apply false",
      "    id(\"org.jetbrains.kotlin.android\") version \"1.9.24\" apply false",
      "}",
      "",
    ].join("\n"));
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "build.gradle.kts"), [
      "plugins {",
      "    id(\"com.android.application\")",
      "    id(\"org.jetbrains.kotlin.android\")",
      "}",
      "",
      "dependencies {",
      "    implementation(\"androidx.compose.material3:material3\")",
      "}",
      "",
    ].join("\n"));

    const result = await createAndroidFoundationTool.run(
      { packageName: "com.example.app", appName: "Demo App", brandPrimaryHex: "#A52A2A" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "app/src/main/java/com/example/app/data/AppDatabase.kt"), "utf8")).toContain("@Database");
    expect(readFileSync(join(root, "app/src/main/java/com/example/app/navigation/AppNavigation.kt"), "utf8")).toContain("NavHost");
    expect(readFileSync(join(root, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt"), "utf8")).toContain("MaterialTheme");
    expect(readFileSync(join(root, "app/build.gradle.kts"), "utf8")).toContain("androidx.room:room-runtime");
    expect(readFileSync(join(root, "build.gradle.kts"), "utf8")).toContain("com.google.devtools.ksp");
  });

  it("preserves existing Android foundation source files by default", async () => {
    const root = makeProject();
    const themePath = join(root, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt");
    mkdirSync(join(root, "app/src/main/java/com/example/app/ui/theme"), { recursive: true });
    writeFileSync(themePath, "package com.example.app.ui.theme\n\nconst val ExistingTheme = true\n");

    const result = await createAndroidFoundationTool.run(
      { packageName: "com.example.app", updateGradle: false },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(themePath, "utf8")).toContain("ExistingTheme");
    expect(result.files).not.toContain("app/src/main/java/com/example/app/ui/theme/AppTheme.kt");
    expect(readFileSync(join(root, "app/src/main/java/com/example/app/data/AppDatabase.kt"), "utf8")).toContain("@Database");
  });

  it("can overwrite existing Android foundation source files when requested", async () => {
    const root = makeProject();
    const themePath = join(root, "app/src/main/java/com/example/app/ui/theme/AppTheme.kt");
    mkdirSync(join(root, "app/src/main/java/com/example/app/ui/theme"), { recursive: true });
    writeFileSync(themePath, "package com.example.app.ui.theme\n\nconst val ExistingTheme = true\n");

    const result = await createAndroidFoundationTool.run(
      { packageName: "com.example.app", updateGradle: false, overwriteExisting: true },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(themePath, "utf8")).not.toContain("ExistingTheme");
    expect(readFileSync(themePath, "utf8")).toContain("MaterialTheme");
    expect(result.files).toContain("app/src/main/java/com/example/app/ui/theme/AppTheme.kt");
  });

  it("writes files with a read-back preview", async () => {
    const root = makeProject();

    const result = await writeFileTool.run(
      { path: "notes/demo.md", content: "one\ntwo\nthree\nfour\nfive\n" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("6 lines");
    expect(result.output).toEqual({
      path: "notes/demo.md",
      lineCount: 6,
      preview: "one\ntwo\nthree\nfour",
    });
    expect(result.files).toEqual(["notes/demo.md"]);
  });

  it("rejects writes to Android local.properties", async () => {
    const root = makeProject();
    const writeResult = await writeFileTool.run(
      { path: "local.properties", content: "sdk.dir=/Users/example/Library/Android/sdk\n" },
      { workspace: root },
    );
    const shellResult = await runShellTool.run(
      { script: "printf 'sdk.dir=/tmp/android\\n' > local.properties", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(writeResult.ok).toBe(false);
    expect(writeResult.error).toContain("ANDROID_HOME");
    expect(shellResult.ok).toBe(false);
    expect(shellResult.error).toContain("ANDROID_HOME");
  });

  it("rejects masked mobile verification shell commands", async () => {
    const root = makeProject();
    const pipedGradle = await runShellTool.run(
      { script: "./gradlew assembleDebug --no-daemon 2>&1 | tail -20", timeoutMs: 5_000 },
      { workspace: root },
    );
    const echoedExitCode = await runShellTool.run(
      { script: "./gradlew ktlintCheck --no-daemon 2>&1; echo \"EXIT_CODE=$?\"", timeoutMs: 5_000 },
      { workspace: root },
    );
    const fastlaneEchoedExitCode = await runShellTool.run(
      { script: "fastlane android build 2>&1; echo \"EXIT_CODE=$?\"", timeoutMs: 5_000 },
      { workspace: root },
    );
    const safePipedGradle = await runShellTool.run(
      { script: "set -o pipefail && printf '#!/bin/sh\\necho ok\\n' > gradlew && chmod +x gradlew && ./gradlew assembleDebug 2>&1 | tail -20", timeoutMs: 5_000 },
      { workspace: root },
    );
    const xcodeList = await runShellTool.run(
      { script: "printf '#!/bin/sh\\necho schemes\\n' > xcodebuild && chmod +x xcodebuild && PATH=\"$PWD:$PATH\" xcodebuild -list 2>&1 | head -20", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(pipedGradle.ok).toBe(false);
    expect(pipedGradle.error).toContain("pipefail");
    expect(echoedExitCode.ok).toBe(false);
    expect(echoedExitCode.error).toContain("EXIT_CODE");
    expect(fastlaneEchoedExitCode.ok).toBe(false);
    expect(fastlaneEchoedExitCode.error).toContain("EXIT_CODE");
    expect(safePipedGradle.ok).toBe(true);
    expect(xcodeList.ok).toBe(true);
  });

  it("rejects host package manager mutation during coding runs", async () => {
    const root = makeProject();
    const brewResult = await runShellTool.run(
      { script: "brew reinstall fastlane", timeoutMs: 5_000 },
      { workspace: root },
    );
    const gemResult = await runShellTool.run(
      { script: "gem install digest-crc --no-document", timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(brewResult.ok).toBe(false);
    expect(brewResult.error).toContain("manual environment blocker");
    expect(gemResult.ok).toBe(false);
    expect(gemResult.error).toContain("Ruby/Fastlane");
  });

  it("keeps the tail and authoritative exit code when shell output is truncated", async () => {
    const root = makeProject();
    const result = await runShellTool.run(
      {
        script: "yes filler | head -n 4000; echo 'BUILD SUCCEEDED'",
        timeoutMs: 5_000,
      },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Shell exited 0");
    expect(result.summary).toContain("Success marker found");
    expect(result.summary).toContain("exit code is authoritative");
    expect(String(result.output)).toContain("BUILD SUCCEEDED");
  });

  it("commits selected files with commit_platform_changes", async () => {
    const root = makeProject();
    await runCommandTool.run({ command: "git", args: ["init"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.email", "tanya@example.test"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.name", "Tanya Test"], timeoutMs: 5_000 }, { workspace: root });
    writeFileSync(join(root, "README.md"), "# Demo\n");

    const result = await commitPlatformChangesTool.run(
      { files: ["README.md"], message: "Add README" },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Committed");
  });

  it("amends selected files with commit_platform_changes", async () => {
    const root = makeProject();
    await runCommandTool.run({ command: "git", args: ["init"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.email", "tanya@example.test"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.name", "Tanya Test"], timeoutMs: 5_000 }, { workspace: root });
    writeFileSync(join(root, "README.md"), "# Demo\n");
    const first = await commitPlatformChangesTool.run(
      { files: ["README.md"], message: "Add README" },
      { workspace: root },
    );
    const firstHead = (first.output as { head?: string }).head;
    writeFileSync(join(root, "README.md"), "# Demo\n\nUpdated\n");

    const amend = await commitPlatformChangesTool.run(
      { files: ["README.md"], message: "Add README", amend: true },
      { workspace: root },
    );
    const amendedHead = (amend.output as { head?: string }).head;
    const count = await runCommandTool.run(
      { command: "git", args: ["rev-list", "--count", "HEAD"], timeoutMs: 5_000 },
      { workspace: root },
    );

    expect(amend.ok).toBe(true);
    expect(amend.summary).toContain("Amended");
    expect(amendedHead).not.toBe(firstHead);
    expect(count.output).toBe("1");
  });

  it("validates Fastlane lane contracts and forbidden files", async () => {
    const root = makeProject();
    mkdirSync(join(root, "fastlane"), { recursive: true });
    writeFileSync(
      join(root, "fastlane", "Fastfile"),
      [
        "default_platform(:android)",
        "platform :android do",
        "  lane :bump do",
        "  end",
        "  lane :build do",
        "    gradle(project_dir: File.expand_path(\"..\", __dir__))",
        "  end",
        "  lane :deploy do",
        "  end",
        "  lane :promote do",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "fastlane", "Appfile"), "package_name(\"com.example\")\n");

    const pass = await validateFastlaneConfigTool.run(
      {
        requiredLanes: ["bump", "build", "deploy", "promote"],
        requiredFiles: ["fastlane/Appfile"],
        forbiddenFiles: ["Gemfile", "Gemfile.lock"],
        requireProjectDirAnchoredToDirname: true,
      },
      { workspace: root },
    );
    const fail = await validateFastlaneConfigTool.run(
      { requiredLanes: ["bump_version"], forbiddenFiles: ["fastlane/Appfile"] },
      { workspace: root },
    );

    expect(pass.ok).toBe(true);
    expect(fail.ok).toBe(false);
    expect(fail.error).toContain("Missing Fastlane lane :bump_version");
    expect(fail.error).toContain("Forbidden file exists: fastlane/Appfile");
  });

  it("validates platform-scoped Fastlane lane contracts", async () => {
    const root = makeProject();
    mkdirSync(join(root, "fastlane"), { recursive: true });
    writeFileSync(
      join(root, "fastlane", "Fastfile"),
      [
        "platform :ios do",
        "  lane :build do",
        "  end",
        "end",
        "",
        "platform :mac do",
        "  lane :build do",
        "  end",
        "end",
        "",
      ].join("\n"),
    );

    const result = await validateFastlaneConfigTool.run(
      { requiredLanes: ["ios build", "mac build"] },
      { workspace: root },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ platformLanes: ["ios build", "mac build"] });
  });

  it("rejects Android Fastlane bump lanes gated entirely behind version option", async () => {
    const root = makeProject();
    mkdirSync(join(root, "fastlane"), { recursive: true });
    writeFileSync(
      join(root, "fastlane", "Fastfile"),
      [
        "platform :android do",
        "  lane :bump do |options|",
        "    if options[:version]",
        "      # bad: versionCode only changes here",
        "    end",
        "  end",
        "end",
        "",
      ].join("\n"),
    );

    const result = await validateFastlaneConfigTool.run(
      { requiredLanes: ["bump"] },
      { workspace: root },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("must increment versionCode by default");
  });

  it("commits repo-root paths when running from a nested platform workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "ios", "fastlane"), { recursive: true });
    await runCommandTool.run({ command: "git", args: ["init"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.email", "tanya@example.test"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.name", "Tanya Test"], timeoutMs: 5_000 }, { workspace: root });
    writeFileSync(join(root, "ios", "fastlane", "Fastfile"), "lane :build do\nend\n");

    const result = await commitPlatformChangesTool.run(
      { files: ["ios/fastlane/Fastfile"], message: "Add iOS Fastfile" },
      { workspace: join(root, "ios") },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Committed");
  });

  it("commits deleted files from a nested platform workspace", async () => {
    const root = makeProject();
    mkdirSync(join(root, "ios", "fastlane"), { recursive: true });
    await runCommandTool.run({ command: "git", args: ["init"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.email", "tanya@example.test"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["config", "user.name", "Tanya Test"], timeoutMs: 5_000 }, { workspace: root });
    writeFileSync(join(root, "ios", "fastlane", "Fastfile"), "lane :build do\nend\n");
    await runCommandTool.run({ command: "git", args: ["add", "ios/fastlane/Fastfile"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["commit", "-m", "Seed Fastfile"], timeoutMs: 5_000 }, { workspace: root });
    rmSync(join(root, "ios", "fastlane", "Fastfile"));

    const nestedPathResult = await commitPlatformChangesTool.run(
      { files: ["fastlane/Fastfile"], message: "Remove nested Fastfile" },
      { workspace: join(root, "ios") },
    );

    expect(nestedPathResult.ok).toBe(true);

    writeFileSync(join(root, "ios", "fastlane", "Fastfile"), "lane :test do\nend\n");
    await runCommandTool.run({ command: "git", args: ["add", "ios/fastlane/Fastfile"], timeoutMs: 5_000 }, { workspace: root });
    await runCommandTool.run({ command: "git", args: ["commit", "-m", "Restore Fastfile"], timeoutMs: 5_000 }, { workspace: root });
    rmSync(join(root, "ios", "fastlane", "Fastfile"));

    const repoPathResult = await commitPlatformChangesTool.run(
      { files: ["ios/fastlane/Fastfile"], message: "Remove repo-prefixed Fastfile" },
      { workspace: join(root, "ios") },
    );

    expect(repoPathResult.ok).toBe(true);
  });
});

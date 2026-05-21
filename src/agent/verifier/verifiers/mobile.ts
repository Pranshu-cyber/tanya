import { join } from "node:path";
import type { Verifier, VerifierCheck } from "../types";
import { makeCheck } from "../types";

export const iosVerifier: Verifier = {
  id: "ios",
  platform: "ios",
  appliesTo(ctx) {
    return ctx.fileExists(join(ctx.workspace, "Package.swift"));
  },
  async run(ctx) {
    const checks: VerifierCheck[] = [];
    const text = ctx.readText(join(ctx.workspace, "Package.swift"));
    checks.push(makeCheck({
      id: "package-swift-present",
      description: "Package.swift exists",
      passed: text !== null,
      authoritative: false,
      error: text === null ? "Package.swift missing" : undefined,
    }));
    return checks;
  },
};

export const androidVerifier: Verifier = {
  id: "android",
  platform: "android",
  appliesTo(ctx) {
    return ctx.fileExists(join(ctx.workspace, "build.gradle.kts")) ||
      ctx.fileExists(join(ctx.workspace, "settings.gradle.kts"));
  },
  async run(ctx) {
    const checks: VerifierCheck[] = [];
    const buildGradle = ctx.readText(join(ctx.workspace, "build.gradle.kts"));
    const settingsGradle = ctx.readText(join(ctx.workspace, "settings.gradle.kts"));
    const passed = buildGradle !== null || settingsGradle !== null;
    checks.push(makeCheck({
      id: "gradle-config-present",
      description: "build.gradle.kts or settings.gradle.kts exists",
      passed,
      authoritative: false,
      error: passed ? undefined : "Gradle Kotlin DSL config missing",
    }));
    return checks;
  },
};

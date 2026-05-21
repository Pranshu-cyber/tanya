import type { TanyaRunContext } from "../../context/runContext";
import {
  changedMatching,
  constraintText,
  extractPromptFeatures,
  featureCoveredByText,
  findWorkspaceFiles,
  hasChanged,
  hasDedicatedCtaSlide,
  hasSuccessfulVerification,
  readWorkspaceFile,
  uniqueSorted,
  workspaceFileExists,
  type ValidationIssue,
  type ValidationManifest,
} from "./core";

async function androidGradleVerificationIssues(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  if (!await workspaceFileExists(workspace, "gradlew")) return [];
  const issues: ValidationIssue[] = [];
  if (!hasSuccessfulVerification(manifest, /(?:^|[\s;&|])\.\/gradlew\s+assembleDebug\b/i)) {
    issues.push({
      id: "android-gradle-assembledebug-missing",
      severity: "error",
      message: "Android task has a local Gradle wrapper and must run/report `./gradlew assembleDebug --no-daemon` instead of deferring it as a manual check.",
      files: ["gradlew"],
    });
  }
  const gradleTexts = (await Promise.all([
    readWorkspaceFile(workspace, "build.gradle.kts"),
    readWorkspaceFile(workspace, "app/build.gradle.kts"),
    readWorkspaceFile(workspace, "settings.gradle.kts"),
    readWorkspaceFile(workspace, "build.gradle"),
    readWorkspaceFile(workspace, "app/build.gradle"),
  ])).filter((text): text is string => text !== null).join("\n");
  if (/ktlint/i.test(gradleTexts) && !hasSuccessfulVerification(manifest, /(?:^|[\s;&|])\.\/gradlew\s+ktlintCheck\b/i)) {
    issues.push({
      id: "android-gradle-ktlintcheck-missing",
      severity: "error",
      message: "Android task has ktlint configured and must run/report `./gradlew ktlintCheck --no-daemon`.",
      files: ["build.gradle.kts", "app/build.gradle.kts"],
    });
  }
  return issues;
}

export async function validateAndroidSplash(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [...await androidGradleVerificationIssues(workspace, manifest)];
  const manifestPath = manifest.changedFiles.find((file) => /(?:^|\/)AndroidManifest\.xml$/.test(file)) ?? "app/src/main/AndroidManifest.xml";
  const androidManifest = await readWorkspaceFile(workspace, manifestPath);
  const splashThemePath = manifest.changedFiles.find((file) => /(?:^|\/)splash_theme\.xml$/.test(file)) ?? "app/src/main/res/values/splash_theme.xml";
  const splashTheme = await readWorkspaceFile(workspace, splashThemePath);
  const mainActivityPath = manifest.changedFiles.find((file) => /(?:^|\/)MainActivity\.kt$/.test(file)) ?? "app/src/main/java/MainActivity.kt";
  const mainActivity = await readWorkspaceFile(workspace, mainActivityPath);

  if (!splashTheme) {
    issues.push({ id: "android-splash-theme-missing", severity: "error", message: "Android splash task did not create app/src/main/res/values/splash_theme.xml." });
  } else {
    if (!/Theme\.SplashScreen/.test(splashTheme)) {
      issues.push({ id: "android-splash-theme-parent", severity: "error", message: "splash_theme.xml must use Theme.SplashScreen.", files: [splashThemePath] });
    }
    if (/@mipmap\//.test(splashTheme)) {
      issues.push({ id: "android-splash-mipmap-icon", severity: "error", message: "splash_theme.xml must reference splash icons from @drawable, not @mipmap.", files: [splashThemePath] });
    }
    if (!/@drawable\//.test(splashTheme)) {
      issues.push({ id: "android-splash-drawable-icon", severity: "error", message: "splash_theme.xml must reference a @drawable splash icon.", files: [splashThemePath] });
    }
  }
  if (!androidManifest || !/android:theme\s*=\s*"@style\//.test(androidManifest)) {
    issues.push({ id: "android-splash-manifest-theme", severity: "error", message: "AndroidManifest.xml must set the application/activity splash theme.", files: [manifestPath] });
  }
  if (!mainActivity || !/installSplashScreen\s*\(/.test(mainActivity)) {
    issues.push({ id: "android-splash-install-call", severity: "error", message: "MainActivity.kt must call installSplashScreen().", files: [mainActivityPath] });
  }
  if (!hasChanged(manifest, /(?:^|\/)res\/drawable\/[^/]+\.png$/)) {
    issues.push({ id: "android-splash-drawable-png", severity: "error", message: "Android splash task must place the splash icon PNG under res/drawable/." });
  }
  return issues;
}

export async function validateAndroidAppIcon(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [...await androidGradleVerificationIssues(workspace, manifest)];
  const launcherPngs = manifest.changedFiles.filter((file) => /(?:^|\/)res\/mipmap-[^/]+\/ic_launcher(?:_round)?\.png$/.test(file));
  if (launcherPngs.length === 0) {
    issues.push({ id: "android-app-icon-mipmap-pngs-missing", severity: "error", message: "Android app icon task did not create launcher PNGs under res/mipmap-*." });
  }
  const manifestPath = manifest.changedFiles.find((file) => /(?:^|\/)AndroidManifest\.xml$/.test(file)) ?? "app/src/main/AndroidManifest.xml";
  const androidManifest = await readWorkspaceFile(workspace, manifestPath);
  if (androidManifest) {
    if (!/android:icon\s*=\s*"@mipmap\/ic_launcher"/.test(androidManifest)) {
      issues.push({ id: "android-app-icon-manifest-icon", severity: "warning", message: "AndroidManifest.xml does not reference @mipmap/ic_launcher.", files: [manifestPath] });
    }
    if (!/android:roundIcon\s*=\s*"@mipmap\/ic_launcher_round"/.test(androidManifest)) {
      issues.push({ id: "android-app-icon-manifest-round-icon", severity: "warning", message: "AndroidManifest.xml does not reference @mipmap/ic_launcher_round.", files: [manifestPath] });
    }
  }
  return issues;
}

export async function validateAndroidOnboarding(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [...await androidGradleVerificationIssues(workspace, manifest)];
  const onboardingPath = manifest.changedFiles.find((file) => /(?:^|\/)OnboardingScreen\.kt$/.test(file)) ??
    (await findWorkspaceFiles(workspace, (file) => /(?:^|\/)OnboardingScreen\.kt$/.test(file), { roots: ["app/src/main/java"], limit: 10 }))[0];
  if (!onboardingPath) {
    return [{ id: "android-onboarding-screen-missing", severity: "error", message: "Android onboarding task must create or update OnboardingScreen.kt." }, ...issues];
  }
  const onboarding = await readWorkspaceFile(workspace, onboardingPath);
  if (!onboarding) return [{ id: "android-onboarding-screen-unreadable", severity: "error", message: "Could not read OnboardingScreen.kt.", files: [onboardingPath] }, ...issues];

  if (!/HorizontalPager\s*\(/.test(onboarding)) {
    issues.push({ id: "android-onboarding-horizontalpager-missing", severity: "error", message: "OnboardingScreen.kt must use HorizontalPager.", files: [onboardingPath] });
  }
  if (!/\bPular\b/.test(onboarding)) {
    issues.push({ id: "android-onboarding-skip-missing", severity: "error", message: "OnboardingScreen.kt must include the pt-BR skip button `Pular`.", files: [onboardingPath] });
  } else if (!/Alignment\.TopEnd|align\s*\(\s*Alignment\.TopEnd\s*\)|Arrangement\.End/.test(onboarding)) {
    issues.push({ id: "android-onboarding-skip-not-top-right", severity: "error", message: "`Pular` must be positioned top-right and hidden on the final CTA slide.", files: [onboardingPath] });
  }
  if (!hasDedicatedCtaSlide(onboarding, "android")) {
    issues.push({ id: "android-onboarding-final-cta-slide-missing", severity: "error", message: "The final pager page must be a dedicated CTA slide, not another feature slide with footer CTA buttons.", files: [onboardingPath] });
  }
  if (!/\bComeçar grátis\b/.test(onboarding) || !/\bJá tenho conta\b/.test(onboarding)) {
    issues.push({ id: "android-onboarding-cta-copy-missing", severity: "error", message: "Final CTA slide must include `Começar grátis` and `Já tenho conta`.", files: [onboardingPath] });
  }
  const stateFiles = uniqueSorted([
    ...manifest.changedFiles.filter((file) => /(?:Onboarding|DataStore|Preferences).*\.(?:kt|kts)$/.test(file)),
    onboardingPath,
  ]);
  const stateText = (await Promise.all(stateFiles.map(async (file) => await readWorkspaceFile(workspace, file) ?? ""))).join("\n");
  if (!/hasSeenOnboarding/.test(stateText)) {
    issues.push({ id: "android-onboarding-storage-key-missing", severity: "error", message: "Android onboarding must persist completion with the exact hasSeenOnboarding key.", files: stateFiles });
  }
  return issues;
}

export async function validateAndroidFoundation(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [...await androidGradleVerificationIssues(workspace, manifest)];
  const discoveredKotlinFiles = await findWorkspaceFiles(
    workspace,
    (file) => /(?:^|\/)app\/src\/main\/java\/.*\.kt$/.test(file) &&
      /(?:\/data\/|\/navigation\/|\/ui\/theme\/|\/ui\/components\/|MainActivity\.kt$)/.test(file),
    { roots: ["app/src/main/java"], limit: 120 },
  );
  const kotlinFiles = uniqueSorted([
    ...changedMatching(manifest, /(?:^|\/)app\/src\/main\/java\/.*\.kt$/),
    ...discoveredKotlinFiles,
  ]);
  const gradleFiles = uniqueSorted([
    ...changedMatching(manifest, /(?:^|\/)(?:build\.gradle\.kts|app\/build\.gradle\.kts)$/),
    "build.gradle.kts",
    "app/build.gradle.kts",
    "settings.gradle.kts",
    "gradle/libs.versions.toml",
  ]);
  const fileTexts = new Map<string, string>();
  for (const file of [...kotlinFiles, ...gradleFiles]) {
    fileTexts.set(file, await readWorkspaceFile(workspace, file) ?? "");
  }
  const combinedKotlin = kotlinFiles.map((file) => fileTexts.get(file) ?? "").join("\n");
  const combinedGradle = gradleFiles.map((file) => fileTexts.get(file) ?? "").join("\n");

  if (!/@Database\s*\(|RoomDatabase|@Entity\s*\(|@Dao\b/.test(combinedKotlin)) {
    issues.push({ id: "android-foundation-room-missing", severity: "error", message: "Android foundation must add Room database/entity/DAO code.", files: kotlinFiles });
  }
  if (!/NavHost\s*\(|rememberNavController\s*\(|NavigationBarItem\s*\(/.test(combinedKotlin)) {
    issues.push({ id: "android-foundation-navigation-missing", severity: "error", message: "Android foundation must add Navigation Compose scaffolding.", files: kotlinFiles });
  }
  if (!/MaterialTheme\s*\(|darkColorScheme\s*\(|lightColorScheme\s*\(|dynamic(?:Dark|Light)ColorScheme\s*\(/.test(combinedKotlin)) {
    issues.push({ id: "android-foundation-theme-missing", severity: "error", message: "Android foundation must add a Material 3 theme with brand colors.", files: kotlinFiles });
  }
  if (!/EmptyState|LoadingState|ErrorState|SearchableFeatureListScreen/.test(combinedKotlin)) {
    issues.push({ id: "android-foundation-base-composables-missing", severity: "error", message: "Android foundation must add reusable base composables or UI states.", files: kotlinFiles });
  }
  if (!/navigation-compose/.test(combinedGradle)) {
    issues.push({ id: "android-foundation-nav-dependency-missing", severity: "error", message: "Android foundation must add Navigation Compose dependency.", files: gradleFiles });
  }
  if (!/androidx\.room:room-runtime|androidx\.room:room-ktx/.test(combinedGradle) || !/room-compiler/.test(combinedGradle)) {
    issues.push({ id: "android-foundation-room-dependency-missing", severity: "error", message: "Android foundation must add Room runtime/ktx/compiler dependencies.", files: gradleFiles });
  }
  return issues;
}

export async function validateAndroidBaseLayout(workspace: string, manifest: ValidationManifest, runContext?: TanyaRunContext): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [...await androidGradleVerificationIssues(workspace, manifest)];
  const text = constraintText(runContext);
  const features = extractPromptFeatures(text);
  if (features.length === 0) return issues;

  const kotlinFiles = await findWorkspaceFiles(
    workspace,
    (file) => /(?:^|\/)app\/src\/main\/java\/.*\.kt$/.test(file) &&
      /(?:\/navigation\/|\/ui\/|MainActivity\.kt$)/.test(file),
    { roots: ["app/src/main/java"], limit: 180 },
  );
  const fileTexts = new Map<string, string>();
  for (const file of kotlinFiles) fileTexts.set(file, await readWorkspaceFile(workspace, file) ?? "");
  const combinedKotlin = kotlinFiles.map((file) => fileTexts.get(file) ?? "").join("\n");

  if (!/NavHost\s*\(|NavigationBarItem\s*\(|composable\s*\(/.test(combinedKotlin)) {
    issues.push({
      id: "android-base-layout-navigation-missing",
      severity: "error",
      message: "Android base layout must wire feature navigation with Navigation Compose routes and bottom navigation items.",
      files: kotlinFiles,
    });
  }

  for (const feature of features) {
    if (!featureCoveredByText(feature, combinedKotlin)) {
      issues.push({
        id: "android-base-layout-feature-missing",
        severity: "error",
        message: `Android base layout is missing a placeholder navigation route/screen for requested feature: ${feature.name}. Do not substitute generic tabs such as Settings for app feature modules.`,
        files: kotlinFiles,
      });
    }
  }

  const premiumFeatures = features.filter((feature) => feature.tier === "premium");
  if (premiumFeatures.length > 0 && !/\b(?:PremiumGate|premiumState|hasPremium|isPaidFeature|paywall|entitlement)\b/.test(combinedKotlin)) {
    issues.push({
      id: "android-base-layout-premium-gate-missing",
      severity: "error",
      message: "Android base layout includes premium feature modules and must gate premium feature content with PremiumGate/equivalent entitlement state instead of exposing screens directly.",
      files: kotlinFiles,
    });
  }

  return issues;
}

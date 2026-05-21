import type { TanyaRunContext } from "../../context/runContext";
import { scanForbiddenPatterns } from "../forbiddenPatterns";
import {
  coreValidators,
  constraintText,
  hasChanged,
  inferPrimaryPlatform,
  isAndroidPlatformTask,
  isAppIconTask,
  isApplePlatformTask,
  taskText,
  validateApiClient,
  validateAuthSession,
  validateBackendHealthApi,
  validateBackendSetupEnvironment,
  validateRevenueCat,
  validateSetupEnvironment,
  type ValidationIssue,
  type ValidationManifest,
  type ValidationSummary,
  type Validator,
} from "./core";
import {
  validateAppleAppIcon,
  validateIosFoundation,
  validateIosOnboarding,
  validateIosSplash,
} from "./apple";
import {
  validateAndroidAppIcon,
  validateAndroidBaseLayout,
  validateAndroidFoundation,
  validateAndroidOnboarding,
  validateAndroidSplash,
} from "./android";
import { validateGoBackendAuthQuality, validateGoBackendConfigEnvConsistency } from "./go";
import { schemaMigrationValidator } from "./prisma";
import {
  accessibilityValidator,
  backendAuthPostureValidator,
  brandFidelityValidator,
  deployShapeValidator,
  externalApiContractValidator,
  platformIsolationValidator,
  toneOfVoiceValidator,
} from "./security";

export type { ValidationIssue, ValidationSummary } from "./core";

const taskValidators: Validator[] = [
  {
    id: "task.setup.environment",
    run(workspace, manifest, runContext) {
      const text = taskText(runContext);
      return /\b(setup|environment|fastlane|swiftlint|gradle|ktlint)\b/.test(text)
        ? validateSetupEnvironment(workspace, manifest, runContext)
        : [];
    },
  },
  {
    id: "task.splash.ios",
    run(workspace, manifest, runContext) {
      if (/\/(?:android|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/(?:ios|macos)(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      return /\bsplash\b/.test(text) && /\bios\b/.test(text) ? validateIosSplash(workspace, manifest, runContext) : [];
    },
  },
  {
    id: "task.splash.android",
    run(workspace, manifest, runContext) {
      // Only EXCLUDE when workspace explicitly indicates a different platform.
      // Empty/test/temp workspaces should fall through to text-based detection.
      if (/\/(?:ios|macos|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/android(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      return /\bsplash\b/.test(text) && /\bandroid\b/.test(text) ? validateAndroidSplash(workspace, manifest) : [];
    },
  },
  {
    id: "task.onboarding.ios",
    run(workspace, manifest, runContext) {
      if (/\/(?:android|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/(?:ios|macos)(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      return /\bonboarding\b/.test(text) && /\bios\b/.test(text) ? validateIosOnboarding(workspace, manifest) : [];
    },
  },
  {
    id: "task.onboarding.android",
    run(workspace, manifest, runContext) {
      // Only EXCLUDE when workspace explicitly indicates a different platform.
      // Empty/test/temp workspaces should fall through to text-based detection.
      if (/\/(?:ios|macos|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/android(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      return /\bonboarding\b/.test(text) && /\bandroid\b/.test(text) ? validateAndroidOnboarding(workspace, manifest) : [];
    },
  },
  {
    id: "task.appIcon.apple",
    run(workspace, manifest, runContext) {
      if (/\/(?:android|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/(?:ios|macos)(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      const fullText = constraintText(runContext);
      const touchedAppleIcon = hasChanged(manifest, /(?:^|\/)AppIcon\.appiconset(?:\/|$)/);
      return (isAppIconTask(text) || (touchedAppleIcon && isAppIconTask(fullText))) &&
        (isApplePlatformTask(text) || touchedAppleIcon)
        ? validateAppleAppIcon(workspace, manifest, runContext)
        : [];
    },
  },
  {
    id: "task.appIcon.android",
    run(workspace, manifest, runContext) {
      // Only EXCLUDE when workspace explicitly indicates a different platform.
      // Empty/test/temp workspaces should fall through to text-based detection.
      if (/\/(?:ios|macos|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/android(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      const fullText = constraintText(runContext);
      const touchedAndroidIcon = hasChanged(manifest, /(?:^|\/)res\/mipmap-[^/]+\/(?:ic_launcher|launcher).*\.(?:png|xml|webp)$/) ||
        hasChanged(manifest, /(?:^|\/)AndroidManifest\.xml$/);
      return (isAppIconTask(text) || (touchedAndroidIcon && isAppIconTask(fullText))) &&
        (isAndroidPlatformTask(text) || touchedAndroidIcon)
        ? validateAndroidAppIcon(workspace, manifest)
        : [];
    },
  },
  {
    id: "task.baseLayout.android",
    run(workspace, manifest, runContext) {
      // Workspace-platform gate: this validator is Android-specific and must
      // not fire on iOS or backend workspaces, even if the prompt text mentions
      // "android" in cross-platform brand or architecture sections.
      // Only EXCLUDE when workspace explicitly indicates a different platform.
      // Empty/test/temp workspaces should fall through to text-based detection.
      if (/\/(?:ios|macos|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/android(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      const fullText = constraintText(runContext);
      const touchedAndroidBaseLayout = hasChanged(manifest, /(?:^|\/)app\/src\/main\/java\/.*(?:navigation|ui)\/.*\.kt$/);
      return (/\bbase layout\b|\blayout base\b|\bplaceholder screens per feature\b|\btelas placeholder por feature\b/.test(fullText) ||
        (touchedAndroidBaseLayout && /\bandroid\b/.test(text))) &&
        /\bandroid\b/.test(fullText)
        ? validateAndroidBaseLayout(workspace, manifest, runContext)
        : [];
    },
  },
  {
    id: "task.foundation.android",
    run(workspace, manifest, runContext) {
      // Only EXCLUDE when workspace explicitly indicates a different platform.
      // Empty/test/temp workspaces should fall through to text-based detection.
      if (/\/(?:ios|macos|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/android(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      const fullText = constraintText(runContext);
      if (/\bbase layout\b|\blayout base\b|\bplaceholder screens per feature\b|\btelas placeholder por feature\b/.test(fullText)) return [];
      const touchedAndroidFoundation = hasChanged(manifest, /(?:^|\/)app\/src\/main\/java\/.*(?:data|navigation|ui\/theme|ui\/components)\/.*\.kt$/) ||
        (manifest.artifactsRead ?? []).some((artifact) => /(?:^|\/)android\/(?:ThemeSystem|NavigationSetup|RoomSetup|FeatureScreenPatterns)\.kt$/.test(artifact));
      return (/\b(foundation|foundations|fundações)\b/.test(text) && /\bandroid\b/.test(text)) || touchedAndroidFoundation
        ? validateAndroidFoundation(workspace, manifest)
        : [];
    },
  },
  {
    id: "task.foundation.ios",
    run(workspace, manifest, runContext) {
      if (/\/(?:android|backend|landing|web)(?:\/|$)/.test(workspace) && !/\/(?:ios|macos)(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      return /\b(foundation|foundations|fundações)\b/.test(text) && /\bios\b/.test(text)
        ? validateIosFoundation(workspace, manifest, runContext)
        : [];
    },
  },
  {
    id: "task.apiClient",
    run(workspace, manifest, runContext) {
      return /\b(api client|api repository|repository|network layer|endpoint)\b/.test(taskText(runContext))
        ? validateApiClient(workspace, manifest)
        : [];
    },
  },
  {
    id: "task.authSession",
    run(workspace, manifest, runContext) {
      return /\b(auth|authentication|session|login|token|profile)\b/.test(taskText(runContext))
        ? validateAuthSession(workspace, manifest)
        : [];
    },
  },
  {
    id: "task.backendHealthApi",
    run(workspace, manifest, runContext) {
      return /\b(backend|api setup|health|route|endpoint|prisma)\b/.test(taskText(runContext))
        ? validateBackendHealthApi(workspace, manifest, runContext)
        : [];
    },
  },
  {
    id: "task.backendSetupEnvironment",
    run(workspace, _manifest, runContext) {
      const text = constraintText(runContext);
      return /\bset\s+up\s+backend\b|\bsetup\s+backend\b|\bbackend\s+(?:setup|environment)\b|\bsetup\s+environment\s+[-—]\s+backend\b/.test(text)
        ? validateBackendSetupEnvironment(workspace)
        : [];
    },
  },
  {
    id: "task.goBackendConfigEnvConsistency",
    run(workspace, _manifest, runContext) {
      const text = constraintText(runContext);
      const isBackendWorkspace = inferPrimaryPlatform(workspace) === "backend" || /(?:^|\/)backend(?:\/|$)/.test(workspace);
      const isGoBackendSetup = /\binitialize\s+go\s+backend\b|\bgo-backend-init\b|\bgo\s+backend\s+(?:init|setup|skeleton)\b|\bbackend\s+(?:setup|environment)\b/i.test(text);
      return isBackendWorkspace && isGoBackendSetup
        ? validateGoBackendConfigEnvConsistency(workspace)
        : [];
    },
  },
  {
    id: "task.goBackendAuthQuality",
    run(workspace, manifest, runContext) {
      return validateGoBackendAuthQuality(workspace, manifest, runContext);
    },
  },
  {
    id: "task.revenuecat",
    run(workspace, manifest, runContext) {
      return /\b(revenuecat|paywall|subscription|premium|entitlement|purchase|webhook)\b/.test(taskText(runContext))
        ? validateRevenueCat(workspace, manifest)
        : [];
    },
  },
  backendAuthPostureValidator,
  brandFidelityValidator,
  toneOfVoiceValidator,
  accessibilityValidator,
  platformIsolationValidator,
  schemaMigrationValidator,
  deployShapeValidator,
  externalApiContractValidator,
];

export async function validateCodingTask(
  workspace: string,
  manifest: ValidationManifest,
  runContext?: TanyaRunContext,
  options: { gateScanFiles?: string[] } = {},
): Promise<ValidationSummary> {
  const validators = [...coreValidators, ...taskValidators];
  const issues: ValidationIssue[] = [];
  const firedValidatorIds: string[] = [];
  for (const validator of validators) {
    const validatorIssues = await validator.run(workspace, manifest, runContext);
    if (validatorIssues.length > 0) {
      firedValidatorIds.push(validator.id);
      issues.push(...validatorIssues);
    }
  }
  // Gate also runs against any files committed since the run started, even when
  // changedFiles is empty (verification-only attempt). Closes the blind spot where
  // a prior attempt's violation persisted in HEAD but the current attempt didn't
  // touch it. Caller passes \`gateScanFiles = union(changedFiles, committedFiles)\`.
  const filesForGate = (options.gateScanFiles && options.gateScanFiles.length > 0)
    ? options.gateScanFiles
    : manifest.changedFiles;
  const gateIssues = await scanForbiddenPatterns(workspace, filesForGate);
  if (gateIssues.length > 0) firedValidatorIds.push("forbidden-patterns-gate");
  issues.push(...gateIssues);
  const primaryPlatform = inferPrimaryPlatform(workspace) ?? "unknown";
  return {
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    firedValidatorIds,
    primaryPlatform,
  };
}

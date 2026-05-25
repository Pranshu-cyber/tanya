import type { TanyaRunContext } from "../../context/runContext";
import {
  changedMatching,
  constraintText,
  findWorkspaceFiles,
  hasChanged,
  hasDedicatedCtaSlide,
  hasSuccessfulVerification,
  readWorkspaceFile,
  taskText,
  uniqueSorted,
  type ValidationIssue,
  type ValidationManifest,
} from "./core";

export async function validateIosSplash(workspace: string, manifest: ValidationManifest, runContext?: TanyaRunContext): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const text = constraintText(runContext);
  const wantsSolidBackground = /\bsolid\b/i.test(text) || /\bno gradients?\b/i.test(text);
  const wantsGradient = /\bgradient\b/i.test(text) && !wantsSolidBackground;
  const wantsElevatedTile = /\b(?:rounded|elevated|tile|card)\b/i.test(text);
  const wantsShadow = /\b(?:shadow|glow)\b/i.test(text);
  const wantsPulse = /\b(?:pulse|repeat(?:-| )?forever)\b/i.test(text);
  const wantsAppName = /\b(?:app name|application name|show (?:the )?(?:name|title)|title below|name below)\b/i.test(text);
  const forbidsText = /\b(?:no taglines?|no text|image\(\"splashicon\"\)\s+only|icon\s+only)\b/i.test(text);
  if (!hasChanged(manifest, /(?:^|\/)SplashScreenView\.swift$/)) {
    issues.push({
      id: "ios-splash-view-missing",
      severity: "error",
      message: "iOS splash task did not modify or create SplashScreenView.swift.",
    });
    return issues;
  }

  const splashPath = manifest.changedFiles.find((file) => /(?:^|\/)SplashScreenView\.swift$/.test(file)) ?? "SplashScreenView.swift";
  const splash = await readWorkspaceFile(workspace, splashPath);
  if (!splash) {
    issues.push({ id: "ios-splash-view-unreadable", severity: "error", message: "Could not read SplashScreenView.swift for validation.", files: [splashPath] });
    return issues;
  }

  if (!/Image\(\s*"SplashIcon"\s*\)/.test(splash)) {
    issues.push({ id: "ios-splash-icon-image", severity: "error", message: "SplashScreenView.swift must use Image(\"SplashIcon\").", files: [splashPath] });
  }
  if (!/onAppear\s*\{[\s\S]*Task\s*\{[\s\S]*Task\.sleep[\s\S]*isReady\s*=\s*true/.test(splash)) {
    issues.push({ id: "ios-splash-onappear-task", severity: "error", message: "SplashScreenView.swift must use onAppear with Task.sleep before setting isReady = true.", files: [splashPath] });
  }
  if (/\.task\s*\{/.test(splash)) {
    issues.push({ id: "ios-splash-task-modifier", severity: "error", message: "SplashScreenView.swift must not use a SwiftUI .task modifier for the splash delay.", files: [splashPath] });
  }
  if (wantsGradient && !/LinearGradient\s*\(/.test(splash) && !/RadialGradient\s*\(/.test(splash)) {
    issues.push({ id: "ios-splash-gradient-missing", severity: "error", message: "SplashScreenView.swift must render a brand gradient background, not a flat color only.", files: [splashPath] });
  }
  if (wantsElevatedTile && !/RoundedRectangle\s*\(/.test(splash)) {
    issues.push({ id: "ios-splash-elevated-tile-missing", severity: "error", message: "SplashScreenView.swift must place SplashIcon inside a rounded elevated tile.", files: [splashPath] });
  }
  if (wantsShadow && !/shadow\s*\(/.test(splash)) {
    issues.push({ id: "ios-splash-shadow-missing", severity: "error", message: "Splash icon tile must include an elevated shadow/glow.", files: [splashPath] });
  }
  if (wantsPulse && (!/repeatForever\s*\(/.test(splash) || !/scaleEffect\s*\(/.test(splash))) {
    issues.push({ id: "ios-splash-pulse-missing", severity: "error", message: "Splash icon tile must include a slow repeat-forever pulse animation.", files: [splashPath] });
  }
  if (wantsAppName && !/Text\s*\(\s*"/.test(splash)) {
    issues.push({ id: "ios-splash-app-name-missing", severity: "error", message: "SplashScreenView.swift must show the app name below the icon.", files: [splashPath] });
  }
  if (forbidsText && /Text\s*\(/.test(splash)) {
    issues.push({ id: "ios-splash-text-forbidden", severity: "error", message: "Splash task requested no taglines/text; SplashScreenView.swift must render only the splash icon.", files: [splashPath] });
  }
  if (wantsSolidBackground && (/LinearGradient\s*\(/.test(splash) || /RadialGradient\s*\(/.test(splash) || /AngularGradient\s*\(/.test(splash))) {
    issues.push({ id: "ios-splash-solid-background-violated", severity: "error", message: "Splash task requested a solid background, but SplashScreenView.swift uses a gradient.", files: [splashPath] });
  }
  if (/\bnothing else\b|brief fade-in/i.test(text) && (/repeatForever\s*\(/.test(splash) || /scaleEffect\s*\(/.test(splash) || /\.transition\s*\(/.test(splash) || /\.animation\s*\([\s\S]{0,120}value:\s*isReady/.test(splash))) {
    issues.push({ id: "ios-splash-extra-animation", severity: "error", message: "Splash task requested only a brief fade-in, but SplashScreenView.swift adds extra animation.", files: [splashPath] });
  }
  const usesExplicitBrandRed = /#A52A2A/i.test(splash) || /165\s*\/\s*255[\s\S]*42\s*\/\s*255[\s\S]*42\s*\/\s*255/.test(splash) || /0\.647[\s\S]*0\.165[\s\S]*0\.165/.test(splash);
  if (/Color\.accentColor/.test(splash) && !usesExplicitBrandRed) {
    issues.push({ id: "ios-splash-accentcolor-only", severity: "error", message: "Splash background uses Color.accentColor without explicit brand-red fallback evidence.", files: [splashPath] });
  }
  if (!usesExplicitBrandRed && !/brand/i.test(splash)) {
    issues.push({ id: "ios-splash-brand-color-missing", severity: "warning", message: "Could not confirm explicit brand color usage in SplashScreenView.swift.", files: [splashPath] });
  }
  if (!hasChanged(manifest, /(?:^|\/)SplashIcon\.imageset\/Contents\.json$/)) {
    issues.push({ id: "ios-splash-asset-json-missing", severity: "error", message: "iOS splash task did not create SplashIcon.imageset/Contents.json." });
  }
  return issues;
}

export async function validateAppleAppIcon(workspace: string, manifest: ValidationManifest, runContext?: TanyaRunContext): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const text = taskText(runContext);
  const contentsPath = manifest.changedFiles.find((file) => /(?:^|\/)AppIcon\.appiconset\/Contents\.json$/.test(file));
  if (!contentsPath) {
    return [{ id: "apple-app-icon-contents-missing", severity: "error", message: "Apple app icon task did not create or modify AppIcon.appiconset/Contents.json." }];
  }
  const raw = await readWorkspaceFile(workspace, contentsPath);
  if (!raw) {
    return [{ id: "apple-app-icon-contents-unreadable", severity: "error", message: "Could not read AppIcon.appiconset/Contents.json.", files: [contentsPath] }];
  }
  let parsed: { images?: Array<{ idiom?: string; size?: string; filename?: string }> };
  try {
    parsed = JSON.parse(raw) as { images?: Array<{ idiom?: string; size?: string; filename?: string }> };
  } catch {
    return [{ id: "apple-app-icon-contents-invalid-json", severity: "error", message: "AppIcon.appiconset/Contents.json is not valid JSON.", files: [contentsPath] }];
  }
  const images = Array.isArray(parsed.images) ? parsed.images : [];
  const idioms = new Set(images.map((image) => image.idiom).filter(Boolean));
  for (const idiom of ["iphone", "ipad", "ios-marketing"]) {
    if (!idioms.has(idiom)) {
      issues.push({ id: "apple-app-icon-idiom-missing", severity: "error", message: `AppIcon.appiconset is missing required idiom: ${idiom}.`, files: [contentsPath] });
    }
  }
  if (/\bmac(?:os)?\b/.test(text)) {
    const macImages = images.filter((image) => image.idiom === "mac");
    const macSizes = new Set(macImages.map((image) => (image as { size?: string }).size).filter(Boolean));
    for (const size of ["16x16", "32x32", "128x128", "256x256", "512x512"]) {
      if (!macSizes.has(size)) {
        issues.push({ id: "apple-app-icon-mac-size-missing", severity: "error", message: `AppIcon.appiconset is missing required macOS size: ${size}.`, files: [contentsPath] });
      }
    }
    if (macImages.length < 10) {
      issues.push({ id: "apple-app-icon-mac-slots-incomplete", severity: "error", message: "AppIcon.appiconset must include the 10 standard macOS icon slots.", files: [contentsPath] });
    }
  }
  const pngFiles = images.map((image) => image.filename).filter((filename): filename is string => !!filename);
  if (pngFiles.length === 0) {
    issues.push({ id: "apple-app-icon-pngs-missing", severity: "error", message: "AppIcon.appiconset has no PNG filenames.", files: [contentsPath] });
  }
  const iconDir = contentsPath.replace(/Contents\.json$/, "");
  for (const filename of pngFiles.slice(0, 80)) {
    const iconPath = `${iconDir}${filename}`;
    if (!await readWorkspaceFile(workspace, iconPath).then((content) => content !== null)) {
      issues.push({ id: "apple-app-icon-png-missing", severity: "error", message: `AppIcon PNG listed in Contents.json is missing: ${iconPath}`, files: [contentsPath] });
      break;
    }
  }
  if (!hasSuccessfulVerification(manifest, /\bxcodebuild\s+build\b/i)) {
    issues.push({
      id: "apple-app-icon-xcodebuild-missing",
      severity: "error",
      message: "Apple app icon task must run and report a successful xcodebuild build to catch asset catalog warnings.",
      files: [contentsPath],
    });
  }
  return issues;
}

export async function validateIosOnboarding(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const onboardingPath = manifest.changedFiles.find((file) => /(?:^|\/)OnboardingView\.swift$/.test(file)) ??
    (await findWorkspaceFiles(workspace, (file) => /(?:^|\/)OnboardingView\.swift$/.test(file), { limit: 10 }))[0];
  if (!onboardingPath) {
    return [{ id: "ios-onboarding-view-missing", severity: "error", message: "iOS onboarding task must create or update OnboardingView.swift." }];
  }
  const onboarding = await readWorkspaceFile(workspace, onboardingPath);
  if (!onboarding) return [{ id: "ios-onboarding-view-unreadable", severity: "error", message: "Could not read OnboardingView.swift.", files: [onboardingPath] }];

  if (!/TabView\s*\(/.test(onboarding) || !/\.tabViewStyle\s*\(\s*\.page/.test(onboarding)) {
    issues.push({ id: "ios-onboarding-tabview-missing", severity: "error", message: "OnboardingView.swift must use a paged TabView.", files: [onboardingPath] });
  }
  if (!/@AppStorage\s*\(\s*"hasSeenOnboarding"\s*\)/.test(onboarding) && !/UserDefaults[\s\S]*hasSeenOnboarding/.test(onboarding)) {
    issues.push({ id: "ios-onboarding-storage-key-missing", severity: "error", message: "iOS onboarding must persist completion with the exact hasSeenOnboarding key.", files: [onboardingPath] });
  }
  if (!/\bPular\b/.test(onboarding)) {
    issues.push({ id: "ios-onboarding-skip-missing", severity: "error", message: "OnboardingView.swift must include the pt-BR skip button `Pular`.", files: [onboardingPath] });
  } else {
    const skipIndex = onboarding.indexOf("Pular");
    const bottomOverlayIndex = onboarding.search(/VStack\s*\{\s*Spacer\s*\(\s*\)/);
    if (bottomOverlayIndex >= 0 && skipIndex > bottomOverlayIndex) {
      issues.push({ id: "ios-onboarding-skip-not-top-right", severity: "error", message: "`Pular` must be positioned in a top-right overlay outside the bottom controls stack.", files: [onboardingPath] });
    }
    if (!/currentPage\s*<\s*(?:totalPages|slides\.count)\s*-\s*1[\s\S]{0,220}\bPular\b|\bPular\b[\s\S]{0,220}currentPage\s*<\s*(?:totalPages|slides\.count)\s*-\s*1/.test(onboarding)) {
      issues.push({ id: "ios-onboarding-skip-last-slide-guard", severity: "error", message: "`Pular` must be hidden on the final CTA slide.", files: [onboardingPath] });
    }
  }
  if (!hasDedicatedCtaSlide(onboarding, "ios")) {
    issues.push({ id: "ios-onboarding-final-cta-slide-missing", severity: "error", message: "The final onboarding page must be a dedicated CTA slide, not another feature slide with footer CTA buttons.", files: [onboardingPath] });
  }
  if (!/\bComeçar grátis\b/.test(onboarding) || !/\bJá tenho conta\b/.test(onboarding)) {
    issues.push({ id: "ios-onboarding-cta-copy-missing", severity: "error", message: "Final CTA slide must include `Começar grátis` and `Já tenho conta`.", files: [onboardingPath] });
  }
  if (!hasSuccessfulVerification(manifest, /\bxcodebuild\s+build\b/i)) {
    issues.push({ id: "ios-onboarding-xcodebuild-missing", severity: "error", message: "iOS onboarding task must run and report a successful xcodebuild build.", files: [onboardingPath] });
  }
  return issues;
}

export async function validateIosFoundation(workspace: string, manifest: ValidationManifest, runContext?: TanyaRunContext): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const discoveredSwiftFiles = await findWorkspaceFiles(
    workspace,
    (file) => /\.swift$/.test(file) && !/(?:^|\/)\.tanya\//.test(file),
    { roots: ["."], limit: 160 },
  );
  const swiftFiles = uniqueSorted([
    ...changedMatching(manifest, /(?:^|\/)[^/].*\.swift$/),
    ...discoveredSwiftFiles,
  ]);
  const fontFiles = await findWorkspaceFiles(
    workspace,
    (file) => /\.(?:ttf|otf)$/i.test(file) && !/(?:^|\/)\.tanya\//.test(file),
    { roots: ["."], limit: 80 },
  );
  const fileTexts = new Map<string, string>();
  for (const file of swiftFiles) fileTexts.set(file, await readWorkspaceFile(workspace, file) ?? "");
  const combinedSwift = swiftFiles.map((file) => fileTexts.get(file) ?? "").join("\n");
  const text = constraintText(runContext);
  const wantsDarkMode = /\bdark mode\b|\bdark-mode\b|\bmodo escuro\b/i.test(text);
  const wantsBrandFonts = /\bplayfair\b|\broboto\b|\bbrand rules?\b|\btypograph/i.test(text);

  if (!/#1A2F4B|0x1A2F4B|26\s*\/\s*255[\s\S]*47\s*\/\s*255[\s\S]*75\s*\/\s*255/.test(combinedSwift) ||
      !/#C8AE7F|0xC8AE7F|200\s*\/\s*255[\s\S]*174\s*\/\s*255[\s\S]*127\s*\/\s*255/.test(combinedSwift)) {
    issues.push({ id: "ios-foundation-brand-colors-missing", severity: "error", message: "iOS foundation must define the Cosa Nostra brand colors (#1A2F4B and #C8AE7F).", files: swiftFiles });
  }
  if (!/@Model\b|ModelContainer\s*\(|Schema\s*\(/.test(combinedSwift)) {
    issues.push({ id: "ios-foundation-swiftdata-missing", severity: "error", message: "iOS foundation must add SwiftData models and app container wiring.", files: swiftFiles });
  }
  if (!/TabView\s*(?:\(|\{)|NavigationStack\s*(?:\(|\{)/.test(combinedSwift)) {
    issues.push({ id: "ios-foundation-navigation-missing", severity: "error", message: "iOS foundation must add TabView/NavigationStack app navigation.", files: swiftFiles });
  }
  if (!/ViewModifier\b|ButtonStyle\b|EmptyState|LoadingView|ErrorView/.test(combinedSwift)) {
    issues.push({ id: "ios-foundation-base-ui-missing", severity: "error", message: "iOS foundation must add reusable view modifiers, button styles, and empty/loading/error UI states.", files: swiftFiles });
  }
  if (wantsDarkMode) {
    if (!/preferredColorScheme\s*\(/.test(combinedSwift)) {
      issues.push({ id: "ios-foundation-dark-mode-scheme-missing", severity: "error", message: "iOS foundation must wire dark-mode color scheme support.", files: swiftFiles });
    }
    if (!/Toggle\s*\([^)]*(?:isDarkMode|darkMode|colorScheme)|Picker\s*\([^)]*(?:Color Scheme|Appearance|Theme)/.test(combinedSwift)) {
      issues.push({ id: "ios-foundation-dark-mode-control-missing", severity: "error", message: "iOS foundation must include a user-facing dark-mode control, not only stored state.", files: swiftFiles });
    }
    if (/foreground(?:Style|Color)\s*\(\s*Color\.brandWhite\s*\)|foreground(?:Style|Color)\s*\(\s*\.brandWhite\s*\)/.test(combinedSwift)) {
      issues.push({ id: "ios-foundation-hardcoded-dark-text", severity: "warning", message: "iOS foundation uses hardcoded brandWhite foregrounds; confirm adaptive text colors for light and dark mode.", files: swiftFiles });
    }
  }
  if (wantsBrandFonts) {
    const mentionsFonts = /Playfair|Roboto/.test(combinedSwift);
    const hasFontFiles = fontFiles.some((file) => /(?:Playfair|Roboto)/i.test(file));
    if (!mentionsFonts) {
      issues.push({ id: "ios-foundation-brand-fonts-missing", severity: "error", message: "iOS foundation must define Playfair Display and Roboto typography tokens.", files: swiftFiles });
    } else if (/\bmanual action\b|\bmanual follow-?up\b|add .*font files|UIAppFonts/i.test(combinedSwift)) {
      issues.push({ id: "ios-foundation-manual-font-action", severity: "error", message: "iOS foundation must not leave brand font setup as a manual action; use provided font assets or a local system-font fallback.", files: swiftFiles });
    } else if (!hasFontFiles && !/\.serif\b|design:\s*\.serif|system\s+serif|system\s+font/i.test(combinedSwift)) {
      issues.push({ id: "ios-foundation-brand-font-fallback-missing", severity: "warning", message: "Playfair/Roboto font files were not found; typography should include an explicit local system-font fallback.", files: swiftFiles });
    }
  }
  return issues;
}

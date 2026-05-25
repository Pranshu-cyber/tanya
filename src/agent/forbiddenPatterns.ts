import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ValidationIssue } from "./validators";

export type ForbiddenPattern = {
  id: string;
  pattern: RegExp;
  filePattern: RegExp;
  message: string;
  severity?: "error" | "warning";
  excludeFilePattern?: RegExp;
  // Optional file-level guard: if this regex matches the file's full content,
  // suppress the violation. Used for "the pattern's intent is conditional on
  // surrounding context." Example: `Purchases.logLevel = .debug` is a violation
  // ONLY if the file doesn't wrap it in `#if DEBUG ... #endif`. Set
  // `suppressIfFileMatches` to a regex that detects the safe wrapping form.
  suppressIfFileMatches?: RegExp;
};

const TEST_DIR_EXCLUSIONS = /(?:^|\/)(?:test|tests|__tests__|spec|specs|androidTest)(?:\/|$)/;

export const DEFAULT_FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    id: "android-http-logging-body",
    pattern: /HttpLoggingInterceptor\.Level\.BODY\b/,
    filePattern: /\.kt$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "HttpLoggingInterceptor.Level.BODY logs Bearer/refresh tokens to logcat. Use Level.NONE in production, or Level.BASIC gated behind BuildConfig.DEBUG.",
    severity: "error",
  },
  {
    id: "ios-google-signin-stub",
    pattern: /\/\/\s*(?:GoogleSignInButton|GoogleSignIn[A-Za-z]*\(\)|Uncomment\s+when\s+Google\s+Sign[\s-]?In)/i,
    filePattern: /LoginView\.swift$/,
    message: "Google Sign In button is commented out. Either implement fully via the GoogleSignIn SPM package, or omit the button entirely — do not leave a commented stub.",
    severity: "error",
  },
  {
    id: "ios-google-signin-todo-stub",
    pattern: /\/\/\s*TODO[^\n]*Google\s*Sign[\s-]?In/i,
    filePattern: /\.swift$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Google Sign In integration is TODO-stubbed. Implement fully via GoogleSignIn SPM, or remove the placeholder.",
    severity: "error",
  },
  {
    id: "android-missing-google-client-id-literal",
    // Match every realistic placeholder shape we've seen ship: the fully-qualified
    // YOUR_WEB_CLIENT_ID.apps.googleusercontent.com, the bare YOUR_WEB_CLIENT_ID_HERE
    // sentinel that a prior audit caught in strings.xml, plus generic
    // YOUR_*_CLIENT_ID and *_CLIENT_ID_HERE shapes. Anchored so legitimate identifier
    // names like 'GOOGLE_CLIENT_ID' (no _HERE/_PLACEHOLDER suffix, used in real env
    // var docstrings) don't fire.
    pattern: /MISSING_GOOGLE_CLIENT_ID|YOUR_(?:WEB_|IOS_|ANDROID_)?CLIENT_ID(?:_HERE|_PLACEHOLDER|\.apps\.googleusercontent\.com)|YOUR_WEB_CLIENT_ID_HERE/,
    filePattern: /(?:strings\.xml|\.kt|\.java)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Google Client ID is a literal placeholder (YOUR_*_CLIENT_ID_HERE or YOUR_*.apps.googleusercontent.com). Replace with the real ID from Google Cloud Console before shipping.",
    severity: "error",
  },
  {
    id: "stub-todo-in-auth-or-billing-route",
    // Catches the 2026-05-01 audit finding: auth/3 backend shipped routes with
    // `// TODO: Send email via Brevo API` and returned success without delivering.
    // Pattern: any `// TODO` or `# TODO` comment inside backend route files for
    // auth/billing/email/payment paths. These stubs let the route succeed in CI
    // but fail silently in production. The route must either implement fully or
    // fail-closed (HTTP 500 + structured error code).
    pattern: /(?:\/\/|#)\s*(?:TODO|FIXME|XXX)\s*[:\-]?\s*(?:send|implement|wire|integrate|connect|add)\s+(?:email|brevo|stripe|webhook|notification|sms|push|payment|charge|refund|otp|magic\s*link)/i,
    filePattern: /(?:\/api\/(?:auth|billing|webhooks|payment|email|notifications)\/|routes\/(?:auth|billing|webhooks|payment|email|notifications)\/).*\.(?:ts|tsx|js|mjs|py|rb|go)$/i,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Stub TODO in a security-critical route handler (auth/billing/webhook/email/notifications). Either implement the call OR fail-closed with HTTP 500 + a structured error code (e.g. { error: \"EMAIL_NOT_CONFIGURED\" }). Routes that return success without doing the work cause silent production failures.",
    severity: "error",
  },
  {
    id: "android-paywall-empty-callback",
    // 2026-05-01 audit: AppNavigation.kt shipped with
    // `onSubscribeClick = { /* RevenueCat integration placeholder */ }`. The
    // happy path worked because PaywallScreen called billing.purchase()
    // directly inline, but the fallback FallbackPricingCard route was silent.
    pattern: /onSubscribeClick\s*=\s*\{\s*(?:\/\*[^*]*(?:placeholder|TODO|FIXME|stub)[^*]*\*\/|\/\/[^\n]*(?:placeholder|TODO|FIXME|stub)[^\n]*)?\s*\}/i,
    filePattern: /\.kt$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Empty / placeholder paywall callback in Kotlin. Fallback path must call billing.purchase() the same way the happy path does — silent fallback failures break premium when RevenueCat offerings can't load.",
    severity: "error",
  },
  {
    id: "ios-purchases-loglevel-debug",
    // Caught in 2026-05-01 audit: RevenueCatManager.swift shipped with
    // `Purchases.logLevel = .debug` not gated behind #if DEBUG. The artifact
    // (SubscriptionManagerFull.swift) uses `.info` — agent didn't faithfully
    // reuse and substituted a louder default. Keep verbose RevenueCat logs
    // out of release builds.
    pattern: /\bPurchases\.logLevel\s*=\s*\.(?:debug|verbose)\b/,
    filePattern: /\.swift$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    // Suppress when the file already wraps the assignment in `#if DEBUG ... #endif`
    // with a release-build branch using .info or .error. Detected with two
    // independent file-level checks (#if DEBUG present + .debug + .info/.error
    // present + #endif). This avoids the false positive caught 2026-05-01 where
    // RevenueCatManager.swift was correctly wrapped but the gate still fired.
    suppressIfFileMatches: /#if\s+DEBUG[\s\S]{0,200}?Purchases\.logLevel\s*=\s*\.(?:debug|verbose)[\s\S]{0,200}?#else[\s\S]{0,200}?Purchases\.logLevel\s*=\s*\.(?:info|error|warn)[\s\S]{0,200}?#endif/,
    message: "Purchases.logLevel set to .debug or .verbose unconditionally. Wrap in `#if DEBUG ... #endif` so release builds use .info or .error. Verbose logs in production add console noise and on some SDK versions can leak sandbox-receipt blobs — treat as a release-build security issue.",
    severity: "error",
  },
  {
    id: "ios-rolled-own-rounded-rect",
    // Catches `RoundedRectangle(cornerRadius:` in feature/screen files, which
    // signals the agent rolled its own card/button instead of using BrandedComponents.
    // Token files (Theme*, Colors*) and the BrandedComponents/ReusableComponents files
    // legitimately use it — those are excluded.
    pattern: /\bRoundedRectangle\s*\(\s*cornerRadius\s*:/,
    filePattern: /(?:Feature|Screen|View|Paywall|Dashboard|Tab|Detail)\.swift$/i,
    excludeFilePattern: /(?:BrandedComponents|ReusableComponents|Theme|Colors|Typography|ColorHex|StoreKit|RevenueCat|Tests?|Preview)\.swift$/i,
    message: "Feature screen contains `RoundedRectangle(cornerRadius:`. Use BrandedComponents (PrimaryCTAButton / BrandedHeroCard / StatTile / BrandedListRow / BrandedEmptyState) instead of rolling your own primitives. Brand consistency depends on every screen using the same component vocabulary.",
    severity: "warning",
  },
  {
    id: "android-rolled-own-card",
    // Catches `Card(` Material 3 usage in feature/screen files (it bypasses
    // BrandedComponents). Allow ElevatedCard/OutlinedCard distinction explicitly
    // by matching only the bare `Card(` form.
    pattern: /(?<!\w)Card\s*\(\s*(?:modifier|content|onClick|colors|elevation|border|shape|enabled|interactionSource)/,
    filePattern: /(?:Screen|View|Composable|Paywall|Dashboard)\.kt$/i,
    excludeFilePattern: /(?:BrandedComponents|Theme|ColorScheme|Typography|Tokens|Tests?|Preview)\.kt$/i,
    message: "Feature screen uses Material 3 `Card(...)` directly. Use BrandedComponents (BrandedHeroCard / StatTile / BrandedListRow / BrandedEmptyState) instead — they wrap Card with brand-correct surface/border/elevation tokens.",
    severity: "warning",
  },
  {
    id: "ios-todo-replace-pinned-hash",
    // Caught in 2026-05-01 audit: SessionStore.swift had pinnedHashes containing
    // 'TODO-REPLACE-WITH-PRODUCTION-PINNED-HASH-1' literal strings while certificate
    // pinning was actively enforced — meant ALL API calls would be cancelled in
    // production. This pattern is broader than the iOS-Google-Sign-In one because
    // pinning failures are silent and only show up under live network use.
    pattern: /["']TODO[-_]?REPLACE[-_]?WITH[-_]?(?:PRODUCTION[-_]?)?PINNED[-_]?HASH[^"']*["']/,
    filePattern: /\.swift$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Certificate pinning hash is a TODO-REPLACE placeholder. With pinning enforced, every production API call will be cancelled. Either replace with the real SHA-256 hash or disable the pinning delegate before release.",
    severity: "error",
  },
  {
    id: "leaked-token-console-log",
    pattern: /console\.log\([^)]*\b(?:accessToken|refreshToken|password|bearer)\b/i,
    filePattern: /\.(?:ts|tsx|js|jsx)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "console.log includes a token/password. Strip secret fields before logging.",
    severity: "error",
  },
  {
    id: "react-dangerouslysetinnerhtml-without-sanitizer",
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:(?!\s*(?:DOMPurify|sanitize|sanitizeHtml|purify))/,
    filePattern: /\.(?:tsx|jsx)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "dangerouslySetInnerHTML used without a recognized sanitizer call. Wrap with DOMPurify/sanitize/sanitizeHtml or render the value as text.",
    severity: "error",
  },
  {
    id: "javascript-eval",
    pattern: /(?:^|[^.\w])eval\s*\(/,
    filePattern: /\.(?:ts|tsx|js|jsx)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "eval() is a code-injection vector. Use JSON.parse, function references, or a safe interpreter instead.",
    severity: "error",
  },
  {
    id: "hardcoded-bearer-token",
    pattern: /["']\s*Bearer\s+(?:eyJ|sk-|gho_|ghp_|ghs_|gha_|ghu_|xox[abops]-)/i,
    filePattern: /\.(?:ts|tsx|js|jsx|swift|kt|java)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Hardcoded Bearer token detected. Read from env / Keychain / EncryptedSharedPreferences instead.",
    severity: "error",
  },
  {
    id: "production-bind-all-interfaces",
    pattern: /(?:host|address|listen|bind)\s*[:=]\s*['"]0\.0\.0\.0['"]/,
    filePattern: /\.(?:ts|tsx|js|jsx|json|ya?ml|conf|env)$/,
    excludeFilePattern: /(?:^|\/)(?:test|tests|__tests__|spec|specs|androidTest|docker|Dockerfile)(?:\/|$)|\.local\.|\.example\./,
    message: "Binding to 0.0.0.0 in non-container code can expose services unintentionally. Use 127.0.0.1 (or environment-driven host) outside of explicit container/dev configs.",
    severity: "warning",
  },
  {
    id: "unsafe-json-parse-network-input",
    pattern: /JSON\.parse\(\s*await\s+(?:response|res|fetch|r)\.text\(\)\s*\)/,
    filePattern: /\.(?:ts|tsx|js|jsx)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "JSON.parse on raw network text without try/catch will crash on malformed responses. Wrap in try/catch or use response.json() with a guard.",
    severity: "warning",
  },
  {
    id: "android-plain-shared-preferences-for-tokens",
    pattern: /getSharedPreferences\([^)]+\)[\s\S]{0,400}?\b(?:accessToken|refreshToken|authToken|jwt)\b/i,
    filePattern: /\.kt$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Storing tokens in plain SharedPreferences is unsafe. Use EncryptedSharedPreferences (androidx.security.crypto).",
    severity: "error",
  },
  {
    id: "backend-prisma-db-push-in-deploy",
    pattern: /\bprisma\s+db\s+push\b/,
    filePattern: /(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/i,
    message: "Use `prisma migrate deploy` (versioned migrations) in production, not `prisma db push`. The latter applies declarative diffs that can drop tables silently. Author migrations locally with `prisma migrate dev` and commit prisma/migrations/.",
    severity: "error",
  },
  {
    id: "backend-silent-db-failure-in-boot",
    pattern: /\bprisma\s+(?:migrate\s+deploy|db\s+push|migrate\s+resolve)\b[^\n]*\|\|\s*true\b/,
    filePattern: /(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/.*\.ya?ml|.*\.sh)$/i,
    message: "`|| true` after a Prisma migrate/push command silently swallows schema drift and produces a half-broken backend. Let the command fail loudly so the deploy is marked unhealthy.",
    severity: "error",
  },
  {
    id: "backend-db-bootstrap-redirected-to-tmp",
    pattern: /\bprisma\s+(?:migrate\s+deploy|db\s+push)\b[^\n]*>\s*\/tmp\/[^\s]+\b/,
    filePattern: /(?:^|\/)(?:Dockerfile|docker-compose\.ya?ml|.*\.sh)$/i,
    message: "Redirecting prisma output to /tmp hides failures from Azure App Service log streams. Stream to stdout/stderr so failures show up in the platform logs.",
    severity: "warning",
  },
  {
    id: "backend-from-email-rfc822-passed-to-provider",
    pattern: /(?:from|sender)\s*:\s*\{[^}]*email\s*:\s*(?:fromEmail|process\.env\.FROM_EMAIL)[^}]*\}/,
    filePattern: /\.(?:ts|tsx|js|mjs)$/,
    excludeFilePattern: TEST_DIR_EXCLUSIONS,
    message: "Brevo/Sendgrid/Mailgun reject sender.email when it contains an RFC-822 display-name wrapper (e.g. \"Name <a@b.com>\"). Parse FROM_EMAIL into name + email before sending. See lib/email.ts parser pattern.",
    severity: "error",
  },
  {
    id: "backend-prisma-postinstall-without-schema",
    // Positive match for the broken order: `RUN npm ci` line followed somewhere
    // later in the file by `COPY ... prisma`. If that pairing exists, the
    // postinstall hook (prisma generate) runs before the schema is on disk.
    pattern: /^[^\n]*RUN\s+npm\s+(?:ci|install)\b[\s\S]*?\bCOPY\s+(?:[^\n]*\s)?prisma\b/m,
    filePattern: /(?:^|\/)Dockerfile$/i,
    message: "Dockerfile runs `npm ci/install` (which triggers `postinstall: prisma generate`) before `COPY prisma/`. The schema won't exist yet — generate fails. Move `COPY prisma ./prisma/` BEFORE `npm ci`.",
    severity: "error",
  },
];

type ForbiddenPatternConfig = {
  patterns?: Array<{
    id: string;
    pattern: string;
    flags?: string;
    filePattern: string;
    filePatternFlags?: string;
    excludeFilePattern?: string;
    excludeFilePatternFlags?: string;
    message: string;
    severity?: "error" | "warning";
  }>;
};

async function loadProjectForbiddenPatterns(workspace: string): Promise<ForbiddenPattern[]> {
  const candidate = join(workspace, ".tanya", "forbidden-patterns.json");
  if (!existsSync(candidate)) return [];
  try {
    const raw = await readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as ForbiddenPatternConfig;
    return (parsed.patterns ?? []).map((p) => ({
      id: p.id,
      pattern: new RegExp(p.pattern, p.flags),
      filePattern: new RegExp(p.filePattern, p.filePatternFlags),
      ...(p.excludeFilePattern ? { excludeFilePattern: new RegExp(p.excludeFilePattern, p.excludeFilePatternFlags) } : {}),
      message: p.message,
      ...(p.severity ? { severity: p.severity } : {}),
    }));
  } catch {
    return [];
  }
}

export async function scanForbiddenPatterns(
  workspace: string,
  changedFiles: string[],
  patterns?: ForbiddenPattern[],
): Promise<ValidationIssue[]> {
  const projectPatterns = await loadProjectForbiddenPatterns(workspace);
  const effective = patterns ?? [...DEFAULT_FORBIDDEN_PATTERNS, ...projectPatterns];
  const issues: ValidationIssue[] = [];
  const fireCounts = new Map<string, number>();
  for (const file of changedFiles) {
    const matchingPatterns = effective.filter((p) => p.filePattern.test(file) && !(p.excludeFilePattern && p.excludeFilePattern.test(file)));
    if (matchingPatterns.length === 0) continue;
    let content: string;
    try {
      content = await readFile(join(workspace, file), "utf8");
    } catch {
      continue;
    }
    for (const pattern of matchingPatterns) {
      if (pattern.pattern.test(content)) {
        // File-level suppression: if pattern.suppressIfFileMatches matches the
        // full file content, the violation is contextually wrapped (e.g.
        // `.debug` inside `#if DEBUG ... #endif`) and not actionable.
        if (pattern.suppressIfFileMatches && pattern.suppressIfFileMatches.test(content)) continue;
        issues.push({
          id: pattern.id,
          severity: pattern.severity ?? "error",
          message: `${pattern.message} (in ${file})`,
          files: [file],
        });
        fireCounts.set(pattern.id, (fireCounts.get(pattern.id) ?? 0) + 1);
      }
    }
  }
  if (fireCounts.size > 0) {
    await recordFireMetrics(workspace, fireCounts);
  }
  return issues;
}

type FireMetricsFile = {
  totals: Record<string, number>;
  lastFiredAt: Record<string, string>;
  totalScans?: number;
};

async function recordFireMetrics(workspace: string, fireCounts: Map<string, number>): Promise<void> {
  try {
    const metricsDir = join(workspace, ".tanya", "memory");
    const metricsPath = join(metricsDir, "forbidden-patterns-metrics.json");
    let existing: FireMetricsFile = { totals: {}, lastFiredAt: {} };
    if (existsSync(metricsPath)) {
      try {
        const raw = await readFile(metricsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          existing = {
            totals: (parsed.totals && typeof parsed.totals === "object") ? parsed.totals : {},
            lastFiredAt: (parsed.lastFiredAt && typeof parsed.lastFiredAt === "object") ? parsed.lastFiredAt : {},
            totalScans: typeof parsed.totalScans === "number" ? parsed.totalScans : 0,
          };
        }
      } catch {
        // Corrupt metrics file should not block writes; reset.
      }
    }
    const now = new Date().toISOString();
    for (const [patternId, count] of fireCounts) {
      existing.totals[patternId] = (existing.totals[patternId] ?? 0) + count;
      existing.lastFiredAt[patternId] = now;
    }
    existing.totalScans = (existing.totalScans ?? 0) + 1;
    await mkdir(metricsDir, { recursive: true });
    await writeFile(metricsPath, JSON.stringify(existing, null, 2), "utf8");
  } catch {
    // Metrics are best-effort; never fail the gate because of metrics IO.
  }
}

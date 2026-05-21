import {
  inferPrimaryPlatform,
  readWorkspaceFile,
  taskText,
  type ValidationIssue,
  type ValidationManifest,
  type Validator,
} from "./core";

// Semantic validator: every domain resource declared in brand/api_features.md
// must have an `auth-posture: <posture>` field, AND every route file's
// middleware composition must match that declared posture. Catches the class
// of issue where /api/cases shipped without authentication because the contract
// was undefined and the runtime gate had nothing to compare against. See
// 2026-05-01 audit foundation/4 finding.
const VALID_POSTURES = new Set(["public-read", "authenticated-read", "authenticated-write", "owner-only", "admin-only"]);

export async function validateBackendAuthPosture(workspace: string, manifest: ValidationManifest): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // Find api_features.md — typically at workspace's parent ../brand/ or workspace/brand/
  const apiFeaturesCandidates = [
    "../brand/api_features.md",
    "brand/api_features.md",
    "../../brand/api_features.md",
  ];
  let apiFeaturesContent: string | null = null;
  let apiFeaturesPath: string | null = null;
  for (const rel of apiFeaturesCandidates) {
    const content = await readWorkspaceFile(workspace, rel);
    if (content) { apiFeaturesContent = content; apiFeaturesPath = rel; break; }
  }
  if (!apiFeaturesContent) {
    // No contract document — can't validate posture. This is itself a soft issue
    // for backend tasks but not blocking; the foundation/4 prompt requires it.
    return [{
      id: "auth-posture-no-contract",
      severity: "warning",
      message: "No brand/api_features.md found to validate auth posture against. Backend foundation should produce this file.",
    }];
  }
  // Parse endpoint declarations. Two supported formats:
  //   1) Header-style: `### POST /api/cases` (legacy) — scan ahead for posture
  //   2) Bullet-style: `- \`GET /cases\` — auth-posture: public-read. Description...`
  //      where the path may omit the `/api` prefix (the contract declares Base URL `/api`).
  // For both, posture may appear inline on the same line OR within the following ~5 lines.
  const lines = apiFeaturesContent.split(/\r?\n/);
  const endpointHeaderRe = /^#{2,4}\s+(?:(GET|POST|PATCH|PUT|DELETE)\s+)?(\/(?:api\/)?[A-Za-z0-9_\-\/{}\[\]:]+)/;
  const bulletEndpointRe = /^[-*]\s+`(GET|POST|PATCH|PUT|DELETE)\s+(\/[A-Za-z0-9_\-\/{}\[\]:]+)`/;
  const postureRe = /auth[\s\-]posture\s*[:\-]\s*(public-read|authenticated-read|authenticated-write|owner-only|admin-only)/i;
  type Endpoint = { method: string | null; path: string; headerLine: number; posture: string | null };
  const endpoints: Endpoint[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    let method: string | null = null;
    let path: string | null = null;
    const headerMatch = endpointHeaderRe.exec(line);
    const bulletMatch = bulletEndpointRe.exec(line);
    if (headerMatch) {
      method = headerMatch[1] ?? null;
      path = headerMatch[2]!;
    } else if (bulletMatch) {
      method = bulletMatch[1]!;
      path = bulletMatch[2]!;
    } else {
      continue;
    }
    const ep: Endpoint = { method, path, headerLine: i, posture: null };
    // Inline posture on same line first (common for bullet-style)
    const inline = postureRe.exec(line);
    if (inline) {
      ep.posture = inline[1]!.toLowerCase();
    } else {
      // Scan ahead up to 8 lines for posture before next bullet/header
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
        if (/^#{2,4}\s/.test(lines[j]!) || bulletEndpointRe.test(lines[j]!)) break;
        const pm = postureRe.exec(lines[j]!);
        if (pm) { ep.posture = pm[1]!.toLowerCase(); break; }
      }
    }
    endpoints.push(ep);
  }
  if (endpoints.length === 0) {
    return [{
      id: "auth-posture-no-endpoints-parsed",
      severity: "warning",
      message: `Could not parse any endpoint declarations from ${apiFeaturesPath}. Expected ## /api/<resource> headers.`,
      files: apiFeaturesPath ? [apiFeaturesPath] : [],
    }];
  }
  // Endpoints missing posture declaration
  const missingPosture = endpoints.filter((e) => e.posture === null);
  for (const ep of missingPosture) {
    issues.push({
      id: "auth-posture-undeclared",
      severity: "error",
      message: `Endpoint ${ep.method ?? ""} ${ep.path} in ${apiFeaturesPath} has no auth-posture declaration. Add \`auth-posture: <public-read|authenticated-read|authenticated-write|owner-only|admin-only>\` so the runtime gate can verify the route's middleware matches.`.trim(),
      files: apiFeaturesPath ? [apiFeaturesPath] : [],
    });
  }
  // Validate route file middleware against declared posture. Only check route
  // files within the changedFiles set OR known under app/api (so we don't pay
  // for full repo walks on unrelated tasks).
  const routeFiles = manifest.changedFiles.filter((f) => /(?:^|\/)(?:app|src)\/api\/.*\/route\.ts$/.test(f));
  for (const file of routeFiles) {
    const content = await readWorkspaceFile(workspace, file);
    if (!content) continue;
    // Extract path from filename: app/api/cases/route.ts → /api/cases
    const pathMatch = /\/api\/([^/]+(?:\/\[?[^\]]+\]?)*?)\/route\.ts$/.exec(file);
    if (!pathMatch) continue;
    const routePath = `/api/${pathMatch[1]!.replace(/\[(\w+)\]/g, "{$1}")}`;
    const ep = endpoints.find((e) => normalizeApiPath(e.path) === normalizeApiPath(routePath));
    if (!ep || !ep.posture) continue;
    const usesAuth = /\bwithAuth\b/.test(content);
    const usesOwnership = /userId|ownerId|req\.user|ctx\.userId/.test(content);
    if (ep.posture === "public-read") {
      // Should NOT use withAuth (or only on POST/write paths). Soft warning.
      if (usesAuth) {
        issues.push({
          id: "auth-posture-public-read-with-auth",
          severity: "warning",
          message: `Route ${routePath} declared public-read in api_features.md but file uses withAuth. Either remove withAuth or update the contract.`,
          files: [file],
        });
      }
    } else if (ep.posture === "authenticated-read" || ep.posture === "authenticated-write") {
      if (!usesAuth) {
        issues.push({
          id: "auth-posture-missing-withauth",
          severity: "error",
          message: `Route ${routePath} declared ${ep.posture} but file does not include withAuth middleware. Wrap the handler: e.g. withSecurityHeaders(withCors(withErrorHandler(withAuth(handler)))).`,
          files: [file],
        });
      }
    } else if (ep.posture === "owner-only") {
      if (!usesAuth) {
        issues.push({
          id: "auth-posture-owner-only-missing-withauth",
          severity: "error",
          message: `Route ${routePath} declared owner-only but file does not include withAuth. Owner-only routes MUST require auth + check req.user.userId === resource.userId.`,
          files: [file],
        });
      } else if (!usesOwnership) {
        issues.push({
          id: "auth-posture-owner-only-missing-ownership-check",
          severity: "error",
          message: `Route ${routePath} declared owner-only and uses withAuth but does not appear to filter by userId/ownerId. Add a where: { userId: ctx.userId } scope so users can only see their own resources.`,
          files: [file],
        });
      }
    } else if (ep.posture === "admin-only") {
      if (!usesAuth || !/\b(admin|isAdmin|role\s*==?=?\s*['\"]admin)\b/.test(content)) {
        issues.push({
          id: "auth-posture-admin-only-missing-check",
          severity: "error",
          message: `Route ${routePath} declared admin-only but file does not include both withAuth and an admin role check.`,
          files: [file],
        });
      }
    }
  }
  return issues;
}

function normalizeApiPath(p: string): string {
  // Normalize {id} vs [id] vs :id parameter syntax, strip optional /api prefix,
  // and trim trailing slash. Contract bullets often write `/cases` while route
  // files live at `/api/cases/route.ts` — treat them as equivalent.
  return p
    .replace(/\[(\w+)\]/g, "{$1}")
    .replace(/:(\w+)/g, "{$1}")
    .replace(/^\/api(?=\/)/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export const backendAuthPostureValidator: Validator = {
    id: "task.backendAuthPosture",
    async run(workspace, manifest, runContext) {
      // Only fires for backend foundation/auth/feature tasks where api_features.md
      // is the contract source. Not for client/script tasks.
      if (!/\/(?:backend)(?:\/|$)/.test(workspace)) return [];
      const text = taskText(runContext);
      if (!/\b(foundation|fundações|auth|api|endpoint|route|feature)\b/i.test(text)) return [];
      return await validateBackendAuthPosture(workspace, manifest);
    },
  };

export const brandFidelityValidator: Validator = {
    id: "task.brandFidelity",
    // Brand-fidelity check for client UI work. Catches the class of issue where
    // a feature screen embeds an inline hex code or default font instead of
    // referencing brand tokens. brand.md (at repo root) is the authoritative
    // source of brand colors/fonts; tokens in Colors.swift/Theme.kt must match;
    // feature screens must reference the tokens, never inline literals.
    //
    // Prior audit: feature screens used MaterialTheme defaults
    // and inline Color(0xFF...) calls instead of brand-token references.
    async run(workspace, manifest, runContext) {
      const platform = inferPrimaryPlatform(workspace);
      if (platform !== "ios" && platform !== "android" && platform !== "macos") return [];
      const text = taskText(runContext);
      // Only fires for feature/* and polish/* tasks — not foundation (which is
      // where tokens are first declared, hex codes are expected there).
      if (!/\b(feature|polish|tela|screen|view|paywall)\b/i.test(text)) return [];
      const issues: ValidationIssue[] = [];
      // Patterns: Color(hex: "#RRGGBB"), Color(0xFFRRGGBB), Color.rgb(255,...),
      // bare "#RRGGBB" string literal, raw 0xFFRRGGBB literal in Compose code.
      const HEX_RE = /(?:Color\s*\(\s*hex:\s*"#?[0-9A-Fa-f]{6,8}"|Color\s*\(\s*0x[0-9A-Fa-f]{6,8}|"#[0-9A-Fa-f]{6,8}"|\b0x[FfAa]{2}[0-9A-Fa-f]{6}\b)/;
      const FEATURE_LIKE = /(?:Feature|Screen|View|Composable|Paywall|Dashboard)\.(?:swift|kt)$/i;
      for (const file of manifest.changedFiles) {
        // Skip token files / theme files — hex codes belong there
        if (/(?:Colors|Theme|ColorScheme|Typography|Tokens|Palette|BrandedComponents)\.(?:swift|kt)$/i.test(file)) continue;
        // Only check feature-like files
        if (!FEATURE_LIKE.test(file) && !/\/(?:features|ui)\//i.test(file)) continue;
        const content = await readWorkspaceFile(workspace, file);
        if (!content) continue;
        if (HEX_RE.test(content)) {
          issues.push({
            id: "brand-fidelity-inline-hex",
            severity: "error",
            message: `Feature/screen file ${file} contains an inline hex color literal. Move colors to the token file (Colors.swift / Theme.kt) and reference them as Theme.<token> / MaterialTheme.colorScheme.<token>. Hex codes belong only in the token file, populated from brand.md.`,
            files: [file],
          });
        }
      }
      return issues;
    },
  };

export const toneOfVoiceValidator: Validator = {
    id: "task.toneOfVoice",
    // Catches generic UI copy on feature screens when brand.md declares a specific
    // tone of voice. Heuristic: feature screens with literal "Loading...", "No items",
    // "Error" without brand-voiced alternatives. Brand.md must be present at repo root
    // (or one level up); we read its tone-of-voice section to scope the check.
    async run(workspace, manifest, runContext) {
      const platform = inferPrimaryPlatform(workspace);
      if (platform !== "ios" && platform !== "android" && platform !== "macos") return [];
      const text = taskText(runContext);
      if (!/\b(feature|polish|tela|screen|paywall)\b/i.test(text)) return [];

      const brandMdContent = (await readWorkspaceFile(workspace, "../brand.md")) || (await readWorkspaceFile(workspace, "brand.md"));
      if (!brandMdContent) return []; // No brand.md → can't enforce tone

      // Detect declared tone — look for keywords in the tone section
      const lower = brandMdContent.toLowerCase();
      const isFormal = /(?:autoritário|profissional|sóbrio|sofisticado|direto|formal|authoritative|professional)/i.test(lower);
      const isPlayful = /(?:divertido|jovial|amigável|playful|friendly|casual)/i.test(lower);
      // If neither signal is strong, skip — we don't have an opinion to enforce
      if (!isFormal && !isPlayful) return [];

      const issues: ValidationIssue[] = [];
      const GENERIC_COPY = [
        "\"Loading...\"",
        "\"Loading\\.\\.\\.\"",
        "\"Carregando\\.\\.\\.\"",
        "\"No items\"",
        "\"Nenhum item\"",
        "\"Error\"",
        "\"Erro\"",
        "\"Try again\"",
        "\"Tente novamente\"",
      ];
      const GENERIC_RE = new RegExp(`(?:${GENERIC_COPY.join("|")})`);
      const FEATURE_LIKE = /(?:Feature|Screen|View|Composable|Paywall|Dashboard)\.(?:swift|kt)$/i;
      for (const file of manifest.changedFiles) {
        if (!FEATURE_LIKE.test(file) && !/\/(?:features|ui)\//i.test(file)) continue;
        const content = await readWorkspaceFile(workspace, file);
        if (!content) continue;
        if (GENERIC_RE.test(content)) {
          issues.push({
            id: "tone-of-voice-generic-copy",
            severity: "warning",
            message: `Feature screen ${file} contains generic UI copy ("Loading...", "Error", "No items") while brand.md declares a ${isFormal ? "formal/authoritative" : "playful"} tone of voice. Replace with brand-voiced strings (e.g. for legal apps: "Buscando jurisprudência…" instead of "Loading…", "Nenhuma decisão encontrada para esses critérios" instead of "No items").`,
            files: [file],
          });
        }
      }
      return issues;
    },
  };

export const accessibilityValidator: Validator = {
    id: "task.accessibility",
    // Catches missing accessibilityLabel on Image / Icon in feature screens. Won't
    // hold a screen back from shipping but surfaces the gap so the polish step can
    // sweep them. Severity warning.
    async run(workspace, manifest, runContext) {
      const platform = inferPrimaryPlatform(workspace);
      if (platform !== "ios" && platform !== "android" && platform !== "macos") return [];
      const text = taskText(runContext);
      if (!/\b(feature|polish|tela|screen|paywall)\b/i.test(text)) return [];

      const issues: ValidationIssue[] = [];
      const FEATURE_LIKE = /(?:Feature|Screen|View|Composable|Paywall|Dashboard)\.(?:swift|kt)$/i;
      for (const file of manifest.changedFiles) {
        if (!FEATURE_LIKE.test(file) && !/\/(?:features|ui)\//i.test(file)) continue;
        const content = await readWorkspaceFile(workspace, file);
        if (!content) continue;
        // iOS: SwiftUI Image without .accessibilityLabel within ~5 lines, or
        // Image(systemName:) used as a button without a Button wrapper.
        if (platform === "ios" || platform === "macos") {
          // Image(systemName: "...") not followed within 4 lines by accessibilityLabel
          // and not wrapped in a Label/Text-bearing context.
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (!/Image\s*\(\s*systemName\s*:/.test(lines[i]!)) continue;
            const window = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
            if (/\b(?:accessibilityLabel|accessibilityHidden|Label\s*\()/i.test(window)) continue;
            // Also okay if the Image is decorative — flagged via `// decorative`
            if (/\/\/\s*decorative/i.test(window)) continue;
            issues.push({
              id: "a11y-image-missing-label",
              severity: "warning",
              message: `${file}:${i + 1} — Image(systemName:) has no accessibilityLabel within 5 lines. Add .accessibilityLabel("…") for VoiceOver, or .accessibilityHidden(true) if purely decorative.`,
              files: [file],
            });
            break; // one issue per file is enough
          }
        }
        // Android: Icon(...) with contentDescription = null in non-decorative use
        if (platform === "android") {
          // contentDescription = null — okay only when paired with adjacent Text
          // for an iconified label. Flag plain Icon(...) buttons with null cd.
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            if (!/Icon\s*\(/.test(lines[i]!)) continue;
            const window = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
            if (!/contentDescription\s*=\s*null/.test(window)) continue;
            // Skip if there's a Text() in the same window (the Text labels it)
            if (/\bText\s*\(/.test(window)) continue;
            issues.push({
              id: "a11y-icon-missing-content-description",
              severity: "warning",
              message: `${file}:${i + 1} — Icon(...) has contentDescription = null without an adjacent Text label. Add a contentDescription for TalkBack, or pair it with a sibling Text.`,
              files: [file],
            });
            break;
          }
        }
      }
      return issues;
    },
  };

export const platformIsolationValidator: Validator = {
    id: "core.platform.isolation",
    // Caught in a prior drain: an iOS feature step's run committed
    // 7 Android files (and vice-versa) because the agent saw the multi-platform
    // brief and used run_shell to write into ../android/. Each step runs against
    // a single platform's workspace; writes outside that platform's directory
    // contaminate commit attribution and can race with the other platform's queue.
    run(workspace, manifest) {
      const platform = inferPrimaryPlatform(workspace);
      if (platform === "unknown") return [];
      const SIBLING_PLATFORM_DIRS = ["ios/", "macos/", "android/", "backend/", "web/", "script/", "landing/"];
      const offenders: string[] = [];
      for (const file of manifest.changedFiles) {
        const lower = file.toLowerCase();
        for (const dir of SIBLING_PLATFORM_DIRS) {
          // Skip the active platform's own dir prefix
          if (dir === `${platform}/`) continue;
          if (lower.startsWith(dir)) { offenders.push(file); break; }
        }
      }
      if (offenders.length === 0) return [];
      return [{
        id: "core-platform-isolation-violated",
        severity: "error",
        message: `This is a ${platform} step. Files were modified in sibling platform directories: ${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ""}. Each step runs one platform; the orchestrator picks up other platforms in their own runs. Move these changes to a separate ${offenders[0]!.split("/")[0]} step or revert them.`,
        files: offenders,
      }];
    },
  };

export const deployShapeValidator: Validator = {
    id: "task.deployShape",
    // Static-analyzes Dockerfile + GitHub Actions workflow files for known
    // deploy-time foot-guns. The forbidden-pattern gates already catch some
    // (prisma db push, || true, /tmp redirects); this validator covers the
    // structural checks that need cross-line / cross-file context.
    //
    // Prior incident: Dockerfile copied package.json before
    // prisma/, breaking the postinstall hook. Caught only by failed GitHub
    // Actions build — but the static signature is detectable.
    async run(workspace) {
      const fs = await import("fs/promises");
      const path = await import("path");
      const issues: ValidationIssue[] = [];

      const dockerfilePath = path.join(workspace, "Dockerfile");
      let dockerfile = "";
      try { dockerfile = await fs.readFile(dockerfilePath, "utf8"); } catch { /* no Dockerfile in this workspace */ }

      if (dockerfile) {
        // 1. CMD must run prisma migrate deploy synchronously, not in a
        // background subshell.
        const cmdLine = dockerfile.split(/\r?\n/).find((l) => /^\s*CMD\b/.test(l)) ?? "";
        if (cmdLine && /\(\s*npx[^)]*prisma[^)]*\)\s*&/.test(cmdLine)) {
          issues.push({
            id: "task-deploy-shape-async-prisma-on-boot",
            severity: "error",
            message: "Dockerfile CMD runs prisma migrate/push in a background subshell (`( ... ) &`). Schema sync must complete BEFORE `npm start` so the container exits non-zero on schema drift instead of serving a half-broken backend.",
            files: ["Dockerfile"],
          });
        }
        // 2. CMD must guard DATABASE_URL — empty/missing should refuse to start.
        if (cmdLine && /CMD\s/.test(cmdLine) && !/DATABASE_URL/.test(dockerfile)) {
          issues.push({
            id: "task-deploy-shape-no-database-url-guard",
            severity: "warning",
            message: "Dockerfile CMD doesn't reference DATABASE_URL. Production boot should refuse to start when DATABASE_URL is missing, instead of serving a backend that 503s every request.",
            files: ["Dockerfile"],
          });
        }
        // 3. Recommend versioned migrations.
        if (/\bprisma\s+db\s+push\b/.test(dockerfile)) {
          issues.push({
            id: "task-deploy-shape-uses-db-push",
            severity: "error",
            message: "Production boot uses `prisma db push` (declarative diff). Switch to `prisma migrate deploy` and ship migration files under prisma/migrations/. db push can drop tables silently and leaves no audit trail.",
            files: ["Dockerfile"],
          });
        }
      }

      // 4. GitHub Actions workflow shouldn't bypass test/lint gates.
      const ghWorkflowDir = path.join(workspace, ".github", "workflows");
      try {
        const files = await fs.readdir(ghWorkflowDir);
        for (const f of files) {
          if (!/\.ya?ml$/.test(f)) continue;
          const content = await fs.readFile(path.join(ghWorkflowDir, f), "utf8");
          if (/--no-verify\b/.test(content) || /SKIP_TESTS/.test(content)) {
            issues.push({
              id: "task-deploy-shape-tests-bypassed",
              severity: "error",
              message: `Workflow .github/workflows/${f} bypasses tests or commit hooks (--no-verify or SKIP_TESTS). Production deploys must run the full test suite.`,
              files: [`.github/workflows/${f}`],
            });
          }
        }
      } catch { /* no workflows dir */ }

      return issues;
    },
  };

export const externalApiContractValidator: Validator = {
    id: "task.externalApiContract",
    // Lightweight static checks that catch known wire-format mismatches with
    // third-party APIs. Not a substitute for a real integration test, but
    // catches the most common copy-paste-from-LLM bug shapes.
    //
    // Prior incident: lib/email.ts passed FROM_EMAIL whole
    // (RFC-822 form "Name <addr@host>") to Brevo's sender.email field, which
    // requires a bare address. Brevo rejected with 400; route returned 500.
    async run(workspace, manifest) {
      const fs = await import("fs/promises");
      const path = await import("path");
      const issues: ValidationIssue[] = [];

      // Only inspect files actually changed in this run — keeps validator
      // O(changes) instead of O(repo).
      const candidateFiles = manifest.changedFiles.filter((f) =>
        /\.(?:ts|tsx|js|mjs)$/.test(f) &&
        /(?:email|brevo|sendgrid|mailgun|resend|notification)/i.test(f),
      );
      for (const rel of candidateFiles) {
        let content = "";
        try { content = await fs.readFile(path.join(workspace, rel), "utf8"); }
        catch { continue; }

        // Brevo / Sendgrid / Mailgun all want sender.email to be a bare address.
        // If the code passes process.env.FROM_EMAIL (or a `fromEmail` var that
        // holds it) directly into a `sender.email` / `from.email` JSON field
        // without first stripping the RFC-822 wrapper, fire.
        const passesRawFromEmail = /(?:from|sender)\s*:\s*\{[^}]*\bemail\s*:\s*(?:fromEmail|process\.env\.FROM_EMAIL)\b/.test(content);
        const hasRfcParser = /<\s*\(\?\?\)?\[\^<>\\s\]\+@\[\^<>\\s\]\+|rfcMatch|parseAddress|<.*@.*>.*\.exec/.test(content);
        if (passesRawFromEmail && !hasRfcParser) {
          issues.push({
            id: "task-external-api-contract-from-email-rfc822",
            severity: "error",
            message: `${rel} passes FROM_EMAIL (an RFC-822 string like "Name <a@b>") directly to a transactional-email provider's sender.email field. Brevo/Sendgrid/Mailgun all reject this with invalid_parameter. Parse FROM_EMAIL into name + email before sending — see lib/email.ts parser pattern.`,
            files: [rel],
          });
        }
      }

      return issues;
    },
  };

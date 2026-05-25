import { readFileSync } from "node:fs";
import { discoverIntegrationEntries } from "../integrations/discovery";

export type GoldenTaskProfile = {
  id: string;
  title: string;
  platform: "ios" | "android" | "backend" | "cross-platform";
  purpose: string;
  requiredCapabilities: string[];
};

export type IntegrationGoldenProfilesFile =
  | GoldenTaskProfile
  | GoldenTaskProfile[]
  | { profiles: GoldenTaskProfile[] };

const profilePlatforms = new Set<GoldenTaskProfile["platform"]>(["ios", "android", "backend", "cross-platform"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoldenTaskProfile(value: unknown): value is GoldenTaskProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === "string" &&
    typeof profile.title === "string" &&
    typeof profile.platform === "string" &&
    profilePlatforms.has(profile.platform as GoldenTaskProfile["platform"]) &&
    typeof profile.purpose === "string" &&
    isStringArray(profile.requiredCapabilities);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseIntegrationGoldenProfiles(path: string): GoldenTaskProfile[] {
  const parsed = readJson(path);
  const profiles = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { profiles?: unknown }).profiles)
      ? (parsed as { profiles: unknown[] }).profiles
      : [parsed];
  const valid = profiles.filter(isGoldenTaskProfile);
  if (valid.length !== profiles.length) {
    console.warn(`[golden] Skipping invalid integration profile data: ${path}`);
  }
  return valid;
}

export const GENERIC_BENCHMARK_PROFILES: GoldenTaskProfile[] = [
  {
    id: "tanya.low.search-replace",
    title: "Low - Targeted Search Replace",
    platform: "cross-platform",
    purpose: "Update one existing source file with a precise replacement and verify the marker.",
    requiredCapabilities: ["read before edit", "search_replace", "bounded verification"],
  },
  {
    id: "tanya.low.new-helper",
    title: "Low - New Helper File",
    platform: "cross-platform",
    purpose: "Create a small helper module and verify it exists with expected content.",
    requiredCapabilities: ["write_file", "final report", "bounded verification"],
  },
  {
    id: "tanya.low.config-update",
    title: "Low - Config Update",
    platform: "cross-platform",
    purpose: "Update a simple JSON-like config file without touching unrelated files.",
    requiredCapabilities: ["targeted edit", "changed-file reporting", "bounded verification"],
  },
  {
    id: "tanya.low.readme-update",
    title: "Low - README Update",
    platform: "cross-platform",
    purpose: "Append a concise documentation note and verify the note is present.",
    requiredCapabilities: ["documentation edit", "artifact reuse none", "bounded verification"],
  },
  {
    id: "tanya.low.package-script",
    title: "Low - Package Script",
    platform: "cross-platform",
    purpose: "Add a package script while preserving existing package metadata.",
    requiredCapabilities: ["JSON edit", "package script reporting", "bounded verification"],
  },
  {
    id: "tanya.medium.service-module",
    title: "Medium - Service Module",
    platform: "cross-platform",
    purpose: "Create a service module and matching index export in a small multi-file change.",
    requiredCapabilities: ["multi-file edit", "verification", "complete report"],
  },
  {
    id: "tanya.medium.test-harness",
    title: "Medium - Test Harness",
    platform: "cross-platform",
    purpose: "Add a tiny executable test harness and verify it runs.",
    requiredCapabilities: ["test file creation", "run_command", "complete report"],
  },
  {
    id: "tanya.medium.artifact-component",
    title: "Medium - Artifact Component",
    platform: "cross-platform",
    purpose: "Read a reusable UI artifact and adapt it into a project component.",
    requiredCapabilities: ["artifact read", "artifact provenance", "multi-file report"],
  },
  {
    id: "tanya.medium.artifact-service",
    title: "Medium - Artifact Service",
    platform: "backend",
    purpose: "Read a reusable service artifact and adapt it into a project helper.",
    requiredCapabilities: ["artifact read", "artifact provenance", "bounded verification"],
  },
  {
    id: "tanya.medium.dirty-worktree",
    title: "Medium - Dirty Worktree",
    platform: "cross-platform",
    purpose: "Complete a task in a repo that already has unrelated uncommitted changes.",
    requiredCapabilities: ["git snapshot", "unrelated dirty preservation", "final report"],
  },
  {
    id: "tanya.medium.report-repair",
    title: "Medium - Report Repair",
    platform: "cross-platform",
    purpose: "Recover when the model initially omits the required coding final report.",
    requiredCapabilities: ["final report reminder", "repair loop", "verification preservation"],
  },
  {
    id: "tanya.medium.multi-file",
    title: "Medium - Multi-File Feature",
    platform: "cross-platform",
    purpose: "Create coordinated source and docs changes and verify both outputs.",
    requiredCapabilities: ["multi-file edit", "changed-file reporting", "bounded verification"],
  },
  {
    id: "tanya.medium.package-manager",
    title: "Medium - Package Manager Script",
    platform: "cross-platform",
    purpose: "Use a workspace script path that also exercises post-check package-manager detection.",
    requiredCapabilities: ["package metadata", "script verification", "post-check readiness"],
  },
  {
    id: "tanya.medium.context-aware",
    title: "Medium - Context-Aware Edit",
    platform: "cross-platform",
    purpose: "Read caller context before editing and preserve that provenance in the run.",
    requiredCapabilities: ["context read", "context provenance", "complete report"],
  },
  {
    id: "tanya.medium.existing-tests",
    title: "Medium - Existing Tests",
    platform: "cross-platform",
    purpose: "Modify implementation while running an existing local verification script.",
    requiredCapabilities: ["existing test command", "verification reporting", "changed-file reporting"],
  },
  {
    id: "tanya.medium.dependency-install",
    title: "Medium - Dependency Install",
    platform: "cross-platform",
    purpose: "Update package metadata and lockfile-style state while verifying dependency intent without network access.",
    requiredCapabilities: ["package manifest update", "lockfile update", "bounded verification"],
  },
  {
    id: "tanya.medium.framework-migration",
    title: "Medium - Framework Migration",
    platform: "cross-platform",
    purpose: "Move a small legacy page into an app-router-style layout while preserving a compatibility entrypoint.",
    requiredCapabilities: ["framework convention", "multi-file migration", "changed-file reporting"],
  },
  {
    id: "tanya.medium.failing-test-repair",
    title: "Medium - Failing Test Repair",
    platform: "cross-platform",
    purpose: "Observe a failing verification, repair the implementation, and rerun the same check successfully.",
    requiredCapabilities: ["failed verification recovery", "targeted edit", "verification rerun"],
  },
  {
    id: "tanya.medium.frontend-smoke",
    title: "Medium - Frontend Smoke",
    platform: "cross-platform",
    purpose: "Create a minimal component, styles, and smoke check that verifies rendered content markers.",
    requiredCapabilities: ["frontend files", "visual smoke proxy", "bounded verification"],
  },
  {
    id: "tanya.medium.run-log-history",
    title: "Medium - Usage Metrics Run Log",
    platform: "cross-platform",
    purpose: "Complete a normal edit while emitting usage counts that should be persisted to .tanya/runs.",
    requiredCapabilities: ["usage metrics", "run log persistence", "history visibility"],
  },
  {
    id: "tanya.medium.streaming-long-tool",
    title: "Medium - Streaming Long Tool",
    platform: "cross-platform",
    purpose: "Run a >10s shell verification that streams progress while preserving the final tool result contract.",
    requiredCapabilities: ["tool_progress", "long-running run_shell", "provider-history isolation"],
  },
  {
    id: "tanya.medium.compaction-boundary",
    title: "Medium - Compaction Boundary",
    platform: "cross-platform",
    purpose: "Recover from a synthetic context-window failure mid-run and preserve the final verifier verdict.",
    requiredCapabilities: ["ContextWindowExceededError", "auto-compact retry", "archive-backed verifier surface"],
  },
  {
    id: "tanya.medium.edit-block-fuzzy",
    title: "Medium - Fuzzy Edit Block",
    platform: "cross-platform",
    purpose: "Recover a cheap-provider-style near-match with permission-gated fuzzy edit blocks while preserving verifier verdicts.",
    requiredCapabilities: ["edit_block", "fuzzy recovery", "permission-gated edit", "verifier parity"],
  },
];

export const BUILT_IN_GOLDEN_TASK_PROFILES: GoldenTaskProfile[] = [
  ...GENERIC_BENCHMARK_PROFILES,
];

export function loadIntegrationGoldenTaskProfiles(): GoldenTaskProfile[] {
  return discoverIntegrationEntries("golden")
    .filter((entry) => entry.path.toLowerCase().endsWith(".json"))
    .flatMap((entry) => parseIntegrationGoldenProfiles(entry.path));
}

export function loadGoldenTaskProfiles(): GoldenTaskProfile[] {
  const seen = new Set(BUILT_IN_GOLDEN_TASK_PROFILES.map((profile) => profile.id));
  const profiles = [...BUILT_IN_GOLDEN_TASK_PROFILES];
  for (const profile of loadIntegrationGoldenTaskProfiles()) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

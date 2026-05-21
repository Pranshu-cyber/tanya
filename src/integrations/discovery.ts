import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "../config/envCompat";

export type IntegrationKind = "skills" | "suites" | "golden" | "validators";

export interface IntegrationEntry {
  integration: string;
  kind: IntegrationKind;
  path: string;
}

type EnvLike = Record<string, string | undefined>;

interface DiscoverIntegrationEntriesOptions {
  env?: EnvLike;
  root?: string;
}

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

const moduleRoot = dirname(fileURLToPath(import.meta.url));
let defaultIntegrationsRoot: string | null = null;

function safeIsDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDirectory(path: string): DirectoryEntry[] {
  try {
    return readdirSync(path, { withFileTypes: true }) as DirectoryEntry[];
  } catch {
    return [];
  }
}

function hasMarkdownFile(root: string): boolean {
  const entries = safeReadDirectory(root);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) return true;
    if (entry.isDirectory() && hasMarkdownFile(path)) return true;
  }
  return false;
}

function resolveDefaultSkillsRoot(): string {
  const candidates = [
    moduleRoot,
    join(moduleRoot, "skills"),
    join(moduleRoot, "..", "src", "skills"),
    join(moduleRoot, "..", "skills"),
  ];

  for (const candidate of candidates) {
    if (safeIsDirectory(candidate) && hasMarkdownFile(candidate)) return candidate;
  }

  return join(moduleRoot, "..", "skills");
}

function packageRootFromSkillsRoot(skillsRoot: string): string {
  const parent = dirname(skillsRoot);
  const parentName = basename(parent);
  if (parentName === "src" || parentName === "dist") return dirname(parent);
  return parent;
}

export function integrationsRoot(env: EnvLike = process.env): string {
  const override = envValue(env, "TANYA_INTEGRATIONS_DIR").trim();
  if (override) return override;
  defaultIntegrationsRoot ??= join(packageRootFromSkillsRoot(resolveDefaultSkillsRoot()), "integrations");
  return defaultIntegrationsRoot;
}

export function discoverIntegrationEntries(
  kind: IntegrationKind,
  opts: DiscoverIntegrationEntriesOptions = {},
): IntegrationEntry[] {
  const root = opts.root ?? integrationsRoot(opts.env);
  if (!safeIsDirectory(root)) return [];

  const entries: IntegrationEntry[] = [];
  const integrations = safeReadDirectory(root)
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const integration of integrations) {
    const kindRoot = join(root, integration.name, kind);
    if (!safeIsDirectory(kindRoot)) continue;

    const discovered = safeReadDirectory(kindRoot)
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of discovered) {
      entries.push({
        integration: integration.name,
        kind,
        path: join(kindRoot, entry.name),
      });
    }
  }

  return entries;
}

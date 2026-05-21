import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inputShape } from "./engine";
import { DEFAULT_PERMISSION_RULES, parsePermissionsJson, type PermissionRulesConfig } from "./schema";

export type LearnedPermissionPersistence = "always" | "never";

export function permissionPatternForInput(tool: string, input: unknown): string {
  return `${tool}:${escapeRegex(inputShape(input))}`;
}

export function appendLearnedPermissionRule(options: {
  tool: string;
  input: unknown;
  persistAs: LearnedPermissionPersistence;
  home?: string;
}): string {
  const home = options.home ?? homedir();
  const path = join(home, ".tanya", "permissions.json");
  const pattern = permissionPatternForInput(options.tool, options.input);
  const current = readUserPermissions(path);
  const next: PermissionRulesConfig = {
    ...current,
    alwaysAllow: options.persistAs === "always" ? appendUnique(current.alwaysAllow, pattern) : current.alwaysAllow,
    alwaysDeny: options.persistAs === "never" ? appendUnique(current.alwaysDeny, pattern) : current.alwaysDeny,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
  return pattern;
}

function readUserPermissions(path: string): PermissionRulesConfig {
  if (!existsSync(path)) return { ...DEFAULT_PERMISSION_RULES };
  const parsed = parsePermissionsJson(readFileSync(path, "utf8"));
  if (!parsed.ok) return { ...DEFAULT_PERMISSION_RULES };
  return parsed.value;
}

function appendUnique(items: string[], item: string): string[] {
  return items.includes(item) ? items : [...items, item];
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PERMISSION_RULES, parsePermissionsJson, type PermissionMode, type PermissionRulesConfig, type SpendRule } from "./schema";

export function writeProjectPermissionMode(cwd: string, mode: PermissionMode): string {
  const path = join(cwd, ".tanya", "permissions.json");
  const current = readProjectPermissions(path);
  const next: PermissionRulesConfig = {
    ...current,
    mode,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
  return path;
}

export function appendProjectSpendRule(cwd: string, rule: SpendRule): string {
  const path = join(cwd, ".tanya", "permissions.json");
  const current = readProjectPermissions(path);
  const next: PermissionRulesConfig = {
    ...current,
    spendRules: [...current.spendRules, rule],
  };
  writeProjectPermissions(path, next);
  return path;
}

function readProjectPermissions(path: string): PermissionRulesConfig {
  if (!existsSync(path)) return { ...DEFAULT_PERMISSION_RULES };
  const parsed = parsePermissionsJson(readFileSync(path, "utf8"));
  return parsed.ok ? parsed.value : { ...DEFAULT_PERMISSION_RULES };
}

function writeProjectPermissions(path: string, rules: PermissionRulesConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

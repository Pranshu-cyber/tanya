import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const migratedDirs = new Set<string>();

export function migrateLegacyDotDir(workspace: string): void {
  if (migratedDirs.has(workspace)) return;
  migratedDirs.add(workspace);

  const legacyDir = join(workspace, ".tania");
  const currentDir = join(workspace, ".tanya");

  if (!existsSync(legacyDir)) return;
  if (existsSync(currentDir)) return;

  try {
    renameSync(legacyDir, currentDir);
  } catch {
    // Best-effort migration; first turn will fall back to writing the new dir.
  }
}

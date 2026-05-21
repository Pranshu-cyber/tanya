import { stat } from "node:fs/promises";
import { resolveInsideWorkspace } from "../safety/workspace";
import type { ToolResult } from "../tools/types";

export type FileReadDedupEntry = {
  path: string;
  key: string;
  turn: number;
  toolCallId: string;
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export function readFilePathFromInput(input: unknown): string | null {
  const path = asRecord(input).path;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

export function readFileForceFromInput(input: unknown): boolean {
  const force = asRecord(input).force;
  if (typeof force === "boolean") return force;
  return typeof force === "string" && /^(1|true|yes)$/i.test(force.trim());
}

export class FileReadDedupCache {
  private readonly entries = new Map<string, FileReadDedupEntry>();

  constructor(private readonly workspace: string) {}

  async lookup(input: unknown): Promise<ToolResult | null> {
    if (readFileForceFromInput(input)) return null;
    const key = await this.keyFor(input);
    if (!key) return null;
    const entry = this.entries.get(key.key);
    if (!entry) return null;
    const marker = `[file unchanged since turn ${entry.turn}, see tool_call ${entry.toolCallId} for content]`;
    return {
      ok: true,
      summary: `Read skipped for ${entry.path}; file unchanged.`,
      output: marker,
    };
  }

  async remember(input: unknown, toolCallId: string, turn: number): Promise<void> {
    const key = await this.keyFor(input);
    if (!key) return;
    for (const [existingKey, entry] of this.entries) {
      if (entry.path === key.path) this.entries.delete(existingKey);
    }
    this.entries.set(key.key, { ...key, toolCallId, turn });
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private async keyFor(input: unknown): Promise<{ path: string; key: string } | null> {
    const path = readFilePathFromInput(input);
    if (!path) return null;
    try {
      const abs = resolveInsideWorkspace(this.workspace, path);
      const info = await stat(abs);
      if (!info.isFile()) return null;
      return {
        path,
        key: `${path}\0${info.size}\0${Math.floor(info.mtimeMs)}`,
      };
    } catch {
      return null;
    }
  }
}

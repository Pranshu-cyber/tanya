import type { TanyaTool } from "./types";
import { envValue } from "../config/envCompat";
import { materializeObsidianContext, searchObsidianNotes } from "../obsidian/search";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalBoolean(input: unknown, key: string, fallback: boolean): boolean {
  const value = asRecord(input)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
  return fallback;
}

export const searchObsidianNotesTool: TanyaTool = {
  name: "search_obsidian_notes",
  description: "Search the configured Obsidian vault for task-relevant markdown notes and optionally materialize excerpts into .tanya/context.",
  definition: {
    type: "function",
    function: {
      name: "search_obsidian_notes",
      description: "Search TANYA_OBSIDIAN_VAULT for task-relevant markdown notes. Use materialize=true before relying on notes as coding context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms or task text." },
          maxResults: { type: "number", description: "Maximum notes to return. Default 5." },
          materialize: { type: "boolean", description: "Materialize matching note excerpts into .tanya/context/obsidian. Default false." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const query = asOptionalString(input, "query");
    if (!query) throw new Error("Missing string field: query");
    const vaultPath = envValue({}, "TANYA_OBSIDIAN_VAULT").trim();
    if (!vaultPath) {
      return {
        ok: true,
        summary: "No Obsidian vault configured.",
        output: { notes: [], guidance: "Set TANYA_OBSIDIAN_VAULT to enable generic note retrieval." },
      };
    }
    const maxResults = Math.min(asOptionalNumber(input, "maxResults", 5), 20);
    if (asOptionalBoolean(input, "materialize", false)) {
      const materialized = await materializeObsidianContext({
        workspace: context.workspace,
        vaultPath,
        query,
        maxResults,
      });
      return {
        ok: true,
        summary: `Materialized ${materialized.contextFiles.length} Obsidian note excerpt${materialized.contextFiles.length === 1 ? "" : "s"}.`,
        output: materialized,
      };
    }
    const notes = await searchObsidianNotes({ vaultPath, query, maxResults });
    return {
      ok: true,
      summary: `Found ${notes.length} Obsidian note${notes.length === 1 ? "" : "s"}.`,
      output: {
        notes,
        guidance: notes.length > 0
          ? "Call search_obsidian_notes again with materialize=true before relying on note contents for implementation."
          : "No matching notes were found.",
      },
    };
  },
};

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Decision, PermissionContext } from "../safety/permissions/engine";
import { decide, inputShape } from "../safety/permissions/engine";
import { resolveInsideWorkspace } from "../safety/workspace";
import type { TanyaTool } from "./types";

export type EditBlockInput = {
  path: string;
  search: string;
  replace: string;
  expectedCount: number;
  matchPolicy: "exact" | "fuzzy";
};

const binaryExtensions = /\.(?:png|jpe?g|pdf|zip|exe|dll|so|dylib|woff2?|ttf|bin)$/i;

export function parseEditBlockInput(input: unknown, workspace: string): EditBlockInput {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const search = typeof record.search === "string" ? record.search : "";
  const replace = typeof record.replace === "string" ? record.replace : "";
  const expectedCountRaw = record.expectedCount;
  const matchPolicyRaw = record.matchPolicy;
  if (!path) throw new Error("Missing string field: path");
  if (!search) throw new Error("Missing string field: search");
  if (search === replace) throw new Error("search and replace must differ");
  if (binaryExtensions.test(path)) throw new Error("edit_block refuses binary file targets");
  resolveInsideWorkspace(workspace, path);
  const expectedCount = expectedCountRaw === undefined
    ? 1
    : typeof expectedCountRaw === "number" && Number.isInteger(expectedCountRaw) && expectedCountRaw > 0
      ? expectedCountRaw
      : NaN;
  if (!Number.isFinite(expectedCount)) throw new Error("expectedCount must be a positive integer");
  const matchPolicy = matchPolicyRaw === undefined
    ? "exact"
    : matchPolicyRaw === "exact" || matchPolicyRaw === "fuzzy"
      ? matchPolicyRaw
      : "";
  if (matchPolicy !== "exact" && matchPolicy !== "fuzzy") throw new Error("matchPolicy must be exact or fuzzy");
  return { path, search, replace, expectedCount, matchPolicy };
}

function hasExplicitEditBlockAllow(input: unknown, context: PermissionContext): boolean {
  const shape = inputShape(input);
  for (const pattern of context.rules.alwaysAllow) {
    const separator = pattern.indexOf(":");
    if (separator <= 0) continue;
    const tool = pattern.slice(0, separator);
    const regex = pattern.slice(separator + 1);
    if (tool === "edit_block" && new RegExp(regex).test(shape)) return true;
  }
  return false;
}

function countOccurrences(content: string, search: string): number {
  return content.split(search).length - 1;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function unifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  const diff = lines.join("\n");
  return diff.length > 32_000 ? `${diff.slice(0, 31_980)}\n[diff truncated]` : diff;
}

function exactMismatch(path: string, expected: number, found: number) {
  const reason = found === 0
    ? "no_match"
    : found > expected && expected === 1
      ? "too_many_matches"
      : "count_mismatch";
  return {
    ok: false as const,
    summary: "exact match failed",
    error: `exact match failed in ${path}: expected ${expected}, found ${found}`,
    output: {
      ok: false,
      error: "exact match failed",
      reason,
      expected,
      found,
    },
  };
}

type FuzzyCandidate = {
  start: number;
  end: number;
  recoveredVia: "whitespace" | "nearby-context";
  confidence: number;
};

type FuzzyFailure = {
  reason: "too_many_matches" | "no_match" | "low_confidence";
  confidence?: number;
  candidateExcerpt?: string;
};

function normalizeWithSpans(text: string): { normalized: string; spans: Array<{ start: number; end: number }> } {
  const chars: string[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (/\s/.test(char)) {
      const start = index;
      while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
      chars.push(" ");
      spans.push({ start, end: index });
      continue;
    }
    chars.push(char);
    spans.push({ start: index, end: index + 1 });
    index += 1;
  }
  let startToken = 0;
  let endToken = chars.length;
  while (startToken < endToken && chars[startToken] === " ") startToken += 1;
  while (endToken > startToken && chars[endToken - 1] === " ") endToken -= 1;
  return {
    normalized: chars.slice(startToken, endToken).join(""),
    spans: spans.slice(startToken, endToken),
  };
}

function findStringOccurrences(content: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let index = content.indexOf(needle);
  while (index >= 0) {
    hits.push(index);
    index = content.indexOf(needle, index + Math.max(1, needle.length));
  }
  return hits;
}

function whitespaceCandidate(content: string, search: string): FuzzyCandidate[] | FuzzyFailure {
  const normalizedContent = normalizeWithSpans(content);
  const normalizedSearch = normalizeWithSpans(search).normalized;
  const hits = findStringOccurrences(normalizedContent.normalized, normalizedSearch);
  if (hits.length > 1) return { reason: "too_many_matches" };
  if (hits.length === 0) return { reason: "no_match" };
  const startToken = hits[0] ?? 0;
  const endToken = startToken + normalizedSearch.length - 1;
  const first = normalizedContent.spans[startToken];
  const last = normalizedContent.spans[endToken];
  if (!first || !last) return { reason: "no_match" };
  return [{ start: first.start, end: last.end, recoveredVia: "whitespace", confidence: 1 }];
}

function anchorLines(search: string): { first: string; last: string; lineCount: number } | null {
  const lines = search.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  const first = lines.slice(0, Math.min(3, lines.length)).join("\n");
  const last = lines.slice(Math.max(0, lines.length - 3)).join("\n");
  return { first, last, lineCount: lines.length };
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function nearbyContextCandidate(content: string, search: string): FuzzyCandidate[] | FuzzyFailure {
  const anchors = anchorLines(search);
  if (!anchors) return { reason: "no_match" };
  const starts = findStringOccurrences(content, anchors.first);
  const candidates: Array<{ start: number; end: number; confidence: number; excerpt: string }> = [];
  for (const start of starts) {
    const lastIndex = content.indexOf(anchors.last, start + anchors.first.length);
    if (lastIndex < 0) continue;
    const end = lastIndex + anchors.last.length;
    const candidate = content.slice(start, end);
    if (Math.abs(lineCount(candidate) - anchors.lineCount) > 1) continue;
    const confidence = levenshteinRatio(normalizeForSimilarity(candidate), normalizeForSimilarity(search));
    candidates.push({ start, end, confidence, excerpt: candidate.slice(0, 500) });
  }
  if (candidates.length > 1) return { reason: "too_many_matches" };
  if (candidates.length === 0) return { reason: "no_match" };
  const candidate = candidates[0];
  if (!candidate) return { reason: "no_match" };
  if (candidate.confidence < 0.95) {
    return { reason: "low_confidence", confidence: candidate.confidence, candidateExcerpt: candidate.excerpt };
  }
  return [{ start: candidate.start, end: candidate.end, recoveredVia: "nearby-context", confidence: candidate.confidence }];
}

function normalizeForSimilarity(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j < prev.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  const distance = prev[b.length] ?? Math.max(a.length, b.length);
  return 1 - distance / Math.max(a.length, b.length);
}

function findFuzzyCandidate(content: string, search: string): FuzzyCandidate[] | FuzzyFailure {
  const whitespace = whitespaceCandidate(content, search);
  if (Array.isArray(whitespace) || whitespace.reason === "too_many_matches") return whitespace;
  const nearby = nearbyContextCandidate(content, search);
  return nearby;
}

function applyCandidate(content: string, candidate: FuzzyCandidate, replace: string): string {
  return `${content.slice(0, candidate.start)}${replace}${content.slice(candidate.end)}`;
}

function candidateExcerpt(content: string, candidate: FuzzyCandidate): string {
  return content.slice(candidate.start, candidate.end).slice(0, 500);
}

async function canRunEditBlock(input: unknown, context: PermissionContext): Promise<Decision> {
  const base = decide("edit_block", input, context);
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (record.matchPolicy !== "fuzzy") return base;
  if (base.decision === "deny") return base;
  if (!hasExplicitEditBlockAllow(input, context)) {
    return {
      decision: "deny",
      matchedRule: "edit_block:fuzzy",
      reason: "fuzzy edit blocks require explicit permission",
    };
  }
  return base;
}

export const editBlockTool: TanyaTool = {
  name: "edit_block",
  description: "Apply a bounded search/replace block. Defaults to exact matching; fuzzy matching requires explicit permission.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "edit_block",
      description: "Replace one or more occurrences of a search block in a workspace file. Fuzzy matching is opt-in and permission-gated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative text file path." },
          search: { type: "string", description: "Block to search for." },
          replace: { type: "string", description: "Replacement block." },
          expectedCount: { type: "number", description: "Expected replacement count. Default 1." },
          matchPolicy: { type: "string", enum: ["exact", "fuzzy"], description: "Match policy. Default exact." },
        },
        required: ["path", "search", "replace"],
        additionalProperties: false,
      },
    },
  },
  canRun: canRunEditBlock,
  async run(input, context) {
    const parsed = parseEditBlockInput(input, context.workspace);
    const abs = resolveInsideWorkspace(context.workspace, parsed.path);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return { ok: false, summary: `File not found: ${parsed.path}`, error: `Cannot read ${parsed.path}` };
    }
    const found = countOccurrences(content, parsed.search);
    if (parsed.matchPolicy === "exact") {
      if (found !== parsed.expectedCount) return exactMismatch(parsed.path, parsed.expectedCount, found);
      const updated = content.split(parsed.search).join(parsed.replace);
      await writeFile(abs, updated, "utf8");
      return {
        ok: true,
        summary: `replaced ${found} occurrence${found === 1 ? "" : "s"} in ${parsed.path}`,
        output: {
          path: parsed.path,
          count: found,
          matchPolicy: "exact",
          diff: unifiedDiff(parsed.path, content, updated),
          beforeHash: hashContent(content),
          afterHash: hashContent(updated),
        },
        files: [parsed.path],
      };
    }
    if (found === parsed.expectedCount) {
      const updated = content.split(parsed.search).join(parsed.replace);
      await writeFile(abs, updated, "utf8");
      return {
        ok: true,
        summary: `replaced ${found} exact occurrence${found === 1 ? "" : "s"} in ${parsed.path}`,
        output: {
          path: parsed.path,
          count: found,
          matchPolicy: "fuzzy",
          recoveredVia: "exact",
          confidence: 1,
          candidateExcerpt: parsed.search.slice(0, 500),
          diff: unifiedDiff(parsed.path, content, updated),
          beforeHash: hashContent(content),
          afterHash: hashContent(updated),
        },
        files: [parsed.path],
      };
    }
    const candidateResult = findFuzzyCandidate(content, parsed.search);
    if (!Array.isArray(candidateResult)) {
      return {
        ok: false,
        summary: "fuzzy match failed",
        error: `fuzzy match failed in ${parsed.path}: ${candidateResult.reason}`,
        output: {
          ok: false,
          error: "fuzzy match failed",
          reason: candidateResult.reason,
          matchPolicy: "fuzzy",
          ...(candidateResult.confidence !== undefined ? { confidence: candidateResult.confidence } : {}),
          ...(candidateResult.candidateExcerpt ? { candidateExcerpt: candidateResult.candidateExcerpt } : {}),
        },
      };
    }
    if (candidateResult.length !== parsed.expectedCount) {
      return {
        ok: false,
        summary: "fuzzy match failed",
        error: `fuzzy match failed in ${parsed.path}: expected ${parsed.expectedCount}, found ${candidateResult.length}`,
        output: {
          ok: false,
          error: "fuzzy match failed",
          reason: candidateResult.length > parsed.expectedCount ? "too_many_matches" : "count_mismatch",
          expected: parsed.expectedCount,
          found: candidateResult.length,
          matchPolicy: "fuzzy",
        },
      };
    }
    const candidate = candidateResult[0];
    if (!candidate) return exactMismatch(parsed.path, parsed.expectedCount, 0);
    const updated = applyCandidate(content, candidate, parsed.replace);
    await writeFile(abs, updated, "utf8");
    return {
      ok: true,
      summary: `recovered fuzzy edit in ${parsed.path} via ${candidate.recoveredVia}`,
      output: {
        path: parsed.path,
        count: 1,
        matchPolicy: "fuzzy",
        recoveredVia: candidate.recoveredVia,
        confidence: candidate.confidence,
        candidateExcerpt: candidateExcerpt(content, candidate),
        diff: unifiedDiff(parsed.path, content, updated),
        beforeHash: hashContent(content),
        afterHash: hashContent(updated),
      },
      files: [parsed.path],
    };
  },
};

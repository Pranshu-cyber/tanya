import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TanyaRunContext = {
  task?: {
    kind?: string | undefined;
    title?: string | undefined;
    summary?: string | undefined;
  };
  artifacts?: Array<{
    path: string;
    sourcePath?: string | undefined;
    role?: string | undefined;
    status?: string | undefined;
    reason?: string | undefined;
  }>;
  contextFiles?: Array<{
    path: string;
    sourcePath?: string | undefined;
    role?: string | undefined;
    status?: string | undefined;
    reason?: string | undefined;
  }>;
  instructions?: string[];
  verification?: {
    commands?: string[];
  };
  languages?: string[];
  frameworks?: string[];
  stack?: string;
  expected_report?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function briefListValue(value: unknown, key: string): string[] {
  if (!isRecord(value)) return [];
  return stringArray(value[key]) ?? [];
}

function buildAutoBriefBlock(metadata?: Record<string, unknown>): string[] {
  const brief = isRecord(metadata?.autoBrief) ? metadata.autoBrief : undefined;
  if (!brief) return [];
  const lines: string[] = ["", "Auto task brief:"];
  const signals = isRecord(brief.signals) ? brief.signals : {};
  const platforms = briefListValue({ platforms: signals.platforms }, "platforms");
  const domains = briefListValue({ domains: signals.domains }, "domains");
  lines.push(`- Platforms: ${platforms.length ? platforms.join(", ") : "none detected"}`);
  lines.push(`- Domains: ${domains.length ? domains.join(", ") : "none detected"}`);

  const contextFiles = recordArray(brief.contextFiles).slice(0, 12);
  if (contextFiles.length > 0) {
    lines.push("- Context files to consider:");
    for (const file of contextFiles) {
      const path = asString(file.path) ?? "unknown";
      const role = asString(file.role);
      lines.push(`  - ${path}${role ? ` (${role})` : ""}`);
    }
  }

  const artifacts = recordArray(brief.artifacts).slice(0, 12);
  if (artifacts.length > 0) {
    lines.push("- Artifact candidates:");
    for (const artifact of artifacts) {
      const path = asString(artifact.path) ?? "unknown";
      const description = asString(artifact.description);
      lines.push(`  - ${path}${description ? ` - ${description}` : ""}`);
    }
  }

  const packs = recordArray(brief.capabilityPacks).slice(0, 8);
  if (packs.length > 0) {
    lines.push("- Capability packs:");
    for (const pack of packs) {
      const id = asString(pack.id) ?? "unknown";
      const reason = asString(pack.reason);
      lines.push(`  - ${id}${reason ? `: ${reason}` : ""}`);
    }
  }

  const tools = briefListValue(brief, "recommendedTools").slice(0, 16);
  if (tools.length > 0) lines.push(`- Recommended tools: ${tools.join(", ")}`);
  const verification = briefListValue(brief, "verification").slice(0, 12);
  if (verification.length > 0) {
    lines.push("- Recommended verification:");
    for (const command of verification) lines.push(`  - ${command}`);
  }
  const cautions = briefListValue(brief, "cautions").slice(0, 8);
  if (cautions.length > 0) {
    lines.push("- Cautions:");
    for (const caution of cautions) lines.push(`  - ${caution}`);
  }

  return lines;
}

export function normalizeRunContext(input: unknown): TanyaRunContext {
  if (!isRecord(input)) throw new Error("Context file must contain a JSON object.");

  const taskInput = isRecord(input.task) ? input.task : undefined;
  const artifactsInput = Array.isArray(input.artifacts) ? input.artifacts : undefined;
  const verificationInput = isRecord(input.verification) ? input.verification : undefined;
  const contextFilesInput = Array.isArray(input.contextFiles) ? input.contextFiles : undefined;

  const artifacts = artifactsInput
    ?.filter(isRecord)
    .map((artifact) => ({
      path: asString(artifact.path) ?? "",
      ...(asString(artifact.sourcePath) ? { sourcePath: asString(artifact.sourcePath) } : {}),
      ...(asString(artifact.role) ? { role: asString(artifact.role) } : {}),
      ...(asString(artifact.status) ? { status: asString(artifact.status) } : {}),
      ...(asString(artifact.reason) ? { reason: asString(artifact.reason) } : {}),
    }))
    .filter((artifact) => artifact.path.length > 0);
  const contextFiles = contextFilesInput
    ?.filter(isRecord)
    .map((contextFile) => ({
      path: asString(contextFile.path) ?? "",
      ...(asString(contextFile.sourcePath) ? { sourcePath: asString(contextFile.sourcePath) } : {}),
      ...(asString(contextFile.role) ? { role: asString(contextFile.role) } : {}),
      ...(asString(contextFile.status) ? { status: asString(contextFile.status) } : {}),
      ...(asString(contextFile.reason) ? { reason: asString(contextFile.reason) } : {}),
    }))
    .filter((contextFile) => contextFile.path.length > 0);

  const task = taskInput
    ? {
        ...(asString(taskInput.kind) ? { kind: asString(taskInput.kind) } : {}),
        ...(asString(taskInput.title) ? { title: asString(taskInput.title) } : {}),
        ...(asString(taskInput.summary) ? { summary: asString(taskInput.summary) } : {}),
      }
    : undefined;
  const verificationCommands = verificationInput ? stringArray(verificationInput.commands) : undefined;
  const instructions = stringArray(input.instructions);
  const languages = stringArray(input.languages);
  const frameworks = stringArray(input.frameworks);
  const stack = asString(input.stack);

  return {
    ...(task && Object.keys(task).length > 0 ? { task } : {}),
    ...(artifacts?.length ? { artifacts } : {}),
    ...(contextFiles?.length ? { contextFiles } : {}),
    ...(instructions ? { instructions } : {}),
    ...(verificationCommands ? { verification: { commands: verificationCommands } } : {}),
    ...(languages ? { languages } : {}),
    ...(frameworks ? { frameworks } : {}),
    ...(stack ? { stack } : {}),
    ...(isRecord(input.expected_report) ? { expected_report: input.expected_report } : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
  };
}

export function loadRunContextFile(path: string): TanyaRunContext {
  const content = readFileSync(resolve(path), "utf8");
  try {
    return normalizeRunContext(JSON.parse(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid context file: ${message}`);
  }
}

export function buildRunContextBlock(context?: TanyaRunContext): string {
  if (!context) return "";
  const lines: string[] = ["## Caller Context"];

  if (context.task) {
    lines.push(`Task kind: ${context.task.kind ?? "unspecified"}`);
    if (context.task.title) lines.push(`Task title: ${context.task.title}`);
    if (context.task.summary) lines.push(`Task summary: ${context.task.summary}`);
  }

  if (context.artifacts?.length) {
    lines.push("", "Artifacts:");
    for (const artifact of context.artifacts) {
      const suffix = [
        artifact.sourcePath ? `source=${artifact.sourcePath}` : null,
        artifact.role ? `role=${artifact.role}` : null,
        artifact.status ? `status=${artifact.status}` : null,
        artifact.reason ? `reason=${artifact.reason}` : null,
      ].filter(Boolean).join("; ");
      lines.push(`- ${artifact.path}${suffix ? ` (${suffix})` : ""}`);
    }
  }

  if (context.contextFiles?.length) {
    lines.push("", "Context files:");
    for (const contextFile of context.contextFiles) {
      const suffix = [
        contextFile.sourcePath ? `source=${contextFile.sourcePath}` : null,
        contextFile.role ? `role=${contextFile.role}` : null,
        contextFile.status ? `status=${contextFile.status}` : null,
        contextFile.reason ? `reason=${contextFile.reason}` : null,
      ].filter(Boolean).join("; ");
      lines.push(`- ${contextFile.path}${suffix ? ` (${suffix})` : ""}`);
    }
  }

  if (context.instructions?.length) {
    lines.push("", "Caller instructions:");
    for (const instruction of context.instructions) lines.push(`- ${instruction}`);
  }

  if (context.verification?.commands?.length) {
    lines.push("", "Verification commands requested by caller:");
    for (const command of context.verification.commands) lines.push(`- ${command}`);
  }

  if (context.languages?.length || context.frameworks?.length || context.stack) {
    lines.push("", "Skill-pack hints:");
    if (context.languages?.length) lines.push(`- Languages: ${context.languages.join(", ")}`);
    if (context.frameworks?.length) lines.push(`- Frameworks: ${context.frameworks.join(", ")}`);
    if (context.stack) lines.push(`- Stack: ${context.stack}`);
  }

  if (context.expected_report && Object.keys(context.expected_report).length > 0) {
    lines.push("", `Expected report JSON keys: ${Object.keys(context.expected_report).join(", ")}`);
  }

  lines.push(...buildAutoBriefBlock(context.metadata));

  lines.push(
    "",
    "Treat caller metadata as opaque labels. Do not infer product-specific behavior from it.",
    "If artifacts are listed and relevant, read the listed local artifact paths before implementing related code and mention artifact usage in the final report.",
    "If context files are listed, read the listed local context paths when the task references safety, brand, architecture, API contracts, or product rules.",
    "Never use absolute sourcePath values with read_file. The sourcePath is provenance only; use the local artifact path shown before it.",
    "If an instruction mentions an absolute file outside the workspace and no local materialized copy is listed, do not repeatedly try to read it; report that it is outside the workspace.",
  );

  return lines.join("\n");
}

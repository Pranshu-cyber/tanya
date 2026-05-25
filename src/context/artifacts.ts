import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { TanyaRunContext } from "./runContext";

export type MaterializeCliArtifactsInput = {
  cwd: string;
  root?: string | undefined;
  artifacts: string[];
  contextPaths?: string[] | undefined;
  artifactOutputRoot?: string | undefined;
  keepContext?: boolean | undefined;
  baseContext?: TanyaRunContext | undefined;
};

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^"|"$/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizePath).filter(Boolean))];
}

function sourceLabel(root: string | undefined, artifact: string): string {
  const clean = normalizePath(artifact);
  if (!root || isAbsolute(clean)) return clean;
  const rootBase = basename(resolve(root));
  return rootBase === "artifacts" ? `artifacts/${clean}` : clean;
}

function relativeMaterializedPath(root: string | undefined, artifact: string, source: string): string {
  const clean = normalizePath(artifact);
  if (root && !isAbsolute(clean)) return clean;
  if (root) {
    const rel = normalizePath(relative(resolve(root), source));
    if (rel && !rel.startsWith("../") && rel !== "..") return rel;
  }
  return basename(source);
}

export function materializeCliArtifacts(input: MaterializeCliArtifactsInput): TanyaRunContext | undefined {
  const artifactInputs = unique(input.artifacts);
  const contextInputs = unique(input.contextPaths ?? []);
  if (artifactInputs.length === 0 && contextInputs.length === 0 && !input.artifactOutputRoot) return input.baseContext;

  const cwd = resolve(input.cwd);
  const root = input.root ? resolve(input.root) : undefined;
  const targetRoot = resolve(cwd, ".tanya", "artifacts");
  const contextTargetRoot = resolve(cwd, ".tanya", "context");
  const materialized: NonNullable<TanyaRunContext["artifacts"]> = [];
  const contextFiles: NonNullable<TanyaRunContext["contextFiles"]> = [];

  for (const artifact of artifactInputs) {
    const source = isAbsolute(artifact)
      ? resolve(artifact)
      : resolve(root ?? cwd, artifact);
    const rel = relativeMaterializedPath(root, artifact, source);
    const target = resolve(targetRoot, rel);
    const localPath = `.tanya/artifacts/${normalizePath(rel)}`;
    const label = sourceLabel(root, artifact);

    if (!target.startsWith(`${targetRoot}/`) || !existsSync(source)) {
      materialized.push({
        path: localPath,
        sourcePath: label,
        role: "source-pattern",
        status: "missing",
        reason: "Artifact was requested by the caller but was not found.",
      });
      continue;
    }

    const sourceStat = statSync(source);
    if (sourceStat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      cpSync(source, target, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    materialized.push({
      path: localPath,
      sourcePath: label,
      role: "source-pattern",
      status: "available",
      reason: "Materialized into this workspace from a caller-provided artifact input.",
    });
  }

  if (materialized.some((artifact) => artifact.status === "available")) {
    mkdirSync(targetRoot, { recursive: true });
    writeFileSync(
      resolve(targetRoot, "manifest.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), artifacts: materialized }, null, 2),
      "utf8",
    );
  }

  for (const contextPath of contextInputs) {
    const source = resolve(contextPath);
    const rel = normalizePath(relative(dirname(source), source)) || basename(source);
    const parentLabel = basename(dirname(source));
    const targetRel = parentLabel ? `${parentLabel}/${basename(source)}` : rel;
    const target = resolve(contextTargetRoot, targetRel);
    const localPath = `.tanya/context/${normalizePath(targetRel)}`;

    if (!target.startsWith(`${contextTargetRoot}/`) || !existsSync(source)) {
      contextFiles.push({
        path: localPath,
        sourcePath: contextPath,
        role: "caller-context",
        status: "missing",
        reason: "Context file was requested by the caller but was not found.",
      });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    contextFiles.push({
      path: localPath,
      sourcePath: contextPath,
      role: "caller-context",
      status: "available",
      reason: "Materialized into this workspace from a caller-provided context input.",
    });
  }

  if (contextFiles.some((contextFile) => contextFile.status === "available")) {
    mkdirSync(contextTargetRoot, { recursive: true });
    writeFileSync(
      resolve(contextTargetRoot, "manifest.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), contextFiles }, null, 2),
      "utf8",
    );
  }

  const artifactOutputRoot = input.artifactOutputRoot ? resolve(input.artifactOutputRoot) : undefined;

  return {
    ...(input.baseContext ?? {}),
    artifacts: [...(input.baseContext?.artifacts ?? []), ...materialized],
    contextFiles: [...(input.baseContext?.contextFiles ?? []), ...contextFiles],
    instructions: [
      ...(input.baseContext?.instructions ?? []),
      ...(materialized.length > 0 ? [
        "Caller artifacts were provided through Tanya's artifact input contract and materialized under .tanya/artifacts.",
        "Read relevant materialized artifact paths before implementing related code.",
      ] : []),
      ...(contextFiles.length > 0 ? [
        "Caller context files were materialized under .tanya/context.",
        "Read relevant materialized context paths before implementing safety, brand, architecture, or API contract requirements.",
      ] : []),
      ...(artifactOutputRoot ? [
        "If you create a reusable artifact, write it inside .tanya/artifact-output using the intended artifact-relative path and mention it as Artifact created.",
      ] : []),
      "When reporting artifact reuse, use the artifact sourcePath label when available.",
    ],
    expected_report: {
      ...(input.baseContext?.expected_report ?? {}),
      artifact_reuse: true,
    },
    metadata: {
      ...(input.baseContext?.metadata ?? {}),
      ...(artifactOutputRoot ? { artifactOutputRoot } : {}),
      tanyaMaterializedContext: true,
      keepMaterializedContext: input.keepContext === true,
    },
  };
}

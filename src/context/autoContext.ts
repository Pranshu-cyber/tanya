import type { TanyaRunContext } from "./runContext";
import { buildTaskBrief, type TanyaTaskBrief } from "../tools/projectContextTools";
import { materializeObsidianContext } from "../obsidian/search";

export type AutoRunContextOptions = {
  cwd: string;
  prompt: string;
  runContext?: TanyaRunContext;
  obsidianVault?: string | undefined;
  enableBrief?: boolean | undefined;
  enableObsidian?: boolean | undefined;
  keepContext?: boolean | undefined;
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function shouldTreatAsCodingTask(brief: TanyaTaskBrief, runContext?: TanyaRunContext): boolean {
  if (runContext?.task?.kind === "coding") return true;
  if (runContext?.expected_report && Object.keys(runContext.expected_report).length > 0) return true;
  if (runContext?.verification?.commands?.length) return true;
  if (runContext?.artifacts?.length || runContext?.contextFiles?.length) return true;
  return brief.signals.platforms.length > 0 || brief.signals.domains.length > 0;
}

export async function buildAutoRunContext(options: AutoRunContextOptions): Promise<TanyaRunContext | undefined> {
  let runContext = options.runContext;
  let brief: TanyaTaskBrief | undefined;
  const instructions: string[] = [...(runContext?.instructions ?? [])];
  const contextFiles: NonNullable<TanyaRunContext["contextFiles"]> = [...(runContext?.contextFiles ?? [])];
  const metadata: Record<string, unknown> = { ...(runContext?.metadata ?? {}) };
  const expectedReport: Record<string, unknown> = { ...(runContext?.expected_report ?? {}) };
  const verificationCommands = [...(runContext?.verification?.commands ?? [])];
  let didMaterializeContext = false;

  if (options.enableBrief !== false) {
    brief = await buildTaskBrief({
      workspace: options.cwd,
      task: options.prompt,
    });
    metadata.autoBrief = brief;
    metadata.autoBriefEnforceArtifacts = brief.artifacts.length > 0;
    instructions.push(
      "Tanya generated an automatic task brief before the run. Use it to choose context files, artifacts, capability packs, tools, and verification.",
      "If the automatic task brief lists artifact candidates and you change code, read at least one relevant artifact or explicitly explain why none applies before the final report.",
    );
    if (shouldTreatAsCodingTask(brief, runContext)) {
      expectedReport.verification = true;
      expectedReport.artifact_reuse = true;
      expectedReport.context_review = true;
      // Skip auto-recommended verification commands when the caller explicitly
      // overrode the list (e.g. via --require-verification). Preserves caller intent.
      if (!metadata.verificationOverridden) {
        for (const command of brief.verification) verificationCommands.push(command);
      }
      runContext = {
        ...(runContext ?? {}),
        task: {
          ...(runContext?.task ?? {}),
          kind: "coding",
          title: runContext?.task?.title ?? brief.task.slice(0, 120),
        },
      };
    }
  }

  if (options.enableObsidian !== false && options.obsidianVault?.trim()) {
    const materialized = await materializeObsidianContext({
      workspace: options.cwd,
      vaultPath: options.obsidianVault,
      query: options.prompt,
      maxResults: 5,
      ...(options.keepContext !== undefined ? { keepContext: options.keepContext } : {}),
    });
    if (materialized.contextFiles.length > 0) {
      didMaterializeContext = true;
      contextFiles.push(...materialized.contextFiles);
      metadata.obsidianContext = {
        vaultConfigured: true,
        noteCount: materialized.notes.length,
        notes: materialized.notes.map((note) => ({
          path: note.path,
          title: note.title,
          score: note.score,
          reason: note.reason,
        })),
      };
      instructions.push(
        "Relevant Obsidian note excerpts were materialized under .tanya/context/obsidian.",
        "Read relevant Obsidian context paths before implementing if the task depends on prior decisions, project memory, or historical fixes.",
      );
    } else {
      metadata.obsidianContext = { vaultConfigured: true, noteCount: 0 };
    }
  }

  if (!brief && contextFiles.length === 0 && instructions.length === (runContext?.instructions?.length ?? 0)) {
    return runContext;
  }

  return {
    ...(runContext ?? {}),
    ...(runContext?.task ? { task: runContext.task } : {}),
    ...(contextFiles.length > 0 ? { contextFiles } : {}),
    ...(instructions.length > 0 ? { instructions: unique(instructions) } : {}),
    ...(verificationCommands.length > 0 ? { verification: { commands: unique(verificationCommands) } } : {}),
    ...(Object.keys(expectedReport).length > 0 ? { expected_report: expectedReport } : {}),
    metadata: {
      ...metadata,
      autoContext: true,
      tanyaMaterializedContext: didMaterializeContext,
      keepMaterializedContext: options.keepContext === true,
      ...(options.obsidianVault ? { obsidianVault: options.obsidianVault } : {}),
    },
  };
}

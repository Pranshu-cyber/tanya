import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "../agent/runner";

function dailyNoteName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}.md`;
}

function taskTitle(runContext?: TanyaRunContext): string {
  return runContext?.task?.title?.trim() || "Tanya task";
}

function taskOutcome(manifest: TanyaFinalManifest): "passed" | "blocked" {
  const validationErrors = manifest.validation?.issues.filter((issue) => issue.severity === "error") ?? [];
  return manifest.blockers.length === 0 && validationErrors.length === 0 ? "passed" : "blocked";
}

function listSection(title: string, values: string[]): string[] {
  return [
    `**${title}:**`,
    ...(values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"]),
  ];
}

function buildTaskSection(manifest: TanyaFinalManifest, runContext?: TanyaRunContext): string {
  return [
    "",
    `## ${taskTitle(runContext)}`,
    `- Outcome: ${taskOutcome(manifest)}`,
    `- Git HEAD: ${manifest.git.head ?? "unavailable"}`,
    "",
    ...listSection("Changed files", manifest.changedFiles),
    "",
    ...listSection("Verification", manifest.verification),
    "",
  ].join("\n");
}

export async function appendTaskToVault(
  vaultPath: string,
  manifest: TanyaFinalManifest,
  runContext?: TanyaRunContext,
): Promise<void> {
  const notePath = join(vaultPath, dailyNoteName());
  await mkdir(dirname(notePath), { recursive: true });
  try {
    await writeFile(notePath, "", { flag: "wx" });
  } catch {
    // Existing notes are expected. Append below.
  }
  await appendFile(notePath, buildTaskSection(manifest, runContext), "utf8");
}

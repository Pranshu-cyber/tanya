import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { runShellTool } from "../tools/fsTools";
import { registerCommand, removeCommandsByCategory } from "./registry";
import type { CommandContext, CommandDefinition } from "./registry";
import { envValue } from "../config/envCompat";
import { appendAuditDecision } from "../memory/auditLog";
import { decide, type Decision, type PermissionContext } from "../safety/permissions/engine";
import { loadPermissionRules } from "../safety/permissions/rules";
import type { PermissionMode } from "../safety/permissions/schema";

const supportedExtensions = new Set([".js", ".ts", ".sh"]);
const permissionModes = new Set<PermissionMode>(["default", "ask", "bypass", "plan"]);
let loadedWorkspace: string | null = null;

export async function loadProjectCommands(workspace: string): Promise<void> {
  if (loadedWorkspace === workspace) return;
  loadedWorkspace = workspace;
  removeCommandsByCategory("project");

  const commandsDir = join(workspace, ".tanya", "commands");
  if (!existsSync(commandsDir)) return;

  let files: string[] = [];
  try {
    files = readdirSync(commandsDir)
      .filter((file) => supportedExtensions.has(extname(file)))
      .sort();
  } catch (error) {
    warnProjectCommand(commandsDir, error);
    return;
  }

  for (const file of files) {
    const path = join(commandsDir, file);
    try {
      const extension = extname(file);
      if (extension === ".sh") {
        registerShellCommand(workspace, path);
      } else {
        await registerModuleCommand(path);
      }
    } catch (error) {
      warnProjectCommand(path, error);
    }
  }
}

export function resetProjectCommandsForTests(): void {
  loadedWorkspace = null;
  removeCommandsByCategory("project");
}

function registerShellCommand(workspace: string, path: string): void {
  const slug = basename(path, extname(path));
  const relativePath = relative(workspace, path).replace(/\\/g, "/");
  registerCommand({
    name: `project:${slug}`,
    description: `Run ${relativePath}.`,
    category: "project",
    async handler(args, ctx) {
      if (!(await guardProjectCommand(ctx, `project:${slug}`, { path: relativePath, args, kind: "shell" }))) return;
      const script = ["zsh", quoteShell(relativePath), ...args.map(quoteShell)].join(" ");
      const result = await runShellTool.run({ script }, { workspace: ctx.cwd });
      const output = typeof result.output === "string" ? result.output : "";
      if (output) ctx.output.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      if (!result.ok) ctx.output.write(`${result.error ?? result.summary}\n`);
    },
  });
}

async function registerModuleCommand(path: string): Promise<void> {
  const href = pathToFileURL(path).href;
  const imported = extname(path) === ".ts"
    ? await tsImport(href, import.meta.url) as { default?: unknown }
    : await import(href) as { default?: unknown };
  const command = unwrapDefaultCommand(imported);
  if (!isCommandDefinition(command)) {
    throw new Error("default export is not a CommandDefinition");
  }
  registerCommand({
    ...command,
    name: command.name.startsWith("project:") ? command.name : `project:${command.name}`,
    category: "project",
    async handler(args, ctx) {
      const name = command.name.startsWith("project:") ? command.name : `project:${command.name}`;
      if (!(await guardProjectCommand(ctx, name, { path, args, kind: "module" }))) return;
      await command.handler(args, ctx);
    },
  });
}

async function guardProjectCommand(ctx: CommandContext, name: string, input: unknown): Promise<boolean> {
  const loaded = loadPermissionRules({ cwd: ctx.cwd });
  const rawMode = envValue(process.env, "TANYA_MODE")?.trim();
  const mode = rawMode && permissionModes.has(rawMode as PermissionMode) ? rawMode as PermissionMode : loaded.rules.mode;
  const permissionContext: PermissionContext = {
    mode,
    rules: loaded.rules,
    runId: ctx.runId ?? `command-${Date.now()}`,
    cwd: ctx.cwd,
  };
  let decision: Decision = mode === "bypass"
    ? { decision: "allow", reason: "bypass-mode" }
    : decide("project_command", { name, ...input as Record<string, unknown> }, permissionContext);
  let source: "user" | "rule" | "engine" | "bypass" = mode === "bypass" ? "bypass" : decision.matchedRule ? "rule" : "engine";
  const id = `command:${name}`;

  if (mode !== "bypass" && decision.decision === "ask") {
    await ctx.sink({
      type: "permission_request",
      id,
      tool: "project_command",
      input: { name, ...input as Record<string, unknown> },
      ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    });
    const answer = ctx.onPermissionRequest
      ? await ctx.onPermissionRequest({ id, tool: "project_command", input: { name, ...input as Record<string, unknown> }, ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}) })
      : { decision: "deny" as const };
    decision = { ...decision, decision: answer.decision, reason: answer.decision === "allow" ? "user-approved" : "permission-denied" };
    source = ctx.onPermissionRequest ? "user" : "engine";
    await ctx.sink({
      type: "permission_decision",
      id,
      decision: answer.decision,
      source,
      ...(answer.persistAs ? { persistAs: answer.persistAs } : {}),
      ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    });
  } else if (mode !== "bypass") {
    await ctx.sink({
      type: "permission_decision",
      id,
      decision: decision.decision === "deny" ? "deny" : "allow",
      source,
      ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    });
  }

  appendAuditDecision(ctx.cwd, {
    ts: new Date().toISOString(),
    runId: permissionContext.runId,
    tool: "project_command",
    input: { name, ...input as Record<string, unknown> },
    decision: decision.decision,
    source,
    mode,
    ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
  });

  if (decision.decision === "allow") return true;
  ctx.output.write(`permission denied: ${decision.matchedRule ?? decision.reason ?? "project command"}\n`);
  return false;
}

function unwrapDefaultCommand(imported: { default?: unknown }): unknown {
  if (isCommandDefinition(imported.default)) return imported.default;
  const nested = imported.default;
  if (nested && typeof nested === "object" && "default" in nested) {
    return (nested as { default?: unknown }).default;
  }
  return imported.default;
}

function isCommandDefinition(value: unknown): value is CommandDefinition {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { description?: unknown }).description === "string" &&
    typeof (value as { handler?: unknown }).handler === "function",
  );
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function warnProjectCommand(path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[tanya] Skipping project command ${path}: ${message}`);
}

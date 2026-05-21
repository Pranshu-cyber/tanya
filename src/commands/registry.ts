import type { EventSink } from "../events/types";
import type { ChatMessage, ChatProvider } from "../providers/types";
import type { PermissionRequestHandler } from "../safety/permissions/host";
import type { RunAgentOptions } from "../agent/runner";
import type { ChatSessionController } from "../sessions/repl";
import type { ChatSession } from "../sessions/types";

export type CommandCategory = "built-in" | "project";

export interface CommandContext {
  cwd: string;
  sink: EventSink;
  output: NodeJS.WritableStream;
  provider?: ChatProvider;
  history?: ChatMessage[];
  clearHistory?: () => void;
  replaceHistory?: (history: ChatMessage[]) => void;
  onSessionResumed?: (session: ChatSession) => void;
  sessionController?: ChatSessionController | undefined;
  runId?: string;
  onPermissionRequest?: PermissionRequestHandler;
  routing?: RunAgentOptions["routing"];
}

export interface CommandDefinition {
  name: string;
  description: string;
  category?: CommandCategory;
  availability?: (ctx: CommandContext) => boolean | Promise<boolean>;
  handler: (args: string[], ctx: CommandContext) => void | Promise<void>;
}

const commands = new Map<string, CommandDefinition>();

export function registerCommand(command: CommandDefinition): void {
  const name = normalizeCommandName(command.name);
  if (!name) throw new Error("Command name cannot be empty.");
  commands.set(name, { ...command, name });
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(normalizeCommandName(name));
}

export function listCommands(): CommandDefinition[] {
  return [...commands.values()].sort((a, b) => {
    const category = (a.category ?? "built-in").localeCompare(b.category ?? "built-in");
    return category || a.name.localeCompare(b.name);
  });
}

export function removeCommandsByCategory(category: CommandCategory): void {
  for (const [name, command] of commands) {
    if (command.category === category) commands.delete(name);
  }
}

export async function commandIsAvailable(command: CommandDefinition, ctx: CommandContext): Promise<boolean> {
  return command.availability ? await command.availability(ctx) : true;
}

export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

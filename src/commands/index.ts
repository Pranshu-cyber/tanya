import "./builtin/audit";
import "./builtin/budget";
import "./builtin/clear";
import "./builtin/cost";
import "./builtin/help";
import "./builtin/memory";
import "./builtin/mcp";
import "./builtin/mode";
import "./builtin/route";
import "./builtin/skills";
import "./builtin/verify";
import "./sessions";
import { commandIsAvailable, getCommand, normalizeCommandName } from "./registry";
import type { CommandContext } from "./registry";
import { loadProjectCommands } from "./project";

export type ParsedCommandLine = {
  name: string;
  args: string[];
};

export function parseCommandLine(line: string): ParsedCommandLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return null;
  const firstWhitespace = body.search(/\s/);
  const rawName = firstWhitespace === -1 ? body : body.slice(0, firstWhitespace);
  const rawArgs = firstWhitespace === -1 ? "" : body.slice(firstWhitespace).trim();
  const name = normalizeCommandName(rawName);
  if (!/^[a-z0-9:_-]+$/.test(name)) return null;
  return { name, args: splitCommandArgs(rawArgs) };
}

export function commandNameFromLine(line: string): string | null {
  return parseCommandLine(line)?.name ?? null;
}

export async function runCommand(line: string, ctx: CommandContext): Promise<boolean> {
  const parsed = parseCommandLine(line);
  if (!parsed) return false;
  await loadProjectCommands(ctx.cwd);

  const command = getCommand(parsed.name);
  if (!command) return false;
  if (!(await commandIsAvailable(command, ctx))) return false;

  await ctx.sink({
    type: "command_invoked",
    name: command.name,
    args: parsed.args,
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  });
  await command.handler(parsed.args, ctx);
  return true;
}

function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

export {
  commandIsAvailable,
  getCommand,
  listCommands,
  normalizeCommandName,
  registerCommand,
  removeCommandsByCategory,
} from "./registry";
export { loadProjectCommands } from "./project";
export type { CommandContext, CommandDefinition } from "./registry";

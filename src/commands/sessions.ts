import { formatSessionList } from "../cli/sessionsCommand";
import { listSessions } from "../sessions/storage";
import { replayTurns, resumeBanner, sessionToChatHistory } from "../sessions/repl";
import type { ChatSession } from "../sessions/types";
import { formatClock, formatElapsed } from "../utils/formatElapsed";
import { registerCommand } from "./registry";
import type { CommandContext, CommandDefinition } from "./registry";

const sessionsCommand: CommandDefinition = {
  name: "sessions",
  description: "List recent chat sessions.",
  category: "built-in",
  handler(_args, ctx) {
    ctx.output.write(formatSessionList(listSessions({ cwd: ctx.cwd, limit: 10 }), outputColumns(ctx.output)));
  },
};

const resumeCommand: CommandDefinition = {
  name: "resume",
  description: "Resume a saved chat session.",
  category: "built-in",
  async handler(args, ctx) {
    const id = args[0];
    if (!id) {
      ctx.output.write("Usage: /resume <id>\n");
      return;
    }
    if (!ctx.sessionController) {
      ctx.output.write("Session persistence is not available in this context.\n");
      return;
    }
    const unsaved = ctx.sessionController.unsavedTurnCount;
    if (unsaved > 0) {
      const ok = await confirm(ctx, `Current session has ${unsaved} turn${unsaved === 1 ? "" : "s"}. Discard and resume ${id}?`);
      if (!ok) {
        ctx.output.write("Resume cancelled.\n");
        return;
      }
    }
    const loaded = ctx.sessionController.resume(id, ctx.cwd);
    const history = sessionToChatHistory(loaded.session);
    if (ctx.replaceHistory) ctx.replaceHistory(history);
    else if (ctx.history) ctx.history.splice(0, ctx.history.length, ...history);
    ctx.output.write(`${resumeBanner(loaded.session)}\n`);
    if (ctx.onSessionResumed) ctx.onSessionResumed(loaded.session);
    else writeReplay(ctx, loaded.session);
  },
};

const saveCommand: CommandDefinition = {
  name: "save",
  description: "Persist the active session now and optionally label it.",
  category: "built-in",
  handler(args, ctx) {
    if (!ctx.sessionController) {
      ctx.output.write("Session persistence is not available in this context.\n");
      return;
    }
    const label = args.join(" ").trim();
    const session = ctx.sessionController.save(label || undefined);
    ctx.output.write(`Saved session ${session.id}${session.label ? ` · ${session.label}` : ""}\n`);
  },
};

async function confirm(ctx: CommandContext, question: string): Promise<boolean> {
  if (!ctx.onPermissionRequest) return true;
  const answer = await ctx.onPermissionRequest({
    id: `resume-session-${Date.now()}`,
    tool: "resume_session",
    input: { question },
  });
  return answer.decision === "allow";
}

function writeReplay(ctx: CommandContext, session: ChatSession): void {
  const turns = replayTurns(session, 10);
  ctx.output.write(`── resumed ${session.turns.length} turns ──\n`);
  for (const turn of turns) {
    const clock = formatClock(new Date(turn.timestampMs));
    const elapsed = typeof turn.elapsedMs === "number" ? ` · ${formatElapsed(turn.elapsedMs)}` : "";
    ctx.output.write(`[${clock}] ${turn.role}${elapsed}: ${turn.content}\n`);
  }
}

function outputColumns(output: NodeJS.WritableStream): number {
  return Math.max(60, (output as NodeJS.WritableStream & { columns?: number }).columns ?? 100);
}

registerCommand(sessionsCommand);
registerCommand(resumeCommand);
registerCommand(saveCommand);

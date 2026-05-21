import type { RunAgentResult } from "../agent/runner";
import type { ChatMessage } from "../providers/types";
import type { InkMessage, InkSessionStats } from "../ui/ink/types";
import { appendTurn, createSession, findContinueSession, loadSession, materialize, updateSessionLabel } from "./storage";
import type { ChatSession, LoadedSession, SessionStats, SessionTurn } from "./types";

export interface ChatSessionControllerOptions {
  cwd: string;
  provider: string;
  model: string;
  continueSession?: boolean | undefined;
  resumeSessionId?: string | undefined;
}

export interface ChatSessionStart {
  controller: ChatSessionController;
  resumedSession?: ChatSession;
  notice?: string;
}

export class ChatSessionController {
  session: ChatSession;
  unsavedTurnCount = 0;

  constructor(session: ChatSession) {
    this.session = session;
  }

  appendCompletedTurn(prompt: string, message: string, startedAt: number, elapsedMs: number, result: RunAgentResult): void {
    const userTurn: SessionTurn = {
      role: "user",
      content: prompt,
      timestampMs: startedAt,
      elapsedMs: null,
    };
    const assistantTurn: SessionTurn = {
      role: "assistant",
      content: message,
      timestampMs: Date.now(),
      elapsedMs,
      ...(result.metrics ? {
        metrics: {
          promptTokens: result.metrics.promptTokens,
          completionTokens: result.metrics.completionTokens,
          reasoningTokens: result.metrics.reasoningTokens,
        },
      } : {}),
    };
    appendTurn(this.session.id, userTurn);
    appendTurn(this.session.id, assistantTurn);
    this.session.turns.push(userTurn, assistantTurn);
    this.unsavedTurnCount += 1;
  }

  materialize(label?: string): ChatSession {
    this.session = materialize(this.session.id, { cwd: this.session.cwd, ...(label ? { label } : {}) });
    this.unsavedTurnCount = 0;
    return this.session;
  }

  save(label?: string): ChatSession {
    this.session = label ? updateSessionLabel(this.session.id, label, { cwd: this.session.cwd }) : materialize(this.session.id, { cwd: this.session.cwd });
    this.unsavedTurnCount = 0;
    return this.session;
  }

  resume(id: string, cwd: string): LoadedSession {
    const loaded = loadSession(id, { cwd });
    this.session = loaded.session;
    this.unsavedTurnCount = 0;
    return loaded;
  }
}

export function startChatSession(options: ChatSessionControllerOptions): ChatSessionStart {
  if (options.resumeSessionId) {
    const loaded = loadSession(options.resumeSessionId, { cwd: options.cwd });
    return { controller: new ChatSessionController(loaded.session), resumedSession: loaded.session };
  }
  if (options.continueSession) {
    const loaded = findContinueSession({ cwd: options.cwd });
    if (loaded) return { controller: new ChatSessionController(loaded.session), resumedSession: loaded.session };
    return {
      controller: new ChatSessionController(createSession({
        cwd: options.cwd,
        provider: options.provider,
        model: options.model,
      })),
      notice: `No previous session found in ${options.cwd}. Starting fresh.`,
    };
  }
  return {
    controller: new ChatSessionController(createSession({
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
    })),
  };
}

export function sessionToChatHistory(session: ChatSession): ChatMessage[] {
  return session.turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role, content: turn.content }));
}

export function sessionToInkMessages(session: ChatSession, limit = 10): InkMessage[] {
  return replayTurns(session, limit).map((turn, index) => ({
    id: `resume-${session.id}-${index}`,
    role: turn.role,
    content: turn.content,
    timestampMs: turn.timestampMs,
    ...(typeof turn.elapsedMs === "number" ? { elapsedMs: turn.elapsedMs } : {}),
  }));
}

export function replayTurns(session: ChatSession, limit = 10): SessionTurn[] {
  return session.turns.slice(Math.max(0, session.turns.length - limit));
}

export function statsToInkStats(stats: SessionStats): InkSessionStats {
  return {
    costUsd: stats.costUsd,
    totalTokens: stats.totalTokens,
  };
}

export function resumeBanner(session: ChatSession): string {
  return `Resumed session ${session.id} · ${session.sessionStats.turnCount} turns · /save to label, /sessions to switch`;
}

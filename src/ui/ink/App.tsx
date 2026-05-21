import React, { useEffect, useReducer, useRef } from "react";
import { Box, useApp } from "ink";
import { runAgent } from "../../agent/runner";
import type { ChatProvider } from "../../providers/types";
import type { ChatMessage } from "../../providers/types";
import type { RunAgentOptions } from "../../agent/runner";
import type { HostPermissionAnswer, PermissionRequestHandler } from "../../safety/permissions/host";
import { dispatchInteractiveCommand } from "../../agent/chat";
import { loadProjectCommands } from "../../commands/project";
import { listCommands } from "../../commands/registry";
import { formatElapsed } from "../../utils/formatElapsed";
import { Footer } from "./Footer";
import { History } from "./History";
import { Input } from "./Input";
import { PermissionPrompt } from "./PermissionPrompt";
import { ActivityPanel } from "./ActivityPanel";
import { createInkSink } from "./sinkAdapter";
import { createInitialInkState, inkReducer, type InkAction, type InkState } from "./state";
import type { InkMessage, InkSessionStats } from "./types";
import { useSessionTicker } from "./useSessionTicker";
import {
  resumeBanner,
  sessionToInkMessages,
  statsToInkStats,
  type ChatSessionController,
} from "../../sessions/repl";
import type { ChatSession } from "../../sessions/types";

function createInkCommandOutput(dispatch: React.Dispatch<InkAction>): NodeJS.WritableStream {
  return {
    write(chunk: unknown) {
      const content = String(chunk).trimEnd();
      if (content) dispatch({ type: "system_message", content });
      return true;
    },
  } as NodeJS.WritableStream;
}

function sessionSummary(state: InkState): string {
  return `Session: ${formatElapsed(Date.now() - state.sessionStartMs)} elapsed · ${formatElapsed(state.sessionGenerateMs)} generating · ${state.turnCount} turn${state.turnCount === 1 ? "" : "s"}`;
}

export function App({
  provider,
  cwd,
  routing,
  initialMessages = [],
  initialHistory,
  initialStats,
  initialGenerateMs,
  initialTurnCount,
  sessionController,
  onSubmit,
  onExitSummary,
}: {
  provider: ChatProvider;
  cwd: string;
  routing?: RunAgentOptions["routing"];
  initialMessages?: InkMessage[] | undefined;
  initialHistory?: ChatMessage[] | undefined;
  initialStats?: InkSessionStats | undefined;
  initialGenerateMs?: number | undefined;
  initialTurnCount?: number | undefined;
  sessionController?: ChatSessionController | undefined;
  onSubmit?: (value: string) => void;
  onExitSummary?: (summary: string) => void;
}) {
  const app = useApp();
  const [state, dispatch] = useReducer(
    inkReducer,
    {
      provider: provider.id,
      model: provider.model,
      initialMessages,
      initialStats,
      initialGenerateMs,
      initialTurnCount,
    },
    createInitialInkState,
  );
  const historyRef = useRef<ChatMessage[]>(initialHistory ?? []);
  const stateRef = useRef(state);
  const activeAbortController = useRef<AbortController | null>(null);
  const permissionResolver = useRef<((answer: HostPermissionAnswer) => void) | null>(null);
  const now = useSessionTicker(1000);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const handleBeforeExit = () => {
      try {
        sessionController?.materialize();
      } catch {
        // Session materialization should not mask process shutdown.
      }
    };
    process.on("beforeExit", handleBeforeExit);
    return () => {
      process.off("beforeExit", handleBeforeExit);
      handleBeforeExit();
    };
  }, [sessionController]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadProjectCommands(cwd);
      if (cancelled) return;
      const projectCommandCount = listCommands().filter((command) => command.category === "project").length;
      dispatch({ type: "system_message", content: `Tanya · loaded ${projectCommandCount} project command${projectCommandCount === 1 ? "" : "s"} · ready.` });
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const handlePermissionRequest: PermissionRequestHandler = async (request) => {
    return new Promise((resolve) => {
      permissionResolver.current = resolve;
      dispatch({ type: "permission_request", request });
    });
  };

  const answerPermission = (answer: HostPermissionAnswer) => {
    const resolve = permissionResolver.current;
    permissionResolver.current = null;
    dispatch({ type: "permission_clear" });
    resolve?.(answer);
  };

  const handleExit = () => {
    if (stateRef.current.pendingPermission) {
      answerPermission({ decision: "deny" });
      dispatch({ type: "system_message", content: "Denied pending permission request." });
      return;
    }
    if (activeAbortController.current && !activeAbortController.current.signal.aborted) {
      activeAbortController.current.abort();
      dispatch({ type: "system_message", content: "Cancelled active run." });
      return;
    }
    try {
      sessionController?.materialize();
    } catch {
      // Session materialization should not mask UI exit.
    }
    onExitSummary?.(sessionSummary(stateRef.current));
    app.exit();
  };

  const handleSubmit = (value: string) => {
    if (onSubmit) {
      onSubmit(value);
      return;
    }
    void (async () => {
      const prompt = value.trim();
      if (!prompt) return;
      if (prompt.startsWith("/")) {
        const output = createInkCommandOutput(dispatch);
        await dispatchInteractiveCommand(prompt, {
          provider,
          cwd,
          sink: async () => {},
          output,
          history: historyRef.current,
          ...(routing ? { routing } : {}),
          sessionController,
          clearHistory: () => {
            historyRef.current.length = 0;
            dispatch({ type: "clear" });
          },
          replaceHistory: (nextHistory) => {
            historyRef.current = nextHistory;
          },
          onSessionResumed: (session) => {
            replaceRenderedSession(dispatch, session);
          },
          onPermissionRequest: handlePermissionRequest,
        });
        return;
      }
      const timestampMs = Date.now();
      dispatch({ type: "user_message", content: prompt, timestampMs });
      const startedAt = Date.now();
      dispatch({ type: "turn_start", startedAt });
      const abortController = new AbortController();
      activeAbortController.current = abortController;
      try {
        const sink = createInkSink(dispatch, {
          provider: provider.id,
          model: provider.model,
          startedAt,
        });
        const result = await runAgent({
          provider,
          prompt,
          cwd,
          sink,
          history: historyRef.current,
          signal: abortController.signal,
          onPermissionRequest: handlePermissionRequest,
          ...(routing ? { routing } : {}),
        });
        historyRef.current.push({ role: "user", content: prompt });
        historyRef.current.push({ role: "assistant", content: result.message });
        sessionController?.appendCompletedTurn(prompt, result.message, startedAt, Date.now() - startedAt, result);
      } catch (error) {
        dispatch({ type: "turn_error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        activeAbortController.current = null;
      }
    })();
  };

  return (
    <Box flexDirection="column" height="100%" minHeight={8}>
      <History
        messages={state.messages}
        pendingTurn={state.pendingTurn}
        liveAssistantId={state.liveAssistantId}
      />
      <ActivityPanel items={state.activityItems} />
      <PermissionPrompt request={state.pendingPermission} onAnswer={answerPermission} />
      <Input
        disabled={state.pendingTurn !== null || state.pendingPermission !== null}
        {...(state.pendingTurn?.spinnerVisible ? { pendingStartedAt: state.pendingTurn.startedAt } : {})}
        now={now}
        onSubmit={handleSubmit}
        onExit={handleExit}
      />
      <Footer
        provider={provider.id}
        model={provider.model}
        sessionStartMs={state.sessionStartMs}
        stats={state.stats}
        now={now}
        showColdStartHint={state.turnCount === 0}
      />
    </Box>
  );
}

function replaceRenderedSession(dispatch: React.Dispatch<InkAction>, session: ChatSession): void {
  const now = Date.now();
  dispatch({
    type: "replace_session",
    messages: [
      {
        id: `session-banner-${session.id}-${now}`,
        role: "system",
        content: resumeBanner(session),
        timestampMs: now,
      },
      ...sessionToInkMessages(session, 10),
    ],
    stats: statsToInkStats(session.sessionStats),
    generateMs: session.sessionStats.generateMs,
    turnCount: session.sessionStats.turnCount,
  });
}

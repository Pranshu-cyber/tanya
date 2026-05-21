import { createInterface } from "node:readline/promises";
import { stdin as processInput, stdout as processOutput } from "node:process";
import type { ChatMessage, ChatProvider } from "../providers/types";
import type { EventSink, TanyaEvent } from "../events/types";
import { runAgent, type RunAgentOptions, type RunAgentResult } from "./runner";
import { commandNameFromLine, loadProjectCommands, runCommand } from "../commands";
import type { CommandContext } from "../commands";
import { createReplPermissionRequestHandler } from "../ui/permissionPrompt";
import { formatClock, formatElapsed } from "../utils/formatElapsed";
import {
  replayTurns,
  resumeBanner,
  sessionToChatHistory,
  startChatSession,
  type ChatSessionController,
} from "../sessions/repl";
import type { ChatSession } from "../sessions/types";

const thinkingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function streamIsTTY(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
}

export function createThinkingSpinner(output: NodeJS.WritableStream): () => void {
  if (!streamIsTTY(output)) return () => {};
  let frame = 0;
  let stopped = false;
  let maxRenderedWidth = 0;
  const startedAt = Date.now();
  const render = () => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const text = `Tanya: ${thinkingFrames[frame % thinkingFrames.length]} thinking… (${elapsedSec}s)`;
    maxRenderedWidth = Math.max(maxRenderedWidth, text.length);
    output.write(`\r${text}`);
    frame += 1;
  };
  render();
  const timer = setInterval(render, 120);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    output.write(`\r${" ".repeat(Math.max(maxRenderedWidth, 1))}\r`);
  };
}

function wrapSinkForInteractiveTurn(params: {
  sink: EventSink;
  startedAt: number;
  stopSpinner: () => void;
}): EventSink {
  let spinnerStopped = false;
  let streamedAnyMessageDelta = false;
  const supportsElapsedHeading = (params.sink as EventSink & { tanyaSinkKind?: string }).tanyaSinkKind === "human";
  let pendingMessageStart: Extract<TanyaEvent, { type: "message_start" }> | null = null;
  const stopSpinner = () => {
    if (spinnerStopped) return;
    spinnerStopped = true;
    params.stopSpinner();
  };
  const flushPendingMessageStart = () => {
    if (!pendingMessageStart) return;
    const event = pendingMessageStart;
    pendingMessageStart = null;
    const now = Date.now();
    return params.sink({ ...event, elapsedMs: now - params.startedAt, headingStartedAt: now });
  };
  return (event) => {
    if (!supportsElapsedHeading) {
      stopSpinner();
      return params.sink(event);
    }
    if (event.type === "message_start") {
      pendingMessageStart = event;
      return;
    }
    stopSpinner();
    const pendingResult = flushPendingMessageStart();
    if (event.type === "message_delta") {
      streamedAnyMessageDelta = true;
    }
    if (event.type === "final" && streamedAnyMessageDelta) {
      if (pendingResult && typeof (pendingResult as Promise<void>).then === "function") {
        return Promise.resolve(pendingResult).then(() => params.sink({ ...event, suppressHumanMessage: true }));
      }
      return params.sink({ ...event, suppressHumanMessage: true });
    }
    if (pendingResult && typeof (pendingResult as Promise<void>).then === "function") {
      return Promise.resolve(pendingResult).then(() => params.sink(event));
    }
    return params.sink(event);
  };
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && /readline was closed/i.test(error.message);
}

export async function dispatchInteractiveCommand(prompt: string, ctx: CommandContext): Promise<boolean> {
  if (!prompt.startsWith("/")) return false;
  const handled = await runCommand(prompt, ctx);
  if (handled) return true;
  const commandName = commandNameFromLine(prompt);
  ctx.output.write(`unknown command: /${commandName ?? ""}; try /help\n`);
  return true;
}

export async function startInteractiveChat(inputOptions: {
  provider: ChatProvider;
  cwd: string;
  sink: EventSink;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  routing?: RunAgentOptions["routing"];
  continueSession?: boolean | undefined;
  resumeSessionId?: string | undefined;
}): Promise<void> {
  const input = inputOptions.input ?? processInput;
  const output = inputOptions.output ?? processOutput;
  const rl = createInterface({ input, output });
  const sessionStart = startChatSession({
    cwd: inputOptions.cwd,
    provider: inputOptions.provider.id,
    model: inputOptions.provider.model,
    continueSession: inputOptions.continueSession,
    resumeSessionId: inputOptions.resumeSessionId,
  });
  const sessionController = sessionStart.controller;
  const history: ChatMessage[] = sessionStart.resumedSession ? sessionToChatHistory(sessionStart.resumedSession) : [];
  let activeAbortController: AbortController | null = null;
  let stopActiveSpinner: () => void = () => {};
  const sessionStartMs = Date.now();
  let sessionGenerateMs = sessionStart.resumedSession?.sessionStats.generateMs ?? 0;
  let turnCount = sessionStart.resumedSession?.sessionStats.turnCount ?? 0;
  let sessionSummaryPrinted = false;
  const onPermissionRequest = createReplPermissionRequestHandler({
    question: (message) => rl.question(message),
    output,
  });
  await loadProjectCommands(inputOptions.cwd);
  output.write(`Tanya live chat (${inputOptions.provider.id}:${inputOptions.provider.model}). Type /exit to quit.\n`);
  if (sessionStart.notice) output.write(`${sessionStart.notice}\n`);
  if (sessionStart.resumedSession) {
    output.write(`${resumeBanner(sessionStart.resumedSession)}\n`);
    writeSessionReplay(output, sessionStart.resumedSession);
  }
  const printSessionSummary = () => {
    if (sessionSummaryPrinted) return;
    sessionSummaryPrinted = true;
    safeMaterialize(sessionController);
    output.write(`Session: ${formatElapsed(Date.now() - sessionStartMs)} elapsed · ${formatElapsed(sessionGenerateMs)} generating · ${turnCount} turn${turnCount === 1 ? "" : "s"}\n`);
  };
  const handleBeforeExit = () => {
    safeMaterialize(sessionController);
  };
  const handleSigint = () => {
    stopActiveSpinner();
    if (activeAbortController && !activeAbortController.signal.aborted) {
      output.write("\nCancelling active tool...\n");
      activeAbortController.abort();
      return;
    }
    printSessionSummary();
    rl.close();
    process.exitCode = 130;
  };
  process.on("SIGINT", handleSigint);
  process.on("beforeExit", handleBeforeExit);

  try {
    while (true) {
      let rawPrompt: string;
      try {
        const promptShownAt = new Date();
        rawPrompt = await rl.question(streamIsTTY(output) ? `\n[${formatClock(promptShownAt)}] You: ` : "\nYou: ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          printSessionSummary();
          break;
        }
        throw error;
      }
      const prompt = rawPrompt.trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") {
        printSessionSummary();
        break;
      }
      if (await dispatchInteractiveCommand(prompt, {
        provider: inputOptions.provider,
        cwd: inputOptions.cwd,
        sink: inputOptions.sink,
        output,
        history,
        ...(inputOptions.routing ? { routing: inputOptions.routing } : {}),
        sessionController,
        clearHistory: () => {
          history.length = 0;
        },
        replaceHistory: (nextHistory) => {
          history.splice(0, history.length, ...nextHistory);
        },
        onSessionResumed: (session) => {
          sessionGenerateMs = session.sessionStats.generateMs;
          turnCount = session.sessionStats.turnCount;
          writeSessionReplay(output, session);
        },
        onPermissionRequest,
      })) {
        continue;
      }

      const abortController = new AbortController();
      activeAbortController = abortController;
      const startedAt = Date.now();
      stopActiveSpinner = createThinkingSpinner(output);
      const turnSink = wrapSinkForInteractiveTurn({
        sink: inputOptions.sink,
        startedAt,
        stopSpinner: stopActiveSpinner,
      });
      let message: string;
      let result: RunAgentResult | undefined;
      let elapsedMs = 0;
      try {
        result = await runAgent({
          provider: inputOptions.provider,
          prompt,
          cwd: inputOptions.cwd,
          sink: turnSink,
          history,
          signal: abortController.signal,
          onPermissionRequest,
          ...(inputOptions.routing ? { routing: inputOptions.routing } : {}),
        });
        message = result.message;
        elapsedMs = Date.now() - startedAt;
      } finally {
        stopActiveSpinner();
        stopActiveSpinner = () => {};
        activeAbortController = null;
      }
      sessionGenerateMs += elapsedMs;
      turnCount += 1;
      history.push({ role: "user", content: prompt });
      history.push({ role: "assistant", content: message });
      if (result) sessionController.appendCompletedTurn(prompt, message, startedAt, elapsedMs, result);
    }
  } finally {
    safeMaterialize(sessionController);
    process.off("SIGINT", handleSigint);
    process.off("beforeExit", handleBeforeExit);
    rl.close();
  }
}

function writeSessionReplay(output: NodeJS.WritableStream, session: ChatSession): void {
  output.write(`── resumed ${session.turns.length} turns ──\n`);
  for (const turn of replayTurns(session, 10)) {
    const clock = formatClock(new Date(turn.timestampMs));
    const label = turn.role === "user" ? "You" : "Tanya";
    const elapsed = typeof turn.elapsedMs === "number" ? ` · ${formatElapsed(turn.elapsedMs)}` : "";
    output.write(`[${clock}] ${label}${elapsed}: ${turn.content}\n`);
  }
}

function safeMaterialize(controller: ChatSessionController): void {
  try {
    controller.materialize();
  } catch {
    // Session materialization should not mask REPL shutdown.
  }
}

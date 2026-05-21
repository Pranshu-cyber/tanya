import React from "react";
import { render } from "ink";
import type { ChatProvider } from "../../providers/types";
import type { RunAgentOptions } from "../../agent/runner";
import { App } from "./App";
import {
  resumeBanner,
  sessionToChatHistory,
  sessionToInkMessages,
  startChatSession,
  statsToInkStats,
} from "../../sessions/repl";
import type { InkMessage } from "./types";

export async function startInkChat(options: {
  provider: ChatProvider;
  cwd: string;
  routing?: RunAgentOptions["routing"];
  continueSession?: boolean | undefined;
  resumeSessionId?: string | undefined;
}): Promise<void> {
  const sessionStart = startChatSession({
    cwd: options.cwd,
    provider: options.provider.id,
    model: options.provider.model,
    continueSession: options.continueSession,
    resumeSessionId: options.resumeSessionId,
  });
  const initialMessages: InkMessage[] = [];
  if (sessionStart.notice) {
    initialMessages.push({
      id: `session-notice-${Date.now()}`,
      role: "system",
      content: sessionStart.notice,
      timestampMs: Date.now(),
    });
  }
  if (sessionStart.resumedSession) {
    initialMessages.push({
      id: `session-banner-${sessionStart.resumedSession.id}`,
      role: "system",
      content: resumeBanner(sessionStart.resumedSession),
      timestampMs: Date.now(),
    });
    initialMessages.push(...sessionToInkMessages(sessionStart.resumedSession, 10));
  }
  let summary = "";
  const instance = render(
    <App
      provider={options.provider}
      cwd={options.cwd}
      {...(options.routing ? { routing: options.routing } : {})}
      sessionController={sessionStart.controller}
      initialMessages={initialMessages}
      initialHistory={sessionStart.resumedSession ? sessionToChatHistory(sessionStart.resumedSession) : []}
      initialStats={statsToInkStats(sessionStart.controller.session.sessionStats)}
      initialGenerateMs={sessionStart.controller.session.sessionStats.generateMs}
      initialTurnCount={sessionStart.controller.session.sessionStats.turnCount}
      onExitSummary={(line) => {
        summary = line;
      }}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  if (summary) process.stdout.write(`${summary}\n`);
}

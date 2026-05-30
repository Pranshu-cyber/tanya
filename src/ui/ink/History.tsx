import React from "react";
import { Box, Static, Text } from "ink";
import { formatClock, formatElapsed } from "../../utils/formatElapsed";
import type { InkMessage } from "./types";
import type { PendingTurn } from "./state";
import { MarkdownText } from "./markdown";
import { clampToLastLines } from "./clampLines";

// While a message is still streaming (live), show only its last N lines so a
// long single reply can't grow the live region past the terminal height and
// trigger Ink's full-screen repaint. The full text renders once the message
// finalizes into <Static>.
const MAX_LIVE_MESSAGE_LINES = 14;

function messagePrefix(message: InkMessage): string {
  const clock = `[${formatClock(new Date(message.timestampMs))}]`;
  if (message.role === "user") return `${clock} You:`;
  if (message.role === "assistant") {
    return `${clock} Tanya${message.elapsedMs !== undefined ? ` · ${formatElapsed(message.elapsedMs)}` : ""}:`;
  }
  if (message.role === "tool") return `${clock} tool:`;
  return `${clock} ·`;
}

const MessageBlock = React.memo(function MessageBlock({ message, live = false }: { message: InkMessage; live?: boolean }) {
  const content = live ? clampToLastLines(message.content, MAX_LIVE_MESSAGE_LINES) : message.content;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={message.role === "user" ? "green" : message.role === "assistant" ? "cyan" : "gray"}>
        {messagePrefix(message)}
      </Text>
      {content
        ? message.role === "assistant"
          ? <MarkdownText source={content} formatPartialLine={!live} />
          : <Text wrap="wrap">{content}</Text>
        : null}
    </Box>
  );
}, (previous, next) => previous.live === next.live &&
  previous.message.id === next.message.id &&
  previous.message.role === next.message.role &&
  previous.message.elapsedMs === next.message.elapsedMs &&
  previous.message.content.length === next.message.content.length);

export function splitHistoryMessages(messages: InkMessage[], pendingTurn: PendingTurn | null, liveAssistantId: string | null): {
  finalized: InkMessage[];
  live: InkMessage[];
} {
  if (!pendingTurn) return { finalized: messages, live: [] };

  const finalized: InkMessage[] = [];
  const live: InkMessage[] = [];
  for (const message of messages) {
    if (message.id === liveAssistantId || (message.role === "system" && message.timestampMs >= pendingTurn.startedAt)) {
      live.push(message);
    } else {
      finalized.push(message);
    }
  }
  return { finalized, live };
}

export function History({ messages, pendingTurn, liveAssistantId }: {
  messages: InkMessage[];
  pendingTurn: PendingTurn | null;
  liveAssistantId: string | null;
}) {
  const { finalized, live } = splitHistoryMessages(messages, pendingTurn, liveAssistantId);
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {messages.length === 0 ? (
        <Text dimColor>Tanya chat ready.</Text>
      ) : (
        <>
          <Static<InkMessage> items={finalized}>
            {(message) => <MessageBlock key={message.id} message={message} />}
          </Static>
          {live.map((message) => (
            <MessageBlock key={message.id} message={message} live />
          ))}
        </>
      )}
    </Box>
  );
}

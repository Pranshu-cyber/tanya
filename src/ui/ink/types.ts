export type InkRole = "user" | "assistant" | "system" | "tool";

export interface InkMessage {
  id: string;
  role: InkRole;
  content: string;
  timestampMs: number;
  elapsedMs?: number;
}

export interface InkSessionStats {
  costUsd: number | null;
  totalTokens: number | null;
}

export type ActivityKind = "reasoning" | "tool";
export type ActivityStatus = "active" | "done" | "error";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  summary: string;
  content?: string;
  startedAt: number;
  endedAt?: number;
}

import type { EventSink, TanyaEvent } from "./types";

export function createSubAgentSink(parent: EventSink, subRunId: string): EventSink {
  return (event: TanyaEvent) => parent({ ...event, subRunId });
}

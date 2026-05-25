import { describe, expect, it, vi } from "vitest";
import { createCosmoChatFinalizeSink } from "../cosmochatFinalize";
import type { TanyaEvent } from "../../events/types";

function env(extra: Record<string, string> = {}) {
  return {
    COSMOCHAT_RUN_ID: "run-1",
    COSMOCHAT_BASE_URL: "http://cosmochat.test",
    COSMOCHAT_SERVICE_TOKEN: "svc-token",
    TANYA_COSMOCHAT_MESSAGE_END_GRACE_MS: "10",
    ...extra,
  };
}

describe("createCosmoChatFinalizeSink", () => {
  it("passes through without patching when no CosmoChat run context exists", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const seen: TanyaEvent[] = [];
    const sink = createCosmoChatFinalizeSink((event) => { seen.push(event); }, { env: {}, fetchImpl });

    await sink({ type: "message_end" });
    await sink({
      type: "final",
      message: "Done.\n\nTANYA RESULT: PASSED",
      files: [],
      manifest: { blockers: [] },
    });

    expect(seen.map((event) => event.type)).toEqual(["message_end", "final"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("patches CosmoChat failed when message_end has no follow-up event", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const seen: TanyaEvent[] = [];
    const sink = createCosmoChatFinalizeSink((event) => { seen.push(event); }, { env: env(), fetchImpl });

    await sink({ type: "message_end" });
    await vi.advanceTimersByTimeAsync(11);

    expect(seen).toEqual([{ type: "message_end" }]);
    expect(fetchImpl).toHaveBeenCalledWith("http://cosmochat.test/v1/runs/run-1", expect.objectContaining({
      method: "PATCH",
      headers: expect.objectContaining({
        authorization: "Bearer svc-token",
        "content-type": "application/json",
      }),
      body: expect.stringContaining("\"status\":\"failed\""),
    }));
    vi.useRealTimers();
  });

  it("cancels message_end timeout when a follow-up tool event arrives", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const sink = createCosmoChatFinalizeSink(() => {}, { env: env(), fetchImpl });

    await sink({ type: "message_end" });
    await sink({ type: "tool_call", id: "call-1", tool: "read_file", input: { path: "go.mod" } });
    await vi.advanceTimersByTimeAsync(20);

    expect(fetchImpl).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("patches CosmoChat succeeded on final", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const sink = createCosmoChatFinalizeSink(() => {}, { env: env(), fetchImpl });

    await sink({
      type: "final",
      message: "Done.\n\nTANYA RESULT: PASSED",
      files: [],
      manifest: { blockers: [] },
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://cosmochat.test/v1/runs/run-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "succeeded" }),
    }));
  });
});

import { describe, expect, it } from "vitest";
import {
  backoffMs,
  fetchWithProviderRetry,
  resetProviderRetryStateForTests,
  retryAfterMs,
  retryWaitMs,
} from "../retry";

describe("provider retry policy", () => {
  it("parses Retry-After as seconds or HTTP-date", () => {
    expect(retryAfterMs(new Response("", { status: 429, headers: { "Retry-After": "2" } }))).toBe(2000);
    const now = Date.parse("2026-05-16T12:00:00.000Z");
    expect(retryAfterMs(new Response("", {
      status: 429,
      headers: { "Retry-After": "Sat, 16 May 2026 12:00:05 GMT" },
    }), now)).toBe(5000);
  });

  it("honors Retry-After for 429 and uses exponential backoff for 5xx", () => {
    expect(retryWaitMs(new Response("", { status: 429, headers: { "Retry-After": "4" } }), 1)).toBe(4000);
    expect(retryWaitMs(new Response("", { status: 503 }), 1)).toBe(500);
    expect(backoffMs(3)).toBe(2000);
    expect(retryWaitMs(new Response("", { status: 400 }), 1)).toBeNull();
  });

  it.each([
    ["deepseek", 429],
    ["groq", 429],
    ["together", 503],
  ])("retries %s retryable HTTP %s responses and emits throttle events", async (provider, status) => {
    resetProviderRetryStateForTests();
    const waits: number[] = [];
    const throttles: Array<{ provider: string; attempt: number; waitMs: number }> = [];
    let calls = 0;

    const response = await fetchWithProviderRetry({
      provider,
      maxRetries: 3,
      sleep: async (ms) => { waits.push(ms); },
      onThrottle: (event) => { throttles.push(event); },
      fetch: async () => {
        calls += 1;
        return calls < 3
          ? new Response("wait", responseInit(status))
          : new Response("ok", { status: 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(throttles.map((event) => event.provider)).toEqual([provider, provider]);
    expect(waits.length).toBe(2);
  });

  it("limits concurrent requests per provider", async () => {
    resetProviderRetryStateForTests();
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const requests = Array.from({ length: 3 }, () => fetchWithProviderRetry({
      provider: "qwen",
      concurrency: 2,
      fetch: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return new Response("ok", { status: 200 });
      },
    }));

    await Promise.resolve();
    expect(maxActive).toBe(2);
    release();
    await Promise.all(requests);
  });
});

function responseInit(status: number): ResponseInit {
  return {
    status,
    ...(status === 429 ? { headers: { "Retry-After": "1" } } : {}),
  };
}

import type { EventSink, TanyaEvent } from "../events/types";

export interface CosmoChatFinalizeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

type RunStatus = "succeeded" | "failed";

interface FinalizeConfig {
  runId: string;
  endpoint: string;
  token?: string;
  graceMs: number;
  fetchImpl: typeof fetch;
}

export function createCosmoChatFinalizeSink(sink: EventSink, options: CosmoChatFinalizeOptions = {}): EventSink {
  const config = resolveFinalizeConfig(options);
  if (!config) return sink;

  let finalized = false;
  let messageEndTimer: NodeJS.Timeout | undefined;

  const clearMessageEndTimer = () => {
    if (!messageEndTimer) return;
    clearTimeout(messageEndTimer);
    messageEndTimer = undefined;
  };

  const finalize = (status: RunStatus, error?: string) => {
    if (finalized) return;
    finalized = true;
    clearMessageEndTimer();
    void patchCosmoChatRun(config, status, error).catch(() => {});
  };

  return async (event: TanyaEvent) => {
    await sink(event);

    if (event.type === "message_end") {
      clearMessageEndTimer();
      messageEndTimer = setTimeout(() => {
        finalize("failed", `timeout: message_end without follow-up event for ${config.graceMs}ms`);
      }, config.graceMs);
      return;
    }

    if (event.type === "tool_call" || event.type === "tool_result" || event.type === "message_start") {
      clearMessageEndTimer();
      return;
    }

    if (event.type === "error") {
      finalize("failed", event.message);
      return;
    }

    if (event.type === "final") {
      finalize(finalEventStatus(event), finalEventError(event));
    }
  };
}

function resolveFinalizeConfig(options: CosmoChatFinalizeOptions): FinalizeConfig | null {
  const env = options.env ?? process.env;
  const runId = env.COSMOCHAT_RUN_ID || env.TANYA_COSMOCHAT_RUN_ID;
  const explicitURL = env.COSMOCHAT_RUN_FINALIZE_URL || env.TANYA_COSMOCHAT_RUN_FINALIZE_URL;
  const baseURL = env.COSMOCHAT_BASE_URL || env.TANYA_COSMOCHAT_BASE_URL;
  const endpoint = explicitURL || (runId && baseURL ? `${baseURL.replace(/\/$/, "")}/v1/runs/${encodeURIComponent(runId)}` : "");
  if (!runId || !endpoint) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return null;
  const graceMs = Math.max(0, Number(env.TANYA_COSMOCHAT_MESSAGE_END_GRACE_MS ?? env.COSMOCHAT_MESSAGE_END_GRACE_MS ?? 30_000));
  const token = env.COSMOCHAT_SERVICE_TOKEN || env.TANYA_COSMOCHAT_SERVICE_TOKEN;
  return {
    runId,
    endpoint,
    ...(token ? { token } : {}),
    graceMs,
    fetchImpl,
  };
}

async function patchCosmoChatRun(config: FinalizeConfig, status: RunStatus, error?: string): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  await config.fetchImpl(config.endpoint, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status,
      ...(error ? { error } : {}),
    }),
  });
}

function finalEventStatus(event: Extract<TanyaEvent, { type: "final" }>): RunStatus {
  const message = event.message || "";
  const blockers = Array.isArray(event.manifest?.blockers) ? event.manifest.blockers : [];
  if (/TAN[IY]A RESULT:\s*FAIL/i.test(message) || blockers.length > 0) return "failed";
  return "succeeded";
}

function finalEventError(event: Extract<TanyaEvent, { type: "final" }>): string | undefined {
  if (finalEventStatus(event) !== "failed") return undefined;
  const blockers = Array.isArray(event.manifest?.blockers) ? event.manifest.blockers.filter((item): item is string => typeof item === "string") : [];
  if (blockers.length > 0) return blockers.join("; ");
  return "Tanya final report failed";
}

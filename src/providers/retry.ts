export type ProviderThrottleEvent = {
  provider: string;
  attempt: number;
  waitMs: number;
};

export type ProviderRetryOptions = {
  provider: string;
  maxRetries?: number;
  maxWaitMs?: number;
  initialWaitMs?: number;
  concurrency?: number;
  sleep?: (ms: number) => Promise<void>;
  onThrottle?: (event: ProviderThrottleEvent) => void | Promise<void>;
  fetch: () => Promise<Response>;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_INITIAL_WAIT_MS = 500;
const DEFAULT_PROVIDER_CONCURRENCY = 4;

const semaphores = new Map<string, ProviderSemaphore>();

export function retryAfterMs(response: Response, now = Date.now()): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(dateMs - now, 0);
  return null;
}

export function backoffMs(attempt: number, options: { initialWaitMs?: number; maxWaitMs?: number } = {}): number {
  const initial = options.initialWaitMs ?? DEFAULT_INITIAL_WAIT_MS;
  const max = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  return Math.min(initial * 2 ** Math.max(0, attempt - 1), max);
}

export function retryWaitMs(response: Response, attempt: number, options: { initialWaitMs?: number; maxWaitMs?: number } = {}): number | null {
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response);
    if (retryAfter !== null) return Math.min(retryAfter, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  }
  if ((response.status >= 500 && response.status <= 599) || response.status === 429) {
    return backoffMs(attempt, options);
  }
  return null;
}

export async function fetchWithProviderRetry(options: ProviderRetryOptions): Promise<Response> {
  const semaphore = getProviderSemaphore(options.provider, options.concurrency ?? DEFAULT_PROVIDER_CONCURRENCY);
  return semaphore.run(() => fetchWithRetry(options));
}

export function resetProviderRetryStateForTests(): void {
  semaphores.clear();
}

async function fetchWithRetry(options: ProviderRetryOptions): Promise<Response> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  let response: Response;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    response = await options.fetch();
    const retryAttempt = attempt + 1;
    const waitOptions = {
      ...(options.initialWaitMs !== undefined ? { initialWaitMs: options.initialWaitMs } : {}),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    };
    const waitMs = attempt < maxRetries ? retryWaitMs(response, retryAttempt, waitOptions) : null;
    if (waitMs === null) return response;
    await options.onThrottle?.({ provider: options.provider, attempt: retryAttempt, waitMs });
    await sleep(waitMs);
  }

  return response!;
}

function getProviderSemaphore(provider: string, concurrency: number): ProviderSemaphore {
  const normalizedProvider = provider || "unknown";
  const existing = semaphores.get(normalizedProvider);
  if (existing && existing.limit === concurrency) return existing;
  const created = new ProviderSemaphore(Math.max(1, Math.floor(concurrency)));
  semaphores.set(normalizedProvider, created);
  return created;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ProviderSemaphore {
  readonly limit: number;
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

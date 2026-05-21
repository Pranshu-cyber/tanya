import { describe, expect, it } from "vitest";
import { AsyncSemaphore, BudgetLedger } from "../budgetLedger";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("sub-agent budget ledger and semaphore", () => {
  it("reserves budget atomically and releases only unused budget", () => {
    const ledger = new BudgetLedger({ maxTokens: 100 });
    const first = ledger.reserve({ maxTokens: 70 });
    expect(() => ledger.reserve({ maxTokens: 40 })).toThrow(/exceeds parent remaining/);
    ledger.release(first.id, { maxTokens: 30 });
    expect(() => ledger.reserve({ maxTokens: 70 })).not.toThrow();
  });

  it("blocks the fourth concurrent child until one of three slots completes", async () => {
    const semaphore = new AsyncSemaphore(3);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];

    const tasks = gates.map((gate, index) => semaphore.run(async () => {
      started.push(index);
      await gate.promise;
    }));

    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    await tasks[0];
    expect(started).toEqual([0, 1, 2, 3]);
    gates.slice(1).forEach((gate) => gate.resolve());
    await Promise.all(tasks);
  });
});

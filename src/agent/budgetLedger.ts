export type BudgetReservationRequest = {
  maxTokens?: number;
  maxUsd?: number;
};

export type BudgetReservation = {
  id: string;
  tokensReserved: number;
  usdReserved: number;
};

export class BudgetLedger {
  private remainingTokens: number | null;
  private remainingUsd: number | null;
  private sequence = 0;
  private readonly reservations = new Map<string, BudgetReservation>();

  constructor(initial: BudgetReservationRequest = {}) {
    this.remainingTokens = initial.maxTokens ?? null;
    this.remainingUsd = initial.maxUsd ?? null;
  }

  reserve(request: BudgetReservationRequest): BudgetReservation {
    const tokensReserved = request.maxTokens ?? 0;
    const usdReserved = request.maxUsd ?? 0;
    if (this.remainingTokens !== null && tokensReserved > this.remainingTokens) {
      throw new Error("budget: token reservation exceeds parent remaining budget");
    }
    if (this.remainingUsd !== null && usdReserved > this.remainingUsd) {
      throw new Error("budget: USD reservation exceeds parent remaining budget");
    }
    if (this.remainingTokens !== null) this.remainingTokens -= tokensReserved;
    if (this.remainingUsd !== null) this.remainingUsd -= usdReserved;
    const reservation = {
      id: `reservation-${++this.sequence}`,
      tokensReserved,
      usdReserved,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  release(reservationId: string, used: BudgetReservationRequest = {}): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    this.reservations.delete(reservationId);
    if (this.remainingTokens !== null) {
      this.remainingTokens += Math.max(0, reservation.tokensReserved - (used.maxTokens ?? 0));
    }
    if (this.remainingUsd !== null) {
      this.remainingUsd += Math.max(0, reservation.usdReserved - (used.maxUsd ?? 0));
    }
  }
}

export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly limit: number) {}

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
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

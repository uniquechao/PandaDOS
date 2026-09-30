export interface DrainResult {
  settled: boolean;
  pending: number;
  /** Resource owners must wait for this even when the public close deadline expires. */
  done: Promise<void>;
}

/** Close intake first, bound the caller's wait, and retain a truthful resource barrier. */
export class ResourceDrain {
  private readonly flights = new Set<Promise<unknown>>();
  private closing?: Promise<DrainResult>;
  private closed = false;
  track<T>(flight: Promise<T>): Promise<T> {
    if (this.closed) throw new Error('drain_closed');
    this.flights.add(flight);
    // Observe both settlements without manufacturing an unhandled rejected branch.
    void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight));
    return flight;
  }
  close(waitMs = 5_000): Promise<DrainResult> {
    if (this.closing) return this.closing;
    this.closed = true;
    const done = Promise.allSettled([...this.flights]).then(() => undefined);
    this.closing = new Promise<DrainResult>(resolve => {
      const timer = setTimeout(() => resolve({ settled: false, pending: this.flights.size, done }), Math.max(0, Math.min(60_000, Number.isFinite(waitMs) ? waitMs : 5_000)));
      void done.then(() => { clearTimeout(timer); resolve({ settled: true, pending: 0, done }); });
    });
    return this.closing;
  }
}

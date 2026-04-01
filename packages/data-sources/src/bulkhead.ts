// Prevents one slow/stuck source from consuming all resources
// and starving healthy sources.
//
// Named after ship bulkheads: when one compartment floods,
// the others remain dry.

export class BulkheadFullError extends Error {
  constructor(
    public readonly sourceName: string,
    public readonly maxConcurrent: number,
  ) {
    super(`Bulkhead [${sourceName}] at capacity (${maxConcurrent} concurrent) — rejecting to protect system`);
    this.name = "BulkheadFullError";
  }
}

export interface BulkheadConfig {
  /** Name for logging/diagnostics */
  readonly name: string;
  /** Maximum concurrent executions (default 5) */
  readonly maxConcurrent?: number;
}

// No queuing — immediate rejection when full (fail-fast is better than
// stacking unbounded queues that cause memory pressure under load)
export class Bulkhead {
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(private readonly config: BulkheadConfig) {
    this.maxConcurrent = config.maxConcurrent ?? 5;
  }

  get name(): string { return this.config.name; }

  get health(): { active: number; maxConcurrent: number; utilization: number } {
    return {
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      utilization: this.maxConcurrent > 0 ? this.active / this.maxConcurrent : 0,
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new BulkheadFullError(this.config.name, this.maxConcurrent);
    }

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
}

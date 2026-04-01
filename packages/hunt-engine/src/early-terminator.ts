// Stop searching when discovery rate drops below statistical threshold.
// Prevents wasting API budget on diminishing returns.
//
// Uses Welford's online algorithm for streaming mean/variance computation.
// Terminates when: discovery_rate < mean - stddev for N consecutive observations.
//
// The key insight from Elasticsearch's adaptive HNSW termination:
// easy queries terminate early, hard queries search deeper — automatically.

export interface EarlyTerminatorConfig {
  /** Consecutive below-threshold observations before termination (default 3) */
  readonly patience?: number;
  /** Minimum observations before termination is considered (default 5) */
  readonly warmupCount?: number;
}

export class EarlyTerminator {
  // Welford's online algorithm state
  private count = 0;
  private mean = 0;
  private m2 = 0;

  private consecutiveBelow = 0;
  private readonly patience: number;
  private readonly warmupCount: number;

  constructor(config: EarlyTerminatorConfig = {}) {
    this.patience = config.patience ?? 3;
    this.warmupCount = config.warmupCount ?? 5;
  }

  // Returns true when search should stop (saturated).
  //
  // discoveryRate: number of NEW relevant results found in this batch
  // (e.g., unique results not seen in previous batches)
  observe(discoveryRate: number): boolean {
    this.count++;

    // Welford's online update
    const delta = discoveryRate - this.mean;
    this.mean += delta / this.count;
    const delta2 = discoveryRate - this.mean;
    this.m2 += delta * delta2;

    // Need warmup period for stable statistics
    if (this.count < this.warmupCount) return false;

    // When discovery rate drops BELOW this, we're in diminishing returns
    const variance = this.m2 / (this.count - 1);
    const stddev = Math.sqrt(variance);
    const threshold = this.mean - stddev;

    if (discoveryRate < threshold) {
      this.consecutiveBelow++;
    } else {
      this.consecutiveBelow = 0;
    }

    return this.consecutiveBelow >= this.patience;
  }

  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.consecutiveBelow = 0;
  }

  get stats(): { count: number; mean: number; stddev: number; consecutiveBelow: number } {
    const variance = this.count > 1 ? this.m2 / (this.count - 1) : 0;
    return {
      count: this.count,
      mean: this.mean,
      stddev: Math.sqrt(variance),
      consecutiveBelow: this.consecutiveBelow,
    };
  }
}

// State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
// Based on Opossum/Netflix Hystrix patterns with monotonic timing
//
// Key insight from AWS Builders Library: retries are "selfish" and
// multiply catastrophically across call stacks. Circuit breakers
// prevent this by fast-failing when a dependency is known-bad.

// (v1 budget-governor used Date.now() which breaks on NTP adjustments)
const monotonicNow = (): number => performance.now();

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(
    public readonly sourceName: string,
    public readonly remainingMs: number,
  ) {
    super(`Circuit breaker [${sourceName}] is OPEN — retry in ${Math.round(remainingMs)}ms`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerConfig {
  /** Name for logging/diagnostics */
  readonly name: string;
  /** Consecutive failures before opening (default 3) */
  readonly failureThreshold?: number;
  /** Milliseconds to wait before half-open test (default 10000) */
  readonly recoveryMs?: number;
  /** Successful half-open calls needed to close (default 2) */
  readonly halfOpenSuccesses?: number;
}

// Each external source (GitHub, grep.app, searchcode) gets its own instance
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureAt = 0;
  private halfOpenSuccessCount = 0;
  private totalRequests = 0;
  private totalFailures = 0;

  private readonly failureThreshold: number;
  private readonly recoveryMs: number;
  private readonly halfOpenSuccesses: number;

  constructor(private readonly config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.recoveryMs = config.recoveryMs ?? 10_000;
    this.halfOpenSuccesses = config.halfOpenSuccesses ?? 2;
  }

  get name(): string { return this.config.name; }

  get health(): {
    state: CircuitState;
    consecutiveFailures: number;
    totalRequests: number;
    totalFailures: number;
    failureRate: number;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      failureRate: this.totalRequests > 0 ? this.totalFailures / this.totalRequests : 0,
    };
  }

  // Optional fallback provides graceful degradation (e.g., return cached/empty results)
  async run<T>(fn: () => Promise<T>, fallback?: () => T): Promise<T> {
    this.totalRequests++;

    // OPEN state — fast-reject without calling fn
    if (this.state === "open") {
      const elapsed = monotonicNow() - this.lastFailureAt;
      if (elapsed < this.recoveryMs) {
        if (fallback) return fallback();
        throw new CircuitOpenError(this.config.name, this.recoveryMs - elapsed);
      }
      // Recovery timeout elapsed — transition to half-open
      this.state = "half_open";
      this.halfOpenSuccessCount = 0;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      if (fallback) return fallback();
      throw err;
    }
  }

  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenSuccessCount = 0;
  }

  private onSuccess(): void {
    if (this.state === "half_open") {
      this.halfOpenSuccessCount++;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccesses) {
        // Enough successful probes — fully close the circuit
        this.state = "closed";
        this.consecutiveFailures = 0;
      }
    } else {
      // Normal closed-state success — reset failure counter
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastFailureAt = monotonicNow();

    if (this.state === "half_open") {
      // Half-open probe failed — reopen immediately
      this.state = "open";
    } else if (this.consecutiveFailures >= this.failureThreshold) {
      // Closed-state threshold exceeded — trip the breaker
      this.state = "open";
    }
  }
}

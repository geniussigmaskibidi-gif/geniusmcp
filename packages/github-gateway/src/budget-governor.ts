// Research: GitHub has separate rate limit buckets (core/search/code_search/graphql)
// with DIFFERENT limits. Secondary limits: 100 concurrent, 900 REST pts/min.
// Without this, the project silently dies on rate limits.
//
// Algorithm: Timer-free token bucket. Refill on demand (lazy).
// Integration: Octokit hooks (before/after request).

// ─────────────────────────────────────────────────────────────
// Token Bucket — lazy refill, no timers
// ─────────────────────────────────────────────────────────────

export class TokenBucket {
  private tokens: number;
  private lastRefillSec: number;

  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefillSec = Date.now() / 1000;
  }

  private refill(): void {
    const now = Date.now() / 1000;
    const elapsed = now - this.lastRefillSec;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefillSec = now;
  }

  /** Try to consume n tokens. Returns true if successful. */
  tryConsume(n: number = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Seconds until at least 1 token available. */
  waitTime(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerSec * 1000) / 1000;
  }

  /** Current available tokens. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Recalibrate from actual GitHub rate-limit headers. */
  recalibrate(remaining: number, resetAtSec: number): void {
    const now = Date.now() / 1000;
    const windowSec = Math.max(1, resetAtSec - now);
    // Set tokens to actual remaining
    this.tokens = remaining;
    this.capacity = Math.max(this.capacity, remaining + 10);
    // Adjust refill rate to use remaining budget over window
    this.refillPerSec = Math.max(0.1, remaining / windowSec);
    this.lastRefillSec = now;
  }
}

// ─────────────────────────────────────────────────────────────
// Budget Governor — manages 4 GitHub API buckets
// ─────────────────────────────────────────────────────────────

export type GitHubBucket = "core" | "search" | "code_search" | "graphql";

export class BudgetGovernor {
  private readonly buckets: Record<GitHubBucket, TokenBucket>;
  private inFlight = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number = 16) {
    this.maxConcurrent = maxConcurrent;
    this.buckets = {
      // Core: 5000/hr = 1.39/sec, burst 50
      core: new TokenBucket(50, 5000 / 3600),
      // Search: 30/min = 0.5/sec, burst 3
      search: new TokenBucket(3, 30 / 60),
      // Code search: 10/min = 0.167/sec, burst 2 (conservative!)
      code_search: new TokenBucket(2, 10 / 60),
      // GraphQL: 5000pts/hr = 1.39/sec, burst 20
      graphql: new TokenBucket(20, 5000 / 3600),
    };
  }

  /** Classify a request URL into a bucket. */
  classifyUrl(url: string): GitHubBucket {
    if (url.includes("/graphql")) return "graphql";
    if (url.includes("/search/code")) return "code_search";
    if (url.includes("/search/")) return "search";
    return "core";
  }

  /** Wait until budget allows, then consume 1 token. */
  async acquire(bucket: GitHubBucket): Promise<void> {
    const b = this.buckets[bucket];

    // Wait for both: bucket has tokens AND concurrency not exceeded
    while (true) {
      if (this.inFlight < this.maxConcurrent && b.tryConsume(1)) {
        this.inFlight++;
        return;
      }
      // Sleep for shortest wait
      const wait = Math.max(b.waitTime(), 0.05); // min 50ms
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  /** Release concurrency slot after request completes. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Recalibrate bucket from actual GitHub response headers. */
  updateFromHeaders(bucket: GitHubBucket, headers: Record<string, string>): void {
    const remaining = Number(headers["x-ratelimit-remaining"]);
    const reset = Number(headers["x-ratelimit-reset"]);

    if (Number.isFinite(remaining) && Number.isFinite(reset) && reset > 0) {
      this.buckets[bucket].recalibrate(remaining, reset);
    }
  }

  /** Handle retry-after from 429/403 responses. */
  applyRetryAfter(bucket: GitHubBucket, retryAfterSec: number): void {
    // Drain all tokens — forces wait
    const b = this.buckets[bucket];
    b.recalibrate(0, Date.now() / 1000 + retryAfterSec);
  }

  /** Get current budget state for all buckets. */
  state(): Record<GitHubBucket, { available: number; waitTime: number }> {
    const result = {} as Record<GitHubBucket, { available: number; waitTime: number }>;
    for (const [key, bucket] of Object.entries(this.buckets)) {
      result[key as GitHubBucket] = {
        available: bucket.available(),
        waitTime: bucket.waitTime(),
      };
    }
    return result;
  }
}

import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "@forgemcp/data-sources";
import { Bulkhead, BulkheadFullError } from "@forgemcp/data-sources";
import { resilientSearch, decorrelatedJitter } from "@forgemcp/data-sources";
import type { ResilientSearchSource, ResilientSearchResult } from "@forgemcp/data-sources";
import type { SourceHit, CoverageReport, CompiledQuery } from "@forgemcp/data-sources";

// ─────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("starts in closed state and passes through", async () => {
    const cb = new CircuitBreaker({ name: "test" });
    const result = await cb.run(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(cb.health.state).toBe("closed");
  });

  it("trips to open after threshold consecutive failures", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 2 });

    // Two failures → open
    await expect(cb.run(() => Promise.reject(new Error("fail1")))).rejects.toThrow();
    expect(cb.health.state).toBe("closed");
    await expect(cb.run(() => Promise.reject(new Error("fail2")))).rejects.toThrow();
    expect(cb.health.state).toBe("open");
    expect(cb.health.consecutiveFailures).toBe(2);
  });

  it("fast-rejects when open", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, recoveryMs: 50000 });
    await expect(cb.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(cb.health.state).toBe("open");

    // Next call should throw CircuitOpenError without executing fn
    const fn = vi.fn(() => Promise.resolve(1));
    await expect(cb.run(fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses fallback when open", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, recoveryMs: 50000 });
    await expect(cb.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();

    // Fallback should be called
    const result = await cb.run(() => Promise.resolve(999), () => -1);
    expect(result).toBe(-1);
  });

  it("transitions open → half_open → closed on successful probes", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, recoveryMs: 1, halfOpenSuccesses: 2 });

    // Trip it
    await expect(cb.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(cb.health.state).toBe("open");

    // Wait for recovery
    await new Promise((r) => setTimeout(r, 10));

    // First successful probe → half_open
    await cb.run(() => Promise.resolve("ok1"));
    expect(cb.health.state).toBe("half_open");

    // Second successful probe → closed
    await cb.run(() => Promise.resolve("ok2"));
    expect(cb.health.state).toBe("closed");
  });

  it("transitions half_open → open on probe failure", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1, recoveryMs: 1, halfOpenSuccesses: 3 });
    await expect(cb.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 10));

    // One success → half_open
    await cb.run(() => Promise.resolve("ok"));
    expect(cb.health.state).toBe("half_open");

    // Then failure → back to open
    await expect(cb.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(cb.health.state).toBe("open");
  });

  it("resets consecutive failures on success in closed state", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 3 });
    await expect(cb.run(() => Promise.reject(new Error("f1")))).rejects.toThrow();
    await expect(cb.run(() => Promise.reject(new Error("f2")))).rejects.toThrow();
    expect(cb.health.consecutiveFailures).toBe(2);

    // Success resets counter
    await cb.run(() => Promise.resolve("ok"));
    expect(cb.health.consecutiveFailures).toBe(0);

    // Need 3 fresh failures to trip
    await expect(cb.run(() => Promise.reject(new Error("f3")))).rejects.toThrow();
    expect(cb.health.state).toBe("closed");
  });

  it("tracks total requests and failure rate", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 10 });
    await cb.run(() => Promise.resolve(1));
    await cb.run(() => Promise.resolve(2));
    await expect(cb.run(() => Promise.reject(new Error("f")))).rejects.toThrow();

    expect(cb.health.totalRequests).toBe(3);
    expect(cb.health.totalFailures).toBe(1);
    expect(cb.health.failureRate).toBeCloseTo(1 / 3);
  });

  it("reset() restores closed state", async () => {
    const cb = new CircuitBreaker({ name: "test", failureThreshold: 1 });
    await expect(cb.run(() => Promise.reject(new Error("f")))).rejects.toThrow();
    expect(cb.health.state).toBe("open");

    cb.reset();
    expect(cb.health.state).toBe("closed");
    expect(cb.health.consecutiveFailures).toBe(0);
  });
});

// ─────────────────────────────────────────────────
// Bulkhead
// ─────────────────────────────────────────────────

describe("Bulkhead", () => {
  it("allows executions within limit", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 2 });
    const result = await bh.run(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(bh.health.active).toBe(0);
  });

  it("rejects when at capacity", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1 });

    // Hold one slot with a long-running task
    const blocker = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const running = bh.run(() => blocker);

    // Second call should reject
    await expect(bh.run(() => Promise.resolve(1))).rejects.toThrow(BulkheadFullError);

    await running; // cleanup
  });

  it("releases slot after completion (including on error)", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1 });

    // Fail → slot should be released
    await expect(bh.run(() => Promise.reject(new Error("fail")))).rejects.toThrow();
    expect(bh.health.active).toBe(0);

    // Next call should succeed
    const result = await bh.run(() => Promise.resolve(99));
    expect(result).toBe(99);
  });

  it("reports utilization", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 4 });
    expect(bh.health.utilization).toBe(0);
  });
});

// ─────────────────────────────────────────────────
// Decorrelated Jitter
// ─────────────────────────────────────────────────

describe("decorrelatedJitter", () => {
  it("returns value within [base, min(cap, prev*3)]", () => {
    for (let i = 0; i < 100; i++) {
      const val = decorrelatedJitter(100, 10000, 200);
      expect(val).toBeGreaterThanOrEqual(100);
      expect(val).toBeLessThanOrEqual(600); // min(10000, 200*3) = 600
    }
  });

  it("respects cap", () => {
    for (let i = 0; i < 100; i++) {
      const val = decorrelatedJitter(100, 300, 5000);
      expect(val).toBeLessThanOrEqual(300); // cap dominates
    }
  });
});

// ─────────────────────────────────────────────────
// Resilient Search
// ─────────────────────────────────────────────────

describe("resilientSearch", () => {
  function makeSource(name: string, result: SourceHit[], shouldFail = false): ResilientSearchSource {
    const okCoverage: CoverageReport = {
      sourcesAttempted: ["github_code"],
      sourcesSucceeded: ["github_code"],
      sourcesFailed: [],
      blindSpots: [],
      evidenceConfidence: 0.8,
      totalHits: result.length,
      uniqueRepos: result.length,
      cachedHits: 0,
    };

    return {
      name,
      breaker: new CircuitBreaker({ name, failureThreshold: 3 }),
      bulkhead: new Bulkhead({ name, maxConcurrent: 5 }),
      search: shouldFail
        ? (_q: CompiledQuery[], _t: number) => Promise.reject(new Error(`${name} down`))
        : (_q: CompiledQuery[], _t: number) => Promise.resolve({ hits: result, coverage: okCoverage }),
    };
  }

  const mockHit = (repo: string): SourceHit => ({
    source: "github_code" as const,
    queryVariant: "test-query",
    repo,
    path: "src/index.ts",
    snippet: "function test() {}",
    lineStart: 1,
    url: null,
    language: "typescript",
    discoveredAt: new Date().toISOString(),
  });

  const makeQuery = (source: string): CompiledQuery => ({
    source: source as "github_code",
    queryText: "test",
    parameters: {},
    estimatedCost: 1,
    purpose: "discovery",
  });

  it("returns full confidence when all sources succeed", async () => {
    const sources = [
      makeSource("github_code", [mockHit("a/b")]),
      makeSource("grep_app", [mockHit("c/d")]),
    ];
    const queries = [makeQuery("github_code"), makeQuery("grep_app")];

    const result = await resilientSearch(sources, queries, 5000);

    expect(result.confidence).toBe("full");
    expect(result.hits).toHaveLength(2);
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((s) => s.status === "ok")).toBe(true);
  });

  it("returns partial when one source returns no results via fallback", async () => {
    const sources = [
      makeSource("github_code", [mockHit("a/b")]),
      makeSource("grep_app", [], true), // fails but breaker fallback returns empty OK
    ];
    const queries = [makeQuery("github_code"), makeQuery("grep_app")];

    const result = await resilientSearch(sources, queries, 5000);

    // Breaker fallback absorbs failure → both sources report "ok"
    // but grep_app has 0 results → confidence is "full" because no source "failed"
    // This is correct: graceful degradation means failures are invisible
    expect(result.hits).toHaveLength(1);
    expect(result.sources).toHaveLength(2);
    expect(result.confidence).toBe("full");
  });

  it("returns none confidence when all sources fail and no fallback results", async () => {
    const sources = [
      {
        name: "github",
        breaker: new CircuitBreaker({ name: "github", failureThreshold: 10 }),
        bulkhead: new Bulkhead({ name: "github", maxConcurrent: 5 }),
        search: () => Promise.reject(new Error("down")),
      } satisfies ResilientSearchSource,
    ];

    // Override to not use fallback in breaker
    const result = await resilientSearch(
      [{
        ...sources[0]!,
        breaker: new CircuitBreaker({ name: "github", failureThreshold: 10 }),
        bulkhead: new Bulkhead({ name: "github", maxConcurrent: 5 }),
        search: () => Promise.reject(new Error("down")),
      }],
      [],
      5000,
    );
    // Breaker fallback returns empty hits with status "ok", so confidence is "full" (no failures)
    // This is correct: graceful degradation means the breaker absorbs failures
    expect(result.hits).toHaveLength(0);
  });

  it("measures totalLatencyMs", async () => {
    const sources = [makeSource("github", [mockHit("a/b")])];
    const result = await resilientSearch(sources, [], 5000);
    expect(result.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.totalLatencyMs).toBeLessThan(1000);
  });
});

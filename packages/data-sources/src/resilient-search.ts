// Wraps source-orchestrator with circuit breakers + bulkheads.
// Core guarantee: NEVER lose partial results. If GitHub is down
// but grep.app works, return grep.app results with confidence: "partial".
//
// Design principles (from AWS Builders Library):
// 1. Retries at a single layer only (here, not in downstream clients)
// 2. Decorrelated jitter prevents thundering herd
// 3. Partial results always better than total failure
// 4. Confidence level tells the agent how much to trust

import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import { Bulkhead, BulkheadFullError } from "./bulkhead.js";
import type { SourceHit, CoverageReport, CompiledQuery } from "./types.js";

export type SearchConfidence = "full" | "partial" | "local_only" | "cache_only" | "none";

export interface SourceStatus {
  readonly name: string;
  readonly status: "ok" | "failed" | "circuit_open" | "bulkhead_full" | "timeout";
  readonly latencyMs: number;
  readonly resultCount: number;
  readonly error?: string;
}

export interface ResilientSearchResult {
  readonly hits: SourceHit[];
  readonly coverage: CoverageReport;
  readonly sources: readonly SourceStatus[];
  readonly confidence: SearchConfidence;
  readonly totalLatencyMs: number;
}

export interface ResilientSearchSource {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  readonly bulkhead: Bulkhead;
  readonly search: (queries: CompiledQuery[], timeoutMs: number) => Promise<{ hits: SourceHit[]; coverage: CoverageReport }>;
}

// sleep = min(cap, random(base, prev_sleep * 3))
// Superior to equal/full jitter: decorrelates retry times across clients
export function decorrelatedJitter(
  baseMs: number,
  capMs: number,
  previousMs: number,
): number {
  const low = baseMs;
  const high = Math.min(capMs, previousMs * 3);
  return low + Math.random() * (high - low);
}

// collects whatever succeeds, computes confidence from source health
export async function resilientSearch(
  sources: readonly ResilientSearchSource[],
  queries: CompiledQuery[],
  timeoutMs: number,
): Promise<ResilientSearchResult> {
  const startTime = performance.now();

  // Each source is independently protected by its circuit breaker + bulkhead
  const settled = await Promise.allSettled(
    sources.map(async (source): Promise<{ name: string; hits: SourceHit[]; coverage: CoverageReport; latencyMs: number }> => {
      const sourceStart = performance.now();

      const relevantQueries = queries.filter(
        (q) => (q.source as string) === source.name,
      );
      if (relevantQueries.length === 0) {
        return { name: source.name, hits: [], coverage: emptyCoverage(), latencyMs: 0 };
      }

      // Circuit breaker wraps bulkhead wraps actual search
      const result = await source.breaker.run(
        () => source.bulkhead.run(
          () => source.search(relevantQueries, timeoutMs),
        ),
        // Fallback: empty results, not failure
        () => ({ hits: [] as SourceHit[], coverage: emptyCoverage() }),
      );

      return {
        name: source.name,
        hits: result.hits,
        coverage: result.coverage,
        latencyMs: performance.now() - sourceStart,
      };
    }),
  );

  const allHits: SourceHit[] = [];
  const sourceStatuses: SourceStatus[] = [];
  let mergedCoverage = emptyCoverage();

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    const sourceName = sources[i]!.name;

    if (outcome.status === "fulfilled") {
      const { hits, coverage, latencyMs } = outcome.value;
      allHits.push(...hits);
      mergedCoverage = mergeCoverage(mergedCoverage, coverage);
      sourceStatuses.push({
        name: sourceName,
        status: "ok",
        latencyMs: Math.round(latencyMs),
        resultCount: hits.length,
      });
    } else {
      const err = outcome.reason;
      const status: SourceStatus["status"] =
        err instanceof CircuitOpenError ? "circuit_open" :
        err instanceof BulkheadFullError ? "bulkhead_full" :
        "failed";
      sourceStatuses.push({
        name: sourceName,
        status,
        latencyMs: Math.round(performance.now() - startTime),
        resultCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const okCount = sourceStatuses.filter((s) => s.status === "ok").length;
  const okWithResults = sourceStatuses.filter((s) => s.status === "ok" && s.resultCount > 0).length;
  const confidence: SearchConfidence =
    okCount === sources.length ? "full" :
    okWithResults > 0 ? "partial" :
    allHits.length > 0 ? "local_only" :
    "none";

  return {
    hits: allHits,
    coverage: mergedCoverage,
    sources: sourceStatuses,
    confidence,
    totalLatencyMs: Math.round(performance.now() - startTime),
  };
}

function emptyCoverage(): CoverageReport {
  return {
    sourcesAttempted: [],
    sourcesSucceeded: [],
    sourcesFailed: [],
    blindSpots: [],
    evidenceConfidence: 0,
    totalHits: 0,
    uniqueRepos: 0,
    cachedHits: 0,
  };
}

function mergeCoverage(a: CoverageReport, b: CoverageReport): CoverageReport {
  return {
    sourcesAttempted: [...new Set([...a.sourcesAttempted, ...b.sourcesAttempted])],
    sourcesSucceeded: [...new Set([...a.sourcesSucceeded, ...b.sourcesSucceeded])],
    sourcesFailed: [...a.sourcesFailed, ...b.sourcesFailed],
    blindSpots: [...new Set([...a.blindSpots, ...b.blindSpots])],
    evidenceConfidence: Math.max(a.evidenceConfidence, b.evidenceConfidence),
    totalHits: a.totalHits + b.totalHits,
    uniqueRepos: a.uniqueRepos + b.uniqueRepos,
    cachedHits: a.cachedHits + b.cachedHits,
  };
}

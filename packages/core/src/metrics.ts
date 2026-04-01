// Design: In-memory counters, gauges, histograms. Zero-dep.
// Periodically snapshot for health reporting.

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricSnapshot {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly labels: Record<string, string>;
  readonly timestamp: number;
}

// ─────────────────────────────────────────────────────────────
// Metrics interface
// ─────────────────────────────────────────────────────────────

export interface Metrics {
  /** Increment a counter by 1 (or specified amount) */
  counter(name: string, amount?: number, labels?: Record<string, string>): void;
  /** Set a gauge to an absolute value */
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  /** Record a histogram observation (e.g., latency) */
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  /** Get current snapshot of all metrics */
  snapshot(): MetricSnapshot[];
  /** Reset all metrics */
  reset(): void;
}

// ─────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────

interface MetricEntry {
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  count?: number;    // for histograms: observation count
  sum?: number;      // for histograms: sum of observations
}

/**
 * Create an in-memory metrics registry.
 *
 * Counters: monotonically increasing.
 * Gauges: set to arbitrary value.
 * Histograms: track count + sum (mean = sum / count).
 */
export function createMetrics(): Metrics {
  const entries = new Map<string, MetricEntry>();

  function key(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return name + "{" + sorted.map(([k, v]) => k + "=" + v).join(",") + "}";
  }

  return {
    counter(name, amount = 1, labels) {
      const k = key(name, labels);
      const existing = entries.get(k);
      if (existing) {
        existing.value += amount;
      } else {
        entries.set(k, { type: "counter", value: amount, labels: labels ?? {} });
      }
    },

    gauge(name, value, labels) {
      const k = key(name, labels);
      entries.set(k, { type: "gauge", value, labels: labels ?? {} });
    },

    histogram(name, value, labels) {
      const k = key(name, labels);
      const existing = entries.get(k);
      if (existing && existing.type === "histogram") {
        existing.count = (existing.count ?? 0) + 1;
        existing.sum = (existing.sum ?? 0) + value;
        existing.value = existing.sum / existing.count; // mean
      } else {
        entries.set(k, {
          type: "histogram",
          value,
          labels: labels ?? {},
          count: 1,
          sum: value,
        });
      }
    },

    snapshot() {
      const now = Date.now();
      const result: MetricSnapshot[] = [];
      for (const [, entry] of entries) {
        result.push({
          name: entry.type === "histogram"
            ? Object.keys(entry.labels).length > 0 ? Object.keys(entry.labels)[0]! : "metric"
            : "metric",
          type: entry.type,
          value: entry.value,
          labels: entry.labels,
          timestamp: now,
        });
      }
      // Fix: use the actual metric names from keys
      const result2: MetricSnapshot[] = [];
      for (const [k, entry] of entries) {
        const baseName = k.includes("{") ? k.slice(0, k.indexOf("{")) : k;
        result2.push({
          name: baseName,
          type: entry.type,
          value: entry.value,
          labels: entry.labels,
          timestamp: now,
        });
      }
      return result2;
    },

    reset() {
      entries.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Predefined metric names (40+)
// ─────────────────────────────────────────────────────────────

export const METRIC = {
  // Blob store
  BLOB_PUT_COUNT: "blob.put.count",
  BLOB_PUT_BYTES: "blob.put.bytes",
  BLOB_GET_COUNT: "blob.get.count",
  BLOB_CACHE_HIT: "blob.cache.hit",
  BLOB_GC_SWEPT: "blob.gc.swept",
  BLOB_GC_BYTES_FREED: "blob.gc.bytes_freed",
  BLOB_BUDGET_UTILIZATION: "blob.budget.utilization",

  // Search
  SEARCH_QUERY_COUNT: "search.query.count",
  SEARCH_QUERY_LATENCY: "search.query.latency_ms",
  SEARCH_TRIGRAM_HITS: "search.trigram.hits",
  SEARCH_BM25_HITS: "search.bm25.hits",
  SEARCH_SHORT_HITS: "search.short.hits",
  SEARCH_HYBRID_HITS: "search.hybrid.hits",

  // Memory
  MEMORY_CAPTURE_COUNT: "memory.capture.count",
  MEMORY_RECALL_COUNT: "memory.recall.count",
  MEMORY_INJECT_COUNT: "memory.inject.count",
  MEMORY_INJECT_SKIP: "memory.inject.skip",
  MEMORY_PATTERN_TOTAL: "memory.pattern.total",
  MEMORY_DECAY_COUNT: "memory.decay.count",

  // GitHub
  GITHUB_REST_COUNT: "github.rest.count",
  GITHUB_GRAPHQL_COUNT: "github.graphql.count",
  GITHUB_RATE_REMAINING: "github.rate.remaining",
  GITHUB_ETAG_HIT: "github.etag.hit",
  GITHUB_304_COUNT: "github.304.count",
  GITHUB_ERROR_COUNT: "github.error.count",

  // Jobs
  JOB_SUBMITTED: "job.submitted",
  JOB_CLAIMED: "job.claimed",
  JOB_COMPLETED: "job.completed",
  JOB_FAILED: "job.failed",
  JOB_DEAD: "job.dead",
  JOB_QUEUE_DEPTH: "job.queue.depth",
  JOB_CLAIM_LATENCY: "job.claim.latency_ms",

  // Hook
  HOOK_CAPTURE_COUNT: "hook.capture.count",
  HOOK_INJECT_COUNT: "hook.inject.count",
  HOOK_INJECT_LATENCY: "hook.inject.latency_ms",
  HOOK_SPOOL_SIZE: "hook.spool.size",
  HOOK_SPOOL_DRAIN: "hook.spool.drain",

  // Parser
  PARSE_COUNT: "parse.count",
  PARSE_LATENCY: "parse.latency_ms",
  PARSE_ERROR_COUNT: "parse.error.count",
  PARSE_FALLBACK_COUNT: "parse.fallback.count",
} as const;

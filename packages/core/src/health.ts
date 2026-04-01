// Design: Registry of named probes, each returns status + optional details.
// Aggregation: overall = worst individual status.
// Performance: probes run sequentially with per-probe timeout to avoid cascade.

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly message?: string;
  readonly latencyMs?: number;
  readonly details?: Record<string, unknown>;
}

export interface HealthProbe {
  readonly name: string;
  readonly check: () => Promise<HealthCheckResult> | HealthCheckResult;
}

export interface SystemHealth {
  readonly overall: HealthStatus;
  readonly uptimeMs: number;
  readonly checks: Record<string, HealthCheckResult>;
  readonly checkedAt: number;
}

const STATUS_SEVERITY: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

const SEVERITY_TO_STATUS: HealthStatus[] = ["healthy", "degraded", "unhealthy"];

export interface HealthRegistry {
  /** Register a named health probe */
  register(probe: HealthProbe): void;
  /** Run all probes and aggregate results */
  check(): Promise<SystemHealth>;
  /** Get list of registered probe names */
  probeNames(): string[];
}

/**
 * Create a health check registry.
 *
 * Each probe is invoked with a timeout guard (default 5s).
 * Overall status = worst individual status.
 * Failed probes return "unhealthy" with the error message.
 */
export function createHealthRegistry(opts?: {
  probeTimeoutMs?: number;
}): HealthRegistry {
  const probes: HealthProbe[] = [];
  const startTime = Date.now();
  const timeout = opts?.probeTimeoutMs ?? 5000;

  return {
    register(probe) {
      probes.push(probe);
    },

    probeNames() {
      return probes.map(p => p.name);
    },

    async check() {
      const checks: Record<string, HealthCheckResult> = {};
      let worstSeverity = 0;

      for (const probe of probes) {
        const start = performance.now();
        try {
          const result = await Promise.race([
            Promise.resolve(probe.check()),
            new Promise<HealthCheckResult>((_, reject) =>
              setTimeout(() => reject(new Error("Health probe timeout")), timeout)
            ),
          ]);

          const latencyMs = Math.round(performance.now() - start);
          checks[probe.name] = { ...result, latencyMs };

          const severity = STATUS_SEVERITY[result.status];
          if (severity > worstSeverity) worstSeverity = severity;
        } catch (e) {
          const latencyMs = Math.round(performance.now() - start);
          checks[probe.name] = {
            status: "unhealthy",
            message: e instanceof Error ? e.message : String(e),
            latencyMs,
          };
          worstSeverity = 2; // unhealthy
        }
      }

      return {
        overall: SEVERITY_TO_STATUS[worstSeverity] ?? "healthy",
        uptimeMs: Date.now() - startTime,
        checks,
        checkedAt: Date.now(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Common health probe factories
// ─────────────────────────────────────────────────────────────

/** SQLite database health probe */
export function createDatabaseProbe(db: { pragma: (s: string, opts?: { simple: boolean }) => unknown }): HealthProbe {
  return {
    name: "database",
    check() {
      try {
        const result = db.pragma("quick_check", { simple: true });
        return {
          status: result === "ok" ? "healthy" : "unhealthy",
          message: result === "ok" ? undefined : `quick_check: ${String(result)}`,
        };
      } catch (e) {
        return {
          status: "unhealthy",
          message: `Database error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/** Blob store disk space probe */
export function createBlobStoreProbe(
  blobDir: string,
  softBudgetBytes: number,
  getTotalBytes: () => number,
): HealthProbe {
  return {
    name: "blob_store",
    check() {
      try {
        const { statfsSync } = require("node:fs");
        const stats = statfsSync(blobDir);
        const freeBytes = stats.bfree * stats.bsize;
        const totalBlobBytes = getTotalBytes();
        const utilization = totalBlobBytes / softBudgetBytes;

        if (freeBytes < 1_073_741_824) { // < 1GB
          return {
            status: "unhealthy",
            message: `Only ${Math.round(freeBytes / 1048576)}MB free disk space`,
            details: { freeBytes, utilization },
          };
        }
        if (utilization > 0.9) {
          return {
            status: "degraded",
            message: `Blob budget at ${(utilization * 100).toFixed(0)}%`,
            details: { freeBytes, utilization },
          };
        }
        return {
          status: "healthy",
          details: { freeBytes, utilization, totalBlobBytes },
        };
      } catch {
        // statfsSync not available on all platforms — degrade gracefully
        return { status: "healthy", message: "Disk check unavailable" };
      }
    },
  };
}

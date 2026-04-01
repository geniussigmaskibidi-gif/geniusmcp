// Research: Git GC (mark-sweep + grace), content-addressable storage best practices.
// Design: Never delete recently-created blobs (race safety). Budget-based, not time-only.
// Two phases: mark (find orphans) → sweep (delete past grace period).

import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Logger } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// GC Policy: configurable thresholds
// ─────────────────────────────────────────────────────────────

export interface GcPolicy {
  /** Start opportunistic GC when total blob bytes exceeds this */
  readonly softBudgetBytes: number;
  /** Block new remote ingestion when exceeded */
  readonly hardBudgetBytes: number;
  /** Days before orphaned local blobs can be swept */
  readonly orphanGraceDays: number;
  /** Days before orphaned remote (GitHub) blobs can be swept */
  readonly remoteOrphanGraceDays: number;
  /** Maximum blobs to delete per GC run (prevents long pauses) */
  readonly maxSweepPerRun: number;
}

export const DEFAULT_GC_POLICY: GcPolicy = {
  softBudgetBytes: 5 * 1024 * 1024 * 1024,   // 5 GiB
  hardBudgetBytes: 10 * 1024 * 1024 * 1024,   // 10 GiB
  orphanGraceDays: 7,
  remoteOrphanGraceDays: 30,
  maxSweepPerRun: 500,
};

// ─────────────────────────────────────────────────────────────
// GC Report
// ─────────────────────────────────────────────────────────────

export interface GcReport {
  readonly blobsSwept: number;
  readonly bytesFreed: number;
  readonly blobsQuarantined: number;
  readonly orphanCandidates: number;
  readonly totalBlobBytes: number;
  readonly budgetUtilization: number;
}

// ─────────────────────────────────────────────────────────────
// Scrub Report
// ─────────────────────────────────────────────────────────────

export interface ScrubReport {
  readonly verified: number;
  readonly corrupt: number;
  readonly missing: number;
}

// ─────────────────────────────────────────────────────────────
// BlobGc: mark-sweep garbage collector
// ─────────────────────────────────────────────────────────────

export interface BlobGc {
  /** Mark phase: find blobs with zero live references */
  markOrphans(): number;
  /** Sweep phase: delete orphan blobs past grace period */
  sweep(dryRun?: boolean): GcReport;
  /** Quarantine a corrupt or missing blob */
  quarantine(sha: string, reason: string): void;
  /** Verify a random sample of blobs for integrity */
  scrubSample(sampleRate: number): ScrubReport;
}

export function createBlobGc(
  db: Database.Database,
  blobDir: string,
  policy: GcPolicy,
  logger: Logger,
): BlobGc {
  // GC roots: file_refs, symbols, patterns, imports, blob_pins
  const markOrphansStmt = db.prepare(
    "UPDATE blobs SET disk_state = 'orphan_candidate'" +
    " WHERE disk_state = 'present'" +
    "   AND content_state NOT IN ('quarantined', 'deleted')" +
    "   AND sha NOT IN (SELECT DISTINCT blob_sha FROM file_refs)" +
    "   AND sha NOT IN (SELECT DISTINCT blob_sha FROM symbols WHERE blob_sha IS NOT NULL)" +
    "   AND sha NOT IN (SELECT blob_sha FROM blob_pins" +
    "     WHERE expires_at_ms IS NULL OR expires_at_ms > ?)" +
    "   AND ref_count = 0 AND pin_count = 0"
  );

  const sweepCandidatesStmt = db.prepare(
    "SELECT sha, size_bytes FROM blobs" +
    " WHERE disk_state = 'orphan_candidate'" +
    "   AND created_at_ms < ?" +
    " ORDER BY last_accessed_at_ms ASC, created_at_ms ASC" +
    " LIMIT ?"
  );

  const markDeletedStmt = db.prepare(
    "UPDATE blobs SET disk_state = 'deleted', content_state = 'deleted' WHERE sha = ?"
  );

  const totalSizeStmt = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) as total FROM blobs WHERE content_state != 'deleted'"
  );

  const quarantineStmt = db.prepare(
    "UPDATE blobs SET content_state = 'quarantined', quarantine_reason = ? WHERE sha = ?"
  );

  const verifyStmt = db.prepare(
    "UPDATE blobs SET content_state = 'verified', last_verified_at_ms = ? WHERE sha = ?"
  );

  const sampleBlobsStmt = db.prepare(
    "SELECT sha, size_bytes FROM blobs" +
    " WHERE content_state IN ('committed', 'verified')" +
    " ORDER BY CASE WHEN last_verified_at_ms IS NULL THEN 0 ELSE last_verified_at_ms END ASC" +
    " LIMIT ?"
  );

  function blobFilePath(sha: string): string {
    return join(blobDir, sha.slice(0, 2), sha.slice(2));
  }

  return {
    markOrphans(): number {
      const now = Date.now();
      const result = markOrphansStmt.run(now);
      const count = result.changes;
      if (count > 0) {
        logger.info("GC mark phase", { orphansFound: count });
      }
      return count;
    },

    sweep(dryRun = false): GcReport {
      const graceMs = policy.orphanGraceDays * 86_400_000;
      const cutoff = Date.now() - graceMs;

      const candidates = sweepCandidatesStmt.all(cutoff, policy.maxSweepPerRun) as
        Array<{ sha: string; size_bytes: number }>;

      let blobsSwept = 0;
      let bytesFreed = 0;

      if (!dryRun && candidates.length > 0) {
        const tx = db.transaction(() => {
          for (const { sha, size_bytes } of candidates) {
            const filePath = blobFilePath(sha);
            try { unlinkSync(filePath); } catch { /* already gone — safe */ }
            markDeletedStmt.run(sha);
            blobsSwept++;
            bytesFreed += size_bytes;
          }
        });
        tx();
      } else if (dryRun) {
        blobsSwept = candidates.length;
        bytesFreed = candidates.reduce((s, c) => s + c.size_bytes, 0);
      }

      const { total } = totalSizeStmt.get() as { total: number };

      const report: GcReport = {
        blobsSwept,
        bytesFreed,
        blobsQuarantined: 0,
        orphanCandidates: candidates.length,
        totalBlobBytes: total,
        budgetUtilization: policy.softBudgetBytes > 0 ? total / policy.softBudgetBytes : 0,
      };

      if (blobsSwept > 0) {
        logger.info("GC sweep", {
          swept: blobsSwept,
          freedMb: (bytesFreed / 1048576).toFixed(1),
          utilization: report.budgetUtilization.toFixed(2),
        });
      }

      return report;
    },

    quarantine(sha: string, reason: string): void {
      quarantineStmt.run(reason, sha);
      logger.warn("Blob quarantined", { sha: sha.slice(0, 12), reason });
    },

    scrubSample(sampleRate: number): ScrubReport {
      const count = Math.max(1, Math.ceil(sampleRate * 100));
      const blobs = sampleBlobsStmt.all(count) as Array<{ sha: string; size_bytes: number }>;

      let verified = 0;
      let corrupt = 0;
      let missing = 0;

      for (const { sha } of blobs) {
        const filePath = blobFilePath(sha);

        if (!existsSync(filePath)) {
          this.quarantine(sha, "file_missing");
          missing++;
          continue;
        }

        try {
          const content = readFileSync(filePath, "utf-8");
          const actualSha = createHash("sha256").update(content, "utf-8").digest("hex");

          if (actualSha !== sha) {
            this.quarantine(sha, "hash_mismatch");
            corrupt++;
          } else {
            verifyStmt.run(Date.now(), sha);
            verified++;
          }
        } catch {
          this.quarantine(sha, "read_error");
          corrupt++;
        }
      }

      if (corrupt > 0 || missing > 0) {
        logger.warn("Scrub found issues", { verified, corrupt, missing });
      } else if (verified > 0) {
        logger.debug("Scrub clean", { verified });
      }

      return { verified, corrupt, missing };
    },
  };
}

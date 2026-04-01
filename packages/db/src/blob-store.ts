// Design: Git-inspired SHA-256 keyed storage. Parse once per blob.
// Same file across 10 forks = stored and parsed ONCE.
// v1.0: All public methods return ForgeResult<T> — no raw throws cross boundary.

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import type Database from "better-sqlite3";
import type { ForgeResult } from "@forgemcp/core";
import { ok, err } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// Hashing: SHA-256 for content integrity (Git-compatible reasoning)
// ─────────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─────────────────────────────────────────────────────────────
// Disk layout: blobs/aa/bbccddee... (2-char prefix subdirectory)
// Same principle as .git/objects/
// ─────────────────────────────────────────────────────────────

function blobPath(blobDir: string, sha: string): string {
  const prefix = sha.slice(0, 2);
  const rest = sha.slice(2);
  return join(blobDir, prefix, rest);
}

// ─────────────────────────────────────────────────────────────
// BlobStore: disk for content, SQLite for metadata
// ─────────────────────────────────────────────────────────────

export interface BlobMeta {
  readonly sha: string;
  readonly language: string | null;
  readonly sizeBytes: number;
}

export interface BlobStore {
  /** Store content and return its SHA. No-op if already exists. */
  put(content: string, language: string | null): ForgeResult<{ sha: string; sizeBytes: number }>;

  /** Read content by SHA. */
  get(sha: string): ForgeResult<{ content: string; verified: boolean }>;

  /** Check if blob exists (metadata only, no disk read). */
  has(sha: string): boolean;

  /** Get metadata for a blob. */
  meta(sha: string): ForgeResult<BlobMeta | null>;

  /** Get total disk usage. */
  diskUsage(): { totalBytes: number; blobCount: number; utilization: number };
}

export function createBlobStore(
  db: Database.Database,
  blobDir: string,
  opts?: { softBudgetBytes?: number; hardBudgetBytes?: number },
): BlobStore {
  // Ensure root blob directory exists
  mkdirSync(blobDir, { recursive: true });

  const softBudget = opts?.softBudgetBytes ?? 2 * 1024 * 1024 * 1024;  // 2 GB
  const hardBudget = opts?.hardBudgetBytes ?? Math.round(softBudget * 1.15);

  const getTotalSize = db.prepare("SELECT COALESCE(SUM(size_bytes), 0) as total FROM blobs");

  function checkBudget(newBytes: number): "ok" | "soft_exceeded" | "hard_exceeded" {
    const { total } = getTotalSize.get() as { total: number };
    if (total + newBytes > hardBudget) return "hard_exceeded";
    if (total + newBytes > softBudget) return "soft_exceeded";
    return "ok";
  }

  // Prepared statements for hot-path performance
  const insertBlob = db.prepare(
    "INSERT OR IGNORE INTO blobs (sha, language, size_bytes) VALUES (?, ?, ?)"
  );

  const selectBlob = db.prepare(
    "SELECT sha, language, size_bytes FROM blobs WHERE sha = ?"
  );

  const existsBlob = db.prepare(
    "SELECT 1 FROM blobs WHERE sha = ?"
  );

  const countBlobs = db.prepare(
    "SELECT COUNT(*) as cnt, COALESCE(SUM(size_bytes), 0) as total FROM blobs"
  );

  return {
    put(content: string, language: string | null): ForgeResult<{ sha: string; sizeBytes: number }> {
      try {
        const sha = hashContent(content);

        // Fast path: already indexed — skip disk write
        if (existsBlob.get(sha)) {
          const row = selectBlob.get(sha) as { size_bytes: number } | undefined;
          return ok({ sha, sizeBytes: row?.size_bytes ?? 0 });
        }

        const sizeBytes = Buffer.byteLength(content, "utf-8");
        const budget = checkBudget(sizeBytes);
        if (budget === "hard_exceeded") {
          return err("BUDGET_EXCEEDED",
            `Blob store hard budget exceeded (${(hardBudget / 1048576).toFixed(0)}MB). Run GC or increase budget.`,
            { recoverable: true, suggestedAction: "Run GC or increase blobHardBudgetMb in config" }
          );
        }
        if (budget === "soft_exceeded") {
          // Soft exceeded: allow write but warn (remote ingestion should be blocked by callers)
          process.stderr.write("Blob store soft budget exceeded — remote ingestion will be blocked\n");
        }

        const filePath = blobPath(blobDir, sha);
        const dir = join(blobDir, sha.slice(0, 2));
        mkdirSync(dir, { recursive: true });

        const tmpPath = filePath + ".tmp." + process.pid;
        try {
          writeFileSync(tmpPath, content, "utf-8");
          renameSync(tmpPath, filePath); // atomic on same filesystem
        } catch (writeErr) {
          try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
          return err("INTERNAL",
            `Failed to write blob to disk: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
          );
        }

        // Record metadata in SQLite
        insertBlob.run(sha, language, sizeBytes);

        return ok({ sha, sizeBytes });
      } catch (e) {
        return err("INTERNAL", `Blob put failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    get(sha: string): ForgeResult<{ content: string; verified: boolean }> {
      try {
        const filePath = blobPath(blobDir, sha);
        if (!existsSync(filePath)) {
          return err("BLOB_MISSING",
            `Blob ${sha.slice(0, 12)} not found on disk`,
            { recoverable: false }
          );
        }
        const content = readFileSync(filePath, "utf-8");

        // Only on reads where we already have the content — zero extra I/O
        const actualSha = hashContent(content);
        const verified = actualSha === sha;

        if (!verified) {
          return err("CORRUPT",
            `Blob ${sha.slice(0, 12)} hash mismatch (expected ${sha.slice(0, 12)}, got ${actualSha.slice(0, 12)})`,
            { recoverable: false, suggestedAction: "Run forgemcp doctor to repair" }
          );
        }

        return ok({ content, verified });
      } catch (e) {
        return err("INTERNAL", `Blob get failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    has(sha: string): boolean {
      return existsBlob.get(sha) !== undefined;
    },

    meta(sha: string): ForgeResult<BlobMeta | null> {
      try {
        const row = selectBlob.get(sha) as
          | { sha: string; language: string | null; size_bytes: number }
          | undefined;
        if (!row) return ok(null);
        return ok({ sha: row.sha, language: row.language, sizeBytes: row.size_bytes });
      } catch (e) {
        return err("INTERNAL", `Blob meta failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    diskUsage(): { totalBytes: number; blobCount: number; utilization: number } {
      const { cnt, total } = countBlobs.get() as { cnt: number; total: number };
      return {
        totalBytes: total,
        blobCount: cnt,
        utilization: total / softBudget,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// FileRef operations: map repo+commit+path → blob SHA
// ─────────────────────────────────────────────────────────────

export interface FileRefStore {
  /** Link a repo+commit+path to a blob SHA. */
  put(repoId: number, commitSha: string, path: string, blobSha: string, language: string | null): void;

  /** Get blob SHA for a repo+commit+path. */
  get(repoId: number, commitSha: string, path: string): string | null;

  /** List all files in a repo at a commit. */
  listFiles(repoId: number, commitSha: string): Array<{ path: string; blobSha: string; language: string | null }>;
}

export function createFileRefStore(db: Database.Database): FileRefStore {
  const upsertRef = db.prepare(
    "INSERT OR REPLACE INTO file_refs (repo_id, commit_sha, path, blob_sha, language) VALUES (?, ?, ?, ?, ?)"
  );

  const selectRef = db.prepare(
    "SELECT blob_sha FROM file_refs WHERE repo_id = ? AND commit_sha = ? AND path = ?"
  );

  const listRefs = db.prepare(
    "SELECT path, blob_sha, language FROM file_refs WHERE repo_id = ? AND commit_sha = ? ORDER BY path"
  );

  return {
    put(repoId, commitSha, path, blobSha, language) {
      upsertRef.run(repoId, commitSha, path, blobSha, language);
    },

    get(repoId, commitSha, path) {
      const row = selectRef.get(repoId, commitSha, path) as { blob_sha: string } | undefined;
      return row?.blob_sha ?? null;
    },

    listFiles(repoId, commitSha) {
      return (listRefs.all(repoId, commitSha) as Array<{
        path: string;
        blob_sha: string;
        language: string | null;
      }>).map((r) => ({
        path: r.path,
        blobSha: r.blob_sha,
        language: r.language,
      }));
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Derivation tracking: "has this blob been analyzed?"
// ─────────────────────────────────────────────────────────────

export interface DerivationStore {
  /** Check if blob has been processed by analyzer at version. */
  has(blobSha: string, analyzer: string, version: string): boolean;

  /** Record that blob was processed. */
  record(blobSha: string, analyzer: string, version: string): void;
}

export function createDerivationStore(db: Database.Database): DerivationStore {
  const check = db.prepare(
    "SELECT 1 FROM derivations WHERE blob_sha = ? AND analyzer = ? AND analyzer_version = ?"
  );

  const insert = db.prepare(
    "INSERT OR IGNORE INTO derivations (blob_sha, analyzer, analyzer_version) VALUES (?, ?, ?)"
  );

  return {
    has(blobSha, analyzer, version) {
      return check.get(blobSha, analyzer, version) !== undefined;
    },

    record(blobSha, analyzer, version) {
      insert.run(blobSha, analyzer, version);
    },
  };
}

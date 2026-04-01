import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDatabase, migrateDatabase, closeDatabase,
  createBlobStore, createBlobGc, DEFAULT_GC_POLICY,
} from "@forgemcp/db";
import { createNullLogger } from "@forgemcp/core";

describe("Blob Lifecycle & GC", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;
  let blobDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgemcp-gc-test-"));
    blobDir = join(tmpDir, "blobs");
    db = openDatabase(join(tmpDir, "test.db"));
    migrateDatabase(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migration 005 adds lifecycle columns", () => {
    // Verify columns exist by inserting with lifecycle values
    const store = createBlobStore(db, blobDir);
    const r = store.put("test content", "typescript");
    expect(r.ok).toBe(true);

    if (!r.ok) return;
    const row = db.prepare("SELECT content_state, disk_state, ref_count FROM blobs WHERE sha = ?")
      .get(r.value.sha) as { content_state: string; disk_state: string; ref_count: number };

    expect(row.content_state).toBe("committed");
    expect(row.disk_state).toBe("present");
    expect(row.ref_count).toBe(0);
  });

  it("blob_pins table created by migration", () => {
    // Verify table exists
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_pins'").get();
    expect(result).toBeDefined();
  });

  it("blob_usage table created by migration", () => {
    const result = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blob_usage'").get();
    expect(result).toBeDefined();
  });

  describe("GC Mark Phase", () => {
    it("marks unreferenced blobs as orphan_candidate", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const gc = createBlobGc(db, blobDir, DEFAULT_GC_POLICY, logger);

      // Create a blob with no references
      const r = store.put("orphan content", "typescript");
      expect(r.ok).toBe(true);

      const orphans = gc.markOrphans();
      expect(orphans).toBe(1);

      if (!r.ok) return;
      const row = db.prepare("SELECT disk_state FROM blobs WHERE sha = ?")
        .get(r.value.sha) as { disk_state: string };
      expect(row.disk_state).toBe("orphan_candidate");
    });

    it("does not mark pinned blobs as orphans", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const gc = createBlobGc(db, blobDir, DEFAULT_GC_POLICY, logger);

      const r = store.put("pinned content", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Pin the blob
      db.prepare(
        "INSERT INTO blob_pins (blob_sha, reason, owner_type, owner_id) VALUES (?, ?, ?, ?)"
      ).run(r.value.sha, "test", "manual", "test-1");

      const orphans = gc.markOrphans();
      expect(orphans).toBe(0);
    });
  });

  describe("GC Sweep Phase", () => {
    it("sweep dry run does not delete anything", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const policy = { ...DEFAULT_GC_POLICY, orphanGraceDays: 0 }; // no grace for test
      const gc = createBlobGc(db, blobDir, policy, logger);

      const r = store.put("will survive dry run", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Mark as orphan with old timestamp
      db.prepare("UPDATE blobs SET disk_state = 'orphan_candidate', created_at_ms = 0 WHERE sha = ?")
        .run(r.value.sha);

      const report = gc.sweep(true); // dry run
      expect(report.blobsSwept).toBe(1);

      // File should still exist
      expect(store.has(r.value.sha)).toBe(true);
    });

    it("sweep respects grace period", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      // 999 day grace — nothing will be swept
      const policy = { ...DEFAULT_GC_POLICY, orphanGraceDays: 999 };
      const gc = createBlobGc(db, blobDir, policy, logger);

      const r = store.put("too young to die", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Set as orphan but with recent created_at_ms — should not be swept
      db.prepare("UPDATE blobs SET disk_state = 'orphan_candidate', created_at_ms = ? WHERE sha = ?")
        .run(Date.now(), r.value.sha);

      const report = gc.sweep(false);
      expect(report.blobsSwept).toBe(0);
    });

    it("sweep deletes old orphans", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const policy = { ...DEFAULT_GC_POLICY, orphanGraceDays: 0 };
      const gc = createBlobGc(db, blobDir, policy, logger);

      const r = store.put("gonna be swept", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Mark as old orphan
      db.prepare(
        "UPDATE blobs SET disk_state = 'orphan_candidate', created_at_ms = 0, last_accessed_at_ms = 0 WHERE sha = ?"
      ).run(r.value.sha);

      const report = gc.sweep(false);
      expect(report.blobsSwept).toBe(1);
      expect(report.bytesFreed).toBeGreaterThan(0);

      // DB should show deleted
      const row = db.prepare("SELECT disk_state FROM blobs WHERE sha = ?")
        .get(r.value.sha) as { disk_state: string };
      expect(row.disk_state).toBe("deleted");
    });
  });

  describe("Integrity Scrub", () => {
    it("verifies good blobs", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const gc = createBlobGc(db, blobDir, DEFAULT_GC_POLICY, logger);

      store.put("good content 1", "typescript");
      store.put("good content 2", "typescript");

      const report = gc.scrubSample(1.0); // scrub all
      expect(report.verified).toBe(2);
      expect(report.corrupt).toBe(0);
      expect(report.missing).toBe(0);
    });

    it("quarantines missing blobs", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const gc = createBlobGc(db, blobDir, DEFAULT_GC_POLICY, logger);

      const r = store.put("will be deleted from disk", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Delete file from disk manually
      const filePath = join(blobDir, r.value.sha.slice(0, 2), r.value.sha.slice(2));
      rmSync(filePath);

      const report = gc.scrubSample(1.0);
      expect(report.missing).toBe(1);

      const row = db.prepare("SELECT content_state, quarantine_reason FROM blobs WHERE sha = ?")
        .get(r.value.sha) as { content_state: string; quarantine_reason: string };
      expect(row.content_state).toBe("quarantined");
      expect(row.quarantine_reason).toBe("file_missing");
    });

    it("quarantines corrupt blobs", () => {
      const store = createBlobStore(db, blobDir);
      const logger = createNullLogger();
      const gc = createBlobGc(db, blobDir, DEFAULT_GC_POLICY, logger);

      const r = store.put("original content", "typescript");
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // Corrupt file on disk
      const filePath = join(blobDir, r.value.sha.slice(0, 2), r.value.sha.slice(2));
      writeFileSync(filePath, "CORRUPTED DATA", "utf-8");

      const report = gc.scrubSample(1.0);
      expect(report.corrupt).toBe(1);

      const row = db.prepare("SELECT content_state, quarantine_reason FROM blobs WHERE sha = ?")
        .get(r.value.sha) as { content_state: string; quarantine_reason: string };
      expect(row.content_state).toBe("quarantined");
      expect(row.quarantine_reason).toBe("hash_mismatch");
    });
  });
});

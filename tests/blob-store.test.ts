// v1.0: Updated for ForgeResult<T> API — no more raw returns
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, migrateDatabase, closeDatabase, createBlobStore, createFileRefStore, createDerivationStore, hashContent } from "@forgemcp/db";

describe("Blob Store", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgemcp-test-"));
    db = openDatabase(join(tmpDir, "test.db"));
    migrateDatabase(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hashContent", () => {
    it("should produce consistent SHA-256 hashes", () => {
      const hash1 = hashContent("hello world");
      const hash2 = hashContent("hello world");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // full SHA-256 hex
    });

    it("should produce different hashes for different content", () => {
      const h1 = hashContent("function foo() {}");
      const h2 = hashContent("function bar() {}");
      expect(h1).not.toBe(h2);
    });
  });

  describe("BlobStore", () => {
    it("should store and retrieve content", () => {
      const blobDir = join(tmpDir, "blobs");
      const store = createBlobStore(db, blobDir);

      const content = "export function hello() { return 'world'; }";
      const putResult = store.put(content, "typescript");

      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;

      expect(putResult.value.sha).toHaveLength(64);
      expect(store.has(putResult.value.sha)).toBe(true);

      const getResult = store.get(putResult.value.sha);
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.content).toBe(content);
        expect(getResult.value.verified).toBe(true);
      }
    });

    it("should deduplicate identical content", () => {
      const blobDir = join(tmpDir, "blobs");
      const store = createBlobStore(db, blobDir);

      const content = "const x = 42;";
      const r1 = store.put(content, "typescript");
      const r2 = store.put(content, "typescript");

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.sha).toBe(r2.value.sha); // same hash = same blob
      }
    });

    it("should return metadata", () => {
      const blobDir = join(tmpDir, "blobs");
      const store = createBlobStore(db, blobDir);

      const content = "def hello(): pass";
      const putResult = store.put(content, "python");
      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;

      const metaResult = store.meta(putResult.value.sha);
      expect(metaResult.ok).toBe(true);
      if (metaResult.ok && metaResult.value) {
        expect(metaResult.value.language).toBe("python");
        expect(metaResult.value.sizeBytes).toBeGreaterThan(0);
      }
    });

    it("should return null for non-existent blob metadata", () => {
      const blobDir = join(tmpDir, "blobs");
      const store = createBlobStore(db, blobDir);

      expect(store.has("deadbeef")).toBe(false);

      const getResult = store.get("deadbeef");
      expect(getResult.ok).toBe(false);
      if (!getResult.ok) {
        expect(getResult.error.code).toBe("BLOB_MISSING");
      }

      const metaResult = store.meta("deadbeef");
      expect(metaResult.ok).toBe(true);
      if (metaResult.ok) {
        expect(metaResult.value).toBeNull();
      }
    });

    it("should report disk usage", () => {
      const blobDir = join(tmpDir, "blobs");
      const store = createBlobStore(db, blobDir);

      store.put("content1", "typescript");
      store.put("content2", "typescript");

      const usage = store.diskUsage();
      expect(usage.blobCount).toBe(2);
      expect(usage.totalBytes).toBeGreaterThan(0);
      expect(typeof usage.utilization).toBe("number");
    });
  });

  describe("FileRefStore", () => {
    it("should map repo+commit+path to blob SHA", () => {
      const blobDir = join(tmpDir, "blobs");
      const blobStore = createBlobStore(db, blobDir);
      const fileRefStore = createFileRefStore(db);

      // Need a repo in the repos table first
      db.prepare("INSERT INTO repos (full_name, refreshed_at) VALUES (?, datetime('now'))").run("test/repo");
      const repoRow = db.prepare("SELECT id FROM repos WHERE full_name = ?").get("test/repo") as { id: number };

      const content = "export const PI = 3.14;";
      const putResult = blobStore.put(content, "typescript");
      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;

      fileRefStore.put(repoRow.id, "abc123", "src/math.ts", putResult.value.sha, "typescript");

      const result = fileRefStore.get(repoRow.id, "abc123", "src/math.ts");
      expect(result).toBe(putResult.value.sha);
    });

    it("should list files at a commit", () => {
      const blobDir = join(tmpDir, "blobs");
      const blobStore = createBlobStore(db, blobDir);
      const fileRefStore = createFileRefStore(db);

      db.prepare("INSERT INTO repos (full_name, refreshed_at) VALUES (?, datetime('now'))").run("test/repo");
      const repoRow = db.prepare("SELECT id FROM repos WHERE full_name = ?").get("test/repo") as { id: number };

      const r1 = blobStore.put("const a = 1;", "typescript");
      const r2 = blobStore.put("const b = 2;", "typescript");
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      fileRefStore.put(repoRow.id, "commit1", "src/a.ts", r1.value.sha, "typescript");
      fileRefStore.put(repoRow.id, "commit1", "src/b.ts", r2.value.sha, "typescript");

      const files = fileRefStore.listFiles(repoRow.id, "commit1");
      expect(files).toHaveLength(2);
      expect(files.map(f => f.path)).toContain("src/a.ts");
      expect(files.map(f => f.path)).toContain("src/b.ts");
    });
  });

  describe("DerivationStore", () => {
    it("should track processed blobs", () => {
      const blobDir = join(tmpDir, "blobs");
      const blobStore = createBlobStore(db, blobDir);
      const derivStore = createDerivationStore(db);

      const putResult = blobStore.put("function test() {}", "typescript");
      expect(putResult.ok).toBe(true);
      if (!putResult.ok) return;
      const sha = putResult.value.sha;

      expect(derivStore.has(sha, "symbols", "1.0")).toBe(false);
      derivStore.record(sha, "symbols", "1.0");
      expect(derivStore.has(sha, "symbols", "1.0")).toBe(true);

      // Different version = not yet processed
      expect(derivStore.has(sha, "symbols", "2.0")).toBe(false);
    });
  });
});

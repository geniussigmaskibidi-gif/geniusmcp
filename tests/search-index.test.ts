import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, migrateDatabase, closeDatabase, createSearchIndex } from "@forgemcp/db";

describe("Search Index", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgemcp-search-"));
    db = openDatabase(join(tmpDir, "test.db"));
    migrateDatabase(db);
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should index and search by trigram (substring)", () => {
    const idx = createSearchIndex(db);

    idx.add({
      blobSha: "abc123",
      symbolId: null,
      filePath: "src/utils/retry.ts",
      symbolName: "retryWithBackoff",
      codeText: "export function retryWithBackoff(fn, maxRetries) { /* ... */ }",
      signature: "(fn: Function, maxRetries: number) => Promise<void>",
      docComment: "Retry a function with exponential backoff",
      repo: "test/repo",
      language: "typescript",
    });

    // Trigram: substring match
    const results = idx.searchTrigram("retryWith");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.symbolName).toBe("retryWithBackoff");
  });

  it("should index and search by BM25 (word match)", () => {
    const idx = createSearchIndex(db);

    idx.add({
      blobSha: "def456",
      symbolId: null,
      filePath: "src/middleware/rateLimit.ts",
      symbolName: "createRateLimiter",
      codeText: "export function createRateLimiter(opts) { return new TokenBucket(opts); }",
      signature: "(opts: RateLimitOptions) => RateLimiter",
      docComment: "Create a token bucket rate limiter middleware",
      repo: "test/repo",
      language: "typescript",
    });

    const results = idx.searchBm25("rate limiter");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should fuse results with RRF in hybrid search", () => {
    const idx = createSearchIndex(db);

    // Add multiple documents
    idx.addMany([
      {
        blobSha: "aaa",
        symbolId: null,
        filePath: "src/cache.ts",
        symbolName: "LRUCache",
        codeText: "export class LRUCache { get(key) { } set(key, val) { } }",
        signature: null,
        docComment: "Least Recently Used cache implementation",
        repo: "test/repo",
        language: "typescript",
      },
      {
        blobSha: "bbb",
        symbolId: null,
        filePath: "src/memoize.ts",
        symbolName: "memoize",
        codeText: "export function memoize(fn) { const cache = new Map(); return (...args) => { } }",
        signature: null,
        docComment: "Memoization helper using Map cache",
        repo: "test/repo",
        language: "typescript",
      },
    ]);

    expect(idx.count()).toBe(2);

    // Hybrid search should find both
    const results = idx.searchHybrid("cache");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should remove blob from all indexes", () => {
    const idx = createSearchIndex(db);

    idx.add({
      blobSha: "remove-me",
      symbolId: null,
      filePath: "tmp.ts",
      symbolName: "tempFunc",
      codeText: "function tempFunc() {}",
      signature: null,
      docComment: null,
      repo: "test/repo",
      language: "typescript",
    });

    expect(idx.count()).toBe(1);
    idx.removeBlob("remove-me");
    expect(idx.count()).toBe(0);
  });
});

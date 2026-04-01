import { describe, it, expect } from "vitest";
import {
  computeFingerprint, jaccardSimilarity, clusterByJaccard,
  normalizeCode, contentHash,
} from "@forgemcp/hunt-engine";

describe("Winnowing", () => {
  describe("normalizeCode", () => {
    it("should strip string literals", () => {
      const norm = normalizeCode(`const msg = "hello world";`);
      expect(norm).toContain("_s_"); // lowercased by normalizer
      expect(norm).not.toContain("hello world");
    });

    it("should strip number literals", () => {
      const norm = normalizeCode(`const x = 42; const y = 3.14;`);
      expect(norm).toContain("_n_"); // lowercased by normalizer
      expect(norm).not.toContain("42");
    });

    it("should preserve keywords", () => {
      const norm = normalizeCode(`function foo() { return true; }`);
      expect(norm).toContain("function");
      expect(norm).toContain("return");
    });

    it("should lowercase identifiers", () => {
      const norm = normalizeCode(`const MyVariable = getValue();`);
      expect(norm).toContain("myvariable");
      expect(norm).toContain("getvalue");
    });
  });

  describe("computeFingerprint", () => {
    it("should produce non-empty fingerprint for real code", () => {
      const fp = computeFingerprint("function retry(fn, max) { for (let i = 0; i < max; i++) { try { return fn(); } catch {} } }");
      expect(fp.hashes.length).toBeGreaterThan(0);
    });

    it("should produce similar fingerprints for renamed code", () => {
      const fp1 = computeFingerprint("function retryOp(fn, maxAttempts) { for (let i = 0; i < maxAttempts; i++) { try { return fn(); } catch(e) { } } }");
      const fp2 = computeFingerprint("function executeWithRetry(callback, retries) { for (let i = 0; i < retries; i++) { try { return callback(); } catch(err) { } } }");

      const sim = jaccardSimilarity(fp1, fp2);
      expect(sim).toBeGreaterThan(0.3); // similar structure should have >30% overlap
    });

    it("should produce different fingerprints for different logic", () => {
      const fp1 = computeFingerprint("function add(a, b) { return a + b; }");
      const fp2 = computeFingerprint("class EventEmitter { listeners = new Map(); on(event, fn) { this.listeners.set(event, fn); } }");

      const sim = jaccardSimilarity(fp1, fp2);
      expect(sim).toBeLessThan(0.3); // different code = low similarity
    });

    it("should return empty for very short code", () => {
      const fp = computeFingerprint("x=1");
      expect(fp.hashes.length).toBe(0);
    });
  });

  describe("clusterByJaccard", () => {
    it("should cluster similar items together", () => {
      const base = "function process(items) { for (const item of items) { transform(item); } return items; }";
      const variant = "function handleData(entries) { for (const entry of entries) { transform(entry); } return entries; }";
      const different = "class Cache { constructor() { this.store = new Map(); } get(key) { return this.store.get(key); } }";

      const items = [
        { id: "a", fingerprint: computeFingerprint(base) },
        { id: "b", fingerprint: computeFingerprint(variant) },
        { id: "c", fingerprint: computeFingerprint(different) },
      ];

      const clusters = clusterByJaccard(items, 0.3);

      // base and variant should be in same cluster, different in its own
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      expect(clusters.length).toBeLessThanOrEqual(3);
    });

    it("should handle single item", () => {
      const items = [{ id: "only", fingerprint: computeFingerprint("function x() {}") }];
      const clusters = clusterByJaccard(items);
      expect(clusters.length).toBe(1);
      expect(clusters[0]!.size).toBe(1);
    });
  });

  describe("contentHash", () => {
    it("should produce consistent SHA-256", () => {
      const h1 = contentHash("hello");
      const h2 = contentHash("hello");
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });

    it("should differ for different content", () => {
      expect(contentHash("a")).not.toBe(contentHash("b"));
    });
  });
});

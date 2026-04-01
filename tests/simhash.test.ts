// Tests: fingerprint computation, Hamming distance, near-duplicate detection

import { describe, it, expect } from "vitest";
import { simhash64, hammingDistance, isNearDuplicate } from "@forgemcp/db/simhash";

describe("SimHash64", () => {
  it("returns 0n for very short text", () => {
    expect(simhash64("ab")).toBe(0n);
    expect(simhash64("")).toBe(0n);
  });

  it("produces non-zero fingerprint for real code", () => {
    const code = `function retryWithBackoff(fn, maxRetries = 3) {
      let attempt = 0;
      while (attempt < maxRetries) {
        try { return fn(); } catch (e) { attempt++; }
      }
    }`;
    const hash = simhash64(code);
    expect(hash).not.toBe(0n);
  });

  it("identical content produces identical hash", () => {
    const code = "function hello() { return 'world'; }";
    expect(simhash64(code)).toBe(simhash64(code));
  });

  it("similar content produces similar hashes (low Hamming distance)", () => {
    const code1 = `function retryWithBackoff(fn, maxRetries = 3) {
      let attempt = 0;
      while (attempt < maxRetries) {
        try { return fn(); } catch (e) { attempt++; }
      }
    }`;
    // Small change: renamed variable
    const code2 = `function retryWithBackoff(fn, maxRetries = 3) {
      let tries = 0;
      while (tries < maxRetries) {
        try { return fn(); } catch (e) { tries++; }
      }
    }`;
    const h1 = simhash64(code1);
    const h2 = simhash64(code2);
    const dist = hammingDistance(h1, h2);
    // Similar code should have low Hamming distance
    expect(dist).toBeLessThan(20);
  });

  it("very different content produces different hashes (high Hamming distance)", () => {
    const code1 = "function retryWithBackoff(fn) { let attempt = 0; }";
    const code2 = "class DatabaseConnection { constructor(host, port) { this.pool = []; } }";
    const h1 = simhash64(code1);
    const h2 = simhash64(code2);
    const dist = hammingDistance(h1, h2);
    // Different code should have higher Hamming distance
    expect(dist).toBeGreaterThan(5);
  });

  it("strips comments before hashing", () => {
    const withComments = `
      // This is a comment
      function hello() { return 'world'; }
      /* block comment */
    `;
    const withoutComments = `
      function hello() { return 'world'; }
    `;
    const h1 = simhash64(withComments);
    const h2 = simhash64(withoutComments);
    // Should be identical or very close
    expect(hammingDistance(h1, h2)).toBeLessThan(5);
  });
});

describe("hammingDistance", () => {
  it("identical values have distance 0", () => {
    expect(hammingDistance(42n, 42n)).toBe(0);
    expect(hammingDistance(0n, 0n)).toBe(0);
  });

  it("single bit difference has distance 1", () => {
    expect(hammingDistance(0b1000n, 0b1001n)).toBe(1);
  });

  it("all bits different in 8-bit range", () => {
    expect(hammingDistance(0b00000000n, 0b11111111n)).toBe(8);
  });

  it("is symmetric", () => {
    const a = 12345n;
    const b = 67890n;
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });
});

describe("isNearDuplicate", () => {
  it("identical hashes are near-duplicates", () => {
    expect(isNearDuplicate(42n, 42n)).toBe(true);
  });

  it("distance within threshold is near-duplicate", () => {
    // Distance 2 < default threshold 3
    expect(isNearDuplicate(0b1100n, 0b1111n, 3)).toBe(true);
  });

  it("distance above threshold is not near-duplicate", () => {
    expect(isNearDuplicate(0n, 0b11111111n, 3)).toBe(false);
  });

  it("respects custom threshold", () => {
    // Distance is 8, threshold 10 → near-duplicate
    expect(isNearDuplicate(0n, 0b11111111n, 10)).toBe(true);
    // Distance is 8, threshold 5 → not near-duplicate
    expect(isNearDuplicate(0n, 0b11111111n, 5)).toBe(false);
  });
});

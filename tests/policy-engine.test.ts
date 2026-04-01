import { describe, it, expect } from "vitest";
import { evaluateImportPolicy, buildProvenanceManifest, generateAttribution } from "@forgemcp/importer";

describe("Import Policy Engine", () => {
  describe("evaluateImportPolicy", () => {
    it("should always allow reference_only mode", () => {
      const result = evaluateImportPolicy({
        mode: "reference_only",
        licenseSpdx: null,
        closureResolved: false,
        archived: false,
        blindSpots: ["snippet_only"],
        depCount: 20,
      });
      expect(result.decision).toBe("allow");
    });

    it("should block snippet_transplant with unknown license", () => {
      const result = evaluateImportPolicy({
        mode: "snippet_transplant",
        licenseSpdx: null,
        closureResolved: true,
        archived: false,
        blindSpots: [],
        depCount: 0,
      });
      expect(result.decision).toBe("block");
      expect(result.blockers.length).toBeGreaterThan(0);
    });

    it("should block GPL license for transplant", () => {
      const result = evaluateImportPolicy({
        mode: "vendor_with_attribution",
        licenseSpdx: "GPL-3.0-only",
        closureResolved: true,
        archived: false,
        blindSpots: [],
        depCount: 0,
      });
      expect(result.decision).toBe("block");
      expect(result.reason).toContain("copyleft");
    });

    it("should allow MIT license for transplant", () => {
      const result = evaluateImportPolicy({
        mode: "snippet_transplant",
        licenseSpdx: "MIT",
        closureResolved: true,
        archived: false,
        blindSpots: [],
        depCount: 0,
      });
      expect(result.decision).toBe("allow");
    });

    it("should warn on archived repo", () => {
      const result = evaluateImportPolicy({
        mode: "generate_inspired_by",
        licenseSpdx: "MIT",
        closureResolved: true,
        archived: true,
        blindSpots: [],
        depCount: 0,
      });
      expect(result.decision).toBe("warn");
      expect(result.warnings.some(w => w.includes("archived"))).toBe(true);
    });

    it("should block transplant when only snippet available", () => {
      const result = evaluateImportPolicy({
        mode: "snippet_transplant",
        licenseSpdx: "MIT",
        closureResolved: true,
        archived: false,
        blindSpots: ["snippet_only"],
        depCount: 0,
      });
      expect(result.decision).toBe("block");
      expect(result.blockers.some(b => b.includes("snippet"))).toBe(true);
    });

    it("should block transplant when closure not resolved", () => {
      const result = evaluateImportPolicy({
        mode: "snippet_transplant",
        licenseSpdx: "Apache-2.0",
        closureResolved: false,
        archived: false,
        blindSpots: [],
        depCount: 0,
      });
      expect(result.decision).toBe("block");
    });

    it("should warn on high dependency count", () => {
      const result = evaluateImportPolicy({
        mode: "generate_inspired_by",
        licenseSpdx: "MIT",
        closureResolved: true,
        archived: false,
        blindSpots: [],
        depCount: 15,
      });
      expect(result.decision).toBe("warn");
      expect(result.warnings.some(w => w.includes("dependency"))).toBe(true);
    });
  });

  describe("buildProvenanceManifest", () => {
    it("should build manifest with all fields", () => {
      const manifest = buildProvenanceManifest({
        repo: "owner/repo",
        path: "src/retry.ts",
        symbolName: "retryWithBackoff",
        sources: [{ source: "grep_app", query: "retry backoff" }],
        licenseSpdx: "MIT",
        hasFullCode: true,
        closureResolved: true,
        policyDecision: "allow",
      });

      expect(manifest.repo).toBe("owner/repo");
      expect(manifest.symbolName).toBe("retryWithBackoff");
      expect(manifest.repoLicense).toBe("MIT");
      expect(manifest.retrievalMode).toBe("closure");
      expect(manifest.importPolicy).toBe("allow");
      expect(manifest.discoveredVia).toHaveLength(1);
    });

    it("should detect retrieval mode correctly", () => {
      const snippet = buildProvenanceManifest({
        repo: "a/b", path: "x.ts", sources: [], licenseSpdx: null,
        hasFullCode: false, closureResolved: false, policyDecision: "warn",
      });
      expect(snippet.retrievalMode).toBe("snippet");

      const file = buildProvenanceManifest({
        repo: "a/b", path: "x.ts", sources: [], licenseSpdx: null,
        hasFullCode: true, closureResolved: false, policyDecision: "warn",
      });
      expect(file.retrievalMode).toBe("file");
    });
  });

  describe("generateAttribution", () => {
    it("should produce multi-line attribution comment", () => {
      const manifest = buildProvenanceManifest({
        repo: "owner/repo", path: "src/lib.ts", symbolName: "rateLimit",
        sources: [], licenseSpdx: "MIT", hasFullCode: true,
        closureResolved: true, policyDecision: "allow",
      });
      const attr = generateAttribution(manifest);

      expect(attr).toContain("owner/repo");
      expect(attr).toContain("MIT");
      expect(attr).toContain("rateLimit");
      expect(attr).toContain("ForgeMCP");
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  estimateTokens, selectTier, selectTruncationStrategy, truncateSmartly,
} from "@forgemcp/core";
import {
  buildL1Card, buildL2Capsule, buildL3Full, formatTieredResults,
} from "@forgemcp/core";
import type { TierableResult } from "@forgemcp/core";
import { compressToSignatures } from "@forgemcp/ast-intelligence";

// ─────────────────────────────────────────────────
// Token Estimation
// ─────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4) = 2
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });

  it("handles code-like content", () => {
    const code = "function foo(a: number, b: string): boolean { return a > 0; }";
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });
});

// ─────────────────────────────────────────────────
// Tier Selection
// ─────────────────────────────────────────────────

describe("selectTier", () => {
  it("returns L1 for many results in small budget", () => {
    expect(selectTier(20, 2000)).toBe("L1");
  });

  it("returns L2 for moderate results", () => {
    expect(selectTier(5, 2000)).toBe("L2");
  });

  it("returns L3 for few results in large budget", () => {
    expect(selectTier(2, 4000)).toBe("L3");
  });

  it("returns L1 for zero results", () => {
    expect(selectTier(0)).toBe("L1");
  });

  it("defaults to 4000 token budget", () => {
    // 4000/3 = 1333 < 1500 threshold → L2
    expect(selectTier(3)).toBe("L2");
    // 4000/1 = 4000 > 1500 → L3
    expect(selectTier(1)).toBe("L3");
  });
});

// ─────────────────────────────────────────────────
// Truncation Strategy
// ─────────────────────────────────────────────────

describe("selectTruncationStrategy", () => {
  it("passes through small content", () => {
    const s = selectTruncationStrategy(500);
    expect(s.head).toBe(500);
    expect(s.tail).toBe(0);
  });

  it("preserves head+tail for medium content", () => {
    const s = selectTruncationStrategy(3000);
    expect(s.head).toBe(500);
    expect(s.tail).toBe(200);
    expect(s.middleBudget).toBe(2300);
  });

  it("limits middle for large content", () => {
    const s = selectTruncationStrategy(50000);
    expect(s.head).toBe(500);
    expect(s.tail).toBe(200);
    expect(s.middleBudget).toBe(4000);
  });
});

// ─────────────────────────────────────────────────
// Smart Truncation
// ─────────────────────────────────────────────────

describe("truncateSmartly", () => {
  it("returns content unchanged when within budget", () => {
    const content = "line 1\nline 2\nline 3";
    const result = truncateSmartly(content, "test", { head: 1000, tail: 0, middleBudget: 0 });
    expect(result).toBe(content);
  });

  it("preserves head and tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: some content here`);
    const content = lines.join("\n");
    const result = truncateSmartly(content, "line 50", { head: 100, tail: 100, middleBudget: 200 });

    // Should contain first few lines
    expect(result).toContain("line 0:");
    // Should contain last few lines
    expect(result).toContain("line 99:");
    // Should mention omitted lines
    expect(result).toContain("omitted");
  });

  it("ranks middle lines by query relevance", () => {
    const lines = [
      "import { foo } from 'bar'",
      "const x = 1",
      "function rateLimiter() { ... }", // matches query
      "const y = 2",
      "const z = 3",
      "export default x",
    ];
    const content = lines.join("\n");
    const result = truncateSmartly(content, "rateLimiter", { head: 30, tail: 30, middleBudget: 50 });

    // The query-matching line should survive truncation
    expect(result).toContain("rateLimiter");
  });
});

// ─────────────────────────────────────────────────
// Tiered Response Builder
// ─────────────────────────────────────────────────

const sampleResult: TierableResult = {
  name: "parseConfig",
  kind: "function",
  language: "typescript",
  confidence: 0.92,
  signature: "(path: string) => Config",
  description: "Reads and validates TOML config from disk.",
  file: "src/config/parser.ts",
  repo: "acme/backend",
  lines: "42-87",
  callers: ["main", "loadApp", "resetState"],
  deps: ["fs", "toml", "zod"],
  sourceType: "ast-extract",
  code: "export function parseConfig(path: string): Config {\n  return parse(readFileSync(path));\n}",
  timesRecalled: 7,
};

describe("buildL1Card", () => {
  it("produces short output under 80 tokens", () => {
    const card = buildL1Card(sampleResult);
    expect(estimateTokens(card)).toBeLessThan(80);
    expect(card).toContain("parseConfig");
    expect(card).toContain("function");
    expect(card).toContain("92%");
  });
});

describe("buildL2Capsule", () => {
  it("includes description and deps", () => {
    const capsule = buildL2Capsule(sampleResult);
    expect(capsule).toContain("Reads and validates");
    expect(capsule).toContain("Deps: fs, toml, zod");
    expect(capsule).toContain("Callers: main, loadApp, resetState");
    expect(capsule).toContain("src/config/parser.ts:42-87");
    expect(estimateTokens(capsule)).toBeLessThan(300);
  });
});

describe("buildL3Full", () => {
  it("includes code block", () => {
    const full = buildL3Full(sampleResult);
    expect(full).toContain("```typescript");
    expect(full).toContain("parseConfig");
    expect(full).toContain("```");
  });

  it("truncates long code", () => {
    const longResult = { ...sampleResult, code: "x".repeat(5000) };
    const full = buildL3Full(longResult);
    expect(full).toContain("truncated");
    expect(full.length).toBeLessThan(6000);
  });
});

describe("formatTieredResults", () => {
  it("formats multiple results with tier header", () => {
    const results = [sampleResult, { ...sampleResult, name: "loadConfig" }];
    const output = formatTieredResults(results, "L1");
    expect(output).toContain("[2 results, L1 tier");
    expect(output).toContain("parseConfig");
    expect(output).toContain("loadConfig");
  });
});

// ─────────────────────────────────────────────────
// Signature Compression
// ─────────────────────────────────────────────────

describe("compressToSignatures", () => {
  it("strips function bodies, keeps signatures", () => {
    const source = [
      "import { z } from 'zod';",
      "",
      "/** Validates config. */",
      "export function validate(cfg: Config): Result {",
      "  const schema = z.object({ name: z.string() });",
      "  return schema.parse(cfg);",
      "}",
      "",
      "export function load(path: string): Config {",
      "  return JSON.parse(readFileSync(path));",
      "}",
    ].join("\n");

    const compressed = compressToSignatures(source, "typescript");
    expect(compressed).toContain("import");
    expect(compressed).toContain("validate");
    expect(compressed).toContain("load");
    // Should NOT contain implementation details
    expect(compressed).not.toContain("schema.parse");

    // Should be significantly shorter
    expect(compressed.length).toBeLessThan(source.length);
  });

  it("handles empty file gracefully", () => {
    const result = compressToSignatures("", "typescript");
    expect(result).toContain("no extractable symbols");
  });

  it("handles unparseable content", () => {
    const result = compressToSignatures("{{{{not code at all}}}}", "typescript");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

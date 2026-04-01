import { describe, it, expect } from "vitest";
import {
  buildL1Card,
  buildL2Capsule,
  buildL3Full,
  estimateTokens,
  timeSince,
  type CapsuleInput,
} from "@forgemcp/repo-memory/capsule-builder";

const sampleInput: CapsuleInput = {
  name: "parseConfig",
  kind: "function",
  language: "typescript",
  confidence: 92,
  signature: "(path: string) => Config",
  description: "Reads and validates a TOML configuration file from disk.",
  imports: ["fs", "toml", "zod"],
  timesRecalled: 7,
  lastRecalledAt: new Date(Date.now() - 3_600_000).toISOString(), // 1 hour ago
  sourceType: "ast-extract",
};

describe("buildL1Card", () => {
  it("produces short output under 80 tokens", () => {
    const card = buildL1Card(sampleInput);
    const tokens = estimateTokens(card);
    expect(tokens).toBeLessThan(80);
    expect(card).toContain("parseConfig");
    expect(card).toContain("function");
    expect(card).toContain("92%");
  });
});

describe("buildL2Capsule", () => {
  it("includes description and deps", () => {
    const l1 = buildL1Card(sampleInput);
    const l2 = buildL2Capsule(sampleInput, l1);
    expect(l2).toContain("Reads and validates");
    expect(l2).toContain("Deps: fs, toml, zod");
    expect(l2).toContain("Source: ast-extract");
  });
});

describe("buildL3Full", () => {
  it("includes code block", () => {
    const l1 = buildL1Card(sampleInput);
    const l2 = buildL2Capsule(sampleInput, l1);
    const code = 'function parseConfig(path: string): Config {\n  return parse(readFileSync(path, "utf-8"));\n}';
    const l3 = buildL3Full(sampleInput, l2, code);
    expect(l3).toContain("```typescript");
    expect(l3).toContain("parseConfig");
    expect(l3).toContain("```");
  });

  it("truncates long code at 4000 chars", () => {
    const l1 = buildL1Card(sampleInput);
    const l2 = buildL2Capsule(sampleInput, l1);
    const longCode = "x".repeat(5000);
    const l3 = buildL3Full(sampleInput, l2, longCode);
    expect(l3).toContain("// ... truncated");
    // The code portion should not contain the full 5000 chars
    const codeBlockMatch = l3.match(/```typescript\n([\s\S]*?)```/);
    expect(codeBlockMatch).toBeTruthy();
    const codeInBlock = codeBlockMatch![1]!;
    // 4000 chars of x + newline + truncation comment
    expect(codeInBlock.indexOf("x".repeat(4001))).toBe(-1);
  });
});

describe("estimateTokens", () => {
  it("returns reasonable estimates", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // 5 / 4 = 1.25 -> ceil = 2
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });
});

describe("timeSince", () => {
  it("returns human-readable strings", () => {
    const now = Date.now();
    // 5 minutes ago
    expect(timeSince(new Date(now - 5 * 60_000).toISOString())).toBe("5m ago");
    // 3 hours ago
    expect(timeSince(new Date(now - 3 * 3_600_000).toISOString())).toBe("3h ago");
    // 10 days ago
    expect(timeSince(new Date(now - 10 * 86_400_000).toISOString())).toBe("10d ago");
    // 60 days ago
    expect(timeSince(new Date(now - 60 * 86_400_000).toISOString())).toBe("2mo ago");
  });
});

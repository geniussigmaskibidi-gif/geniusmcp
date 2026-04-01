import { describe, it, expect } from "vitest";
import { chunkFile, type SymbolInfo } from "@forgemcp/db/chunker";

describe("Semantic Chunker", () => {
  it("produces file_header chunk from imports", () => {
    const content = [
      "// File header comment",
      'import { foo } from "bar";',
      'import { baz } from "qux";',
      "",
      "export function main() {",
      "  return foo() + baz();",
      "}",
    ].join("\n");

    const chunks = chunkFile(content, "src/main.ts", []);
    const headers = chunks.filter(c => c.kind === "file_header");
    expect(headers.length).toBe(1);
    expect(headers[0]!.importLines).toContain("import");
  });

  it("chunks by symbol boundaries", () => {
    const content = [
      "function alpha() { return 1; }",
      "",
      "function beta() { return 2; }",
    ].join("\n");

    const symbols: SymbolInfo[] = [
      { name: "alpha", kind: "function", exported: true, startLine: 0, endLine: 0,
        signature: "alpha()", docComment: null, code: "function alpha() { return 1; }" },
      { name: "beta", kind: "function", exported: true, startLine: 2, endLine: 2,
        signature: "beta()", docComment: null, code: "function beta() { return 2; }" },
    ];

    const chunks = chunkFile(content, "src/lib.ts", symbols);
    const bodies = chunks.filter(c => c.kind === "symbol_body");
    expect(bodies.length).toBe(2);
    expect(bodies[0]!.symbolName).toBe("alpha");
    expect(bodies[1]!.symbolName).toBe("beta");
  });

  it("splits large symbols into multiple chunks", () => {
    // Create a 200-line function
    const bodyLines = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`);
    const code = ["function big() {", ...bodyLines, "}"].join("\n");

    const symbols: SymbolInfo[] = [{
      name: "big", kind: "function", exported: true,
      startLine: 0, endLine: 201,
      signature: "big()", docComment: null, code,
    }];

    const chunks = chunkFile(code, "src/big.ts", symbols, { maxChunkLines: 50 });
    const bodies = chunks.filter(c => c.kind === "symbol_body");
    expect(bodies.length).toBeGreaterThan(1);
    // All should reference the same symbol
    for (const b of bodies) {
      expect(b.symbolName).toBe("big");
    }
  });

  it("emits fallback_window for uncovered regions", () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");

    // No symbols — entire file should be fallback windows
    const chunks = chunkFile(content, "src/data.txt", [], {
      fallbackWindowSize: 20,
      fallbackOverlap: 5,
    });

    const fallbacks = chunks.filter(c => c.kind === "fallback_window");
    expect(fallbacks.length).toBeGreaterThan(0);
    // Fallback windows should cover the file
    expect(fallbacks[0]!.lineStart).toBe(0);
  });

  it("detects test files by path", () => {
    const content = "describe('test', () => {});";
    const chunks = chunkFile(content, "tests/foo.test.ts", []);
    expect(chunks.every(c => c.isTest)).toBe(true);
  });

  it("detects generated files", () => {
    const content = [
      "// Auto-generated. Do not edit.",
      "const x = 1;",
    ].join("\n");
    const chunks = chunkFile(content, "gen/types.ts", []);
    expect(chunks.some(c => c.isGenerated)).toBe(true);
  });

  it("emits symbol_decl when signature exists", () => {
    const content = "/** Adds two numbers. */\nfunction add(a: number, b: number): number { return a + b; }";
    const symbols: SymbolInfo[] = [{
      name: "add", kind: "function", exported: true,
      startLine: 1, endLine: 1,
      signature: "add(a: number, b: number): number",
      docComment: "/** Adds two numbers. */",
      code: "function add(a: number, b: number): number { return a + b; }",
    }];

    const chunks = chunkFile(content, "src/math.ts", symbols);
    const decls = chunks.filter(c => c.kind === "symbol_decl");
    expect(decls.length).toBe(1);
    const decl = decls[0]!;
    expect(decl.symbolName).toBe("add");
    expect(decl.docComment).toContain("Adds two numbers");
    expect(decl.signature).toContain("add(a: number");
  });

  it("handles empty file gracefully", () => {
    const chunks = chunkFile("", "empty.ts", []);
    // Empty file may produce a minimal header chunk; should not crash
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});

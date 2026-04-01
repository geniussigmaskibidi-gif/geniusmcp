import { describe, it, expect, vi } from "vitest";
import {
  ParserRegistry,
  type ParserBackend,
  type ParseInput,
  type ParseOutput,
  type PrecisionTier,
} from "@forgemcp/ast-intelligence/parser-registry";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeBackend(
  id: string,
  precision: PrecisionTier,
  languages: string[],
): ParserBackend {
  return {
    id,
    version: "1.0.0",
    precision,
    supports: (lang: string) => languages.includes(lang),
    parse: vi.fn(async (input: ParseInput): Promise<ParseOutput> => ({
      symbols: [],
      diagnostics: [],
      precision,
      parserUsed: id,
      durationMs: 0,
    })),
  };
}

const INPUT: ParseInput = {
  blobSha: "abc123",
  content: "function foo() {}",
  path: "src/foo.ts",
  language: "typescript",
};

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("ParserRegistry", () => {
  it("sorts registered backends by precision priority (exact > parsed > heuristic)", () => {
    const registry = new ParserRegistry();
    const heuristic = makeBackend("regex", "heuristic", ["typescript"]);
    const exact = makeBackend("scip", "exact", ["typescript"]);
    const parsed = makeBackend("tree-sitter", "parsed", ["typescript"]);

    // Register in reverse priority order
    registry.register(heuristic);
    registry.register(exact);
    registry.register(parsed);

    const all = registry.all();
    expect(all[0]!.precision).toBe("exact");
    expect(all[1]!.precision).toBe("parsed");
    expect(all[2]!.precision).toBe("heuristic");
  });

  it("bestFor() returns the highest-precision backend for a language", () => {
    const registry = new ParserRegistry();
    const heuristic = makeBackend("regex", "heuristic", ["typescript", "python"]);
    const parsed = makeBackend("tree-sitter", "parsed", ["typescript"]);

    registry.register(heuristic);
    registry.register(parsed);

    const best = registry.bestFor("typescript");
    expect(best).not.toBeNull();
    expect(best!.id).toBe("tree-sitter");
    expect(best!.precision).toBe("parsed");
  });

  it("bestFor() returns null for an unsupported language", () => {
    const registry = new ParserRegistry();
    registry.register(makeBackend("scip", "exact", ["go"]));

    expect(registry.bestFor("brainfuck")).toBeNull();
  });

  it("parse() delegates to the correct backend", async () => {
    const registry = new ParserRegistry();
    const exact = makeBackend("scip", "exact", ["typescript"]);
    const heuristic = makeBackend("regex", "heuristic", ["typescript"]);

    registry.register(heuristic);
    registry.register(exact);

    await registry.parse(INPUT);

    expect(exact.parse).toHaveBeenCalledWith(INPUT);
    expect(heuristic.parse).not.toHaveBeenCalled();
  });

  it("parse() returns empty symbols with diagnostic for unsupported language", async () => {
    const registry = new ParserRegistry();
    registry.register(makeBackend("scip", "exact", ["go"]));

    const result = await registry.parse({
      ...INPUT,
      language: "cobol",
    });

    expect(result.symbols).toEqual([]);
    expect(result.parserUsed).toBe("none");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.severity).toBe("warning");
    expect(result.diagnostics[0]!.message).toContain("cobol");
  });

  it("parse() tracks durationMs", async () => {
    const registry = new ParserRegistry();
    const slow = makeBackend("slow-parser", "parsed", ["typescript"]);
    // Simulate a parse that takes some time
    (slow.parse as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: ParseInput): Promise<ParseOutput> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          symbols: [],
          diagnostics: [],
          precision: "parsed" as PrecisionTier,
          parserUsed: "slow-parser",
          durationMs: 0,
        };
      },
    );

    registry.register(slow);

    const result = await registry.parse(INPUT);

    expect(result.durationMs).toBeGreaterThanOrEqual(10);
    expect(result.parserUsed).toBe("slow-parser");
  });
});

// Build spec Section 3: "All parsers emit the same SymbolIR"
// Three precision tiers: exact (SCIP) > parsed (tree-sitter) > heuristic (regex)

import type { SymbolIR, SymbolKind } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────

export type PrecisionTier = "exact" | "parsed" | "heuristic";

const PRECISION_RANK: Record<PrecisionTier, number> = {
  exact: 3,      // SCIP: full semantic analysis
  parsed: 2,     // tree-sitter: structural AST
  heuristic: 1,  // regex: best-effort fallback
};

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────

export interface ParseInput {
  readonly blobSha: string;
  readonly content: string;
  readonly path: string;
  readonly language: string;
}

export interface ParseDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly line?: number;
}

export interface ParseOutput {
  readonly symbols: SymbolIR[];
  readonly diagnostics: ParseDiagnostic[];
  readonly precision: PrecisionTier;
  readonly parserUsed: string;
  readonly durationMs: number;
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────

export interface ParserBackend {
  readonly id: string;
  readonly version: string;
  readonly precision: PrecisionTier;
  supports(language: string): boolean;
  parse(input: ParseInput): Promise<ParseOutput>;
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────

export class ParserRegistry {
  private backends: ParserBackend[] = [];

  /**
   * Register a parser backend. The registry maintains backends sorted
   * by precision priority (exact > parsed > heuristic) so bestFor()
   * always returns the highest-precision option first.
   */
  register(backend: ParserBackend): void {
    this.backends.push(backend);
    this.backends.sort(
      (a, b) => PRECISION_RANK[b.precision] - PRECISION_RANK[a.precision],
    );
  }

  /** Returns all registered backends in priority order. */
  all(): readonly ParserBackend[] {
    return this.backends;
  }

  /**
   * Returns the highest-precision backend that supports the given language,
   * or null if no backend supports it.
   */
  bestFor(language: string): ParserBackend | null {
    for (const backend of this.backends) {
      if (backend.supports(language)) {
        return backend;
      }
    }
    return null;
  }

  /**
   * Parse input using the best available backend for the language.
   * If no backend supports the language, returns empty symbols with
   * a warning diagnostic.
   */
  async parse(input: ParseInput): Promise<ParseOutput> {
    const backend = this.bestFor(input.language);

    if (!backend) {
      return {
        symbols: [],
        diagnostics: [
          {
            severity: "warning",
            message: `No parser backend supports language "${input.language}"`,
          },
        ],
        precision: "heuristic",
        parserUsed: "none",
        durationMs: 0,
      };
    }

    const start = performance.now();
    const result = await backend.parse(input);
    const durationMs = performance.now() - start;

    return {
      ...result,
      durationMs,
    };
  }
}

// Research: Zoekt symbol-aware chunking, Sourcegraph structural chunks.
// Design: Chunk at symbol boundaries, not arbitrary line windows.
// Chunk types: symbol_decl, symbol_body, import_block, test_block,
//              doc_block, file_header, fallback_window.

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ChunkKind =
  | "symbol_decl"       // declaration + signature + doc comment
  | "symbol_body"       // function/class body
  | "import_block"      // import/require statements
  | "test_block"        // test function body
  | "doc_block"         // standalone documentation
  | "file_header"       // first N lines (path + imports + top comment)
  | "fallback_window";  // sliding window for uncovered regions

export interface CodeChunk {
  readonly kind: ChunkKind;
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly symbolName?: string;
  readonly qualifiedName?: string;
  readonly signature?: string;
  readonly docComment?: string;
  readonly importLines?: string;
  readonly isTest: boolean;
  readonly isGenerated: boolean;
}

export interface ChunkOptions {
  /** Max lines per chunk (default 120) */
  maxChunkLines: number;
  /** Max bytes per chunk (default 8192) */
  maxChunkBytes: number;
  /** Fallback window size for uncovered regions (default 40) */
  fallbackWindowSize: number;
  /** Overlap between fallback windows (default 10) */
  fallbackOverlap: number;
}

const DEFAULT_OPTS: ChunkOptions = {
  maxChunkLines: 120,
  maxChunkBytes: 8192,
  fallbackWindowSize: 40,
  fallbackOverlap: 10,
};

// ─────────────────────────────────────────────────────────────
// Symbol info (minimal interface to avoid circular dep)
// ─────────────────────────────────────────────────────────────

export interface SymbolInfo {
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string | null;
  readonly docComment: string | null;
  readonly code: string;
}

// ─────────────────────────────────────────────────────────────
// Main chunking function
// ─────────────────────────────────────────────────────────────

/**
 * Chunk a source file into semantic search units.
 *
 * Strategy:
 *   1. Emit file_header (first comment block + imports, max 50 lines)
 *   2. For each symbol: emit symbol_decl + symbol_body
 *   3. For uncovered regions: emit fallback_window (sliding window)
 */
export function chunkFile(
  content: string,
  filePath: string,
  symbols: SymbolInfo[],
  opts: Partial<ChunkOptions> = {},
): CodeChunk[] {
  const o: ChunkOptions = { ...DEFAULT_OPTS, ...opts };
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  const testFile = isTestFile(filePath);
  const generated = isGeneratedFile(lines);

  // ── 1. File header ──
  const headerEnd = findHeaderEnd(lines);
  if (headerEnd > 0) {
    const importText = lines.slice(0, headerEnd)
      .filter(l => /^\s*(import|require|from|export\s*\{)/.test(l))
      .join("\n");

    chunks.push({
      kind: "file_header",
      text: lines.slice(0, headerEnd).join("\n"),
      lineStart: 0,
      lineEnd: headerEnd - 1,
      importLines: importText || undefined,
      isTest: testFile,
      isGenerated: generated,
    });
  }

  // ── 2. Symbol-based chunks ──
  for (const sym of symbols) {
    // Declaration chunk (signature + doc — used by BM25 symbol lane)
    if (sym.signature || sym.docComment) {
      chunks.push({
        kind: "symbol_decl",
        text: [sym.docComment, sym.signature].filter(Boolean).join("\n"),
        lineStart: sym.startLine,
        lineEnd: sym.startLine + (sym.signature?.split("\n").length ?? 1),
        symbolName: sym.name,
        signature: sym.signature ?? undefined,
        docComment: sym.docComment ?? undefined,
        isTest: testFile || isTestSymbol(sym.name),
        isGenerated: generated,
      });
    }

    // Body chunk (may need splitting for large symbols)
    const bodyLines = sym.endLine - sym.startLine + 1;
    const isTest = testFile || isTestSymbol(sym.name);
    const kind: ChunkKind = isTest ? "test_block" : "symbol_body";

    if (bodyLines <= o.maxChunkLines && Buffer.byteLength(sym.code) <= o.maxChunkBytes) {
      chunks.push({
        kind,
        text: sym.code,
        lineStart: sym.startLine,
        lineEnd: sym.endLine,
        symbolName: sym.name,
        isTest,
        isGenerated: generated,
      });
    } else {
      const codeLines = sym.code.split("\n");
      for (let i = 0; i < codeLines.length; i += o.maxChunkLines) {
        const end = Math.min(i + o.maxChunkLines, codeLines.length);
        chunks.push({
          kind,
          text: codeLines.slice(i, end).join("\n"),
          lineStart: sym.startLine + i,
          lineEnd: sym.startLine + end - 1,
          symbolName: sym.name,
          isTest,
          isGenerated: generated,
        });
      }
    }
  }

  // ── 3. Fallback: sliding windows for uncovered regions ──
  const covered = new Set<number>();
  for (const ch of chunks) {
    for (let i = ch.lineStart; i <= ch.lineEnd && i < lines.length; i++) {
      covered.add(i);
    }
  }

  const uncovered = findUncoveredRanges(lines.length, covered);
  for (const [start, end] of uncovered) {
    if (end - start < 3) continue; // skip tiny gaps

    const step = o.fallbackWindowSize - o.fallbackOverlap;
    for (let i = start; i <= end; i += step) {
      const windowEnd = Math.min(i + o.fallbackWindowSize - 1, end);
      chunks.push({
        kind: "fallback_window",
        text: lines.slice(i, windowEnd + 1).join("\n"),
        lineStart: i,
        lineEnd: windowEnd,
        isTest: testFile,
        isGenerated: generated,
      });
      if (windowEnd >= end) break;
    }
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Find where the file header ends (comments + imports) */
function findHeaderEnd(lines: string[]): number {
  let i = 0;
  // Skip leading blank lines and comments
  while (i < lines.length && i < 50) {
    const trimmed = lines[i]!.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("*/") ||
      trimmed.startsWith("#!")  // shebang
    ) {
      i++;
      continue;
    }
    // Include import/require/export lines
    if (/^(import|require|export\s*\{|from\s)/.test(trimmed)) {
      i++;
      continue;
    }
    break;
  }
  return Math.min(i, 50);
}

/** Check if file is a test file by path convention */
function isTestFile(path: string): boolean {
  return /\.(test|spec|_test)\.\w+$/.test(path) ||
    /\/__tests__\//.test(path) ||
    /\/test\//.test(path);
}

/** Check if a symbol name indicates a test */
function isTestSymbol(name: string): boolean {
  return /^(test|it|describe|expect|should|spec|assert)/i.test(name);
}

/** Check if file is auto-generated by looking at first 5 lines */
function isGeneratedFile(lines: string[]): boolean {
  const header = lines.slice(0, 5).join("\n").toLowerCase();
  return /generated|auto-generated|do not edit|machine generated/.test(header);
}

/** Find contiguous uncovered line ranges */
function findUncoveredRanges(totalLines: number, covered: Set<number>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;

  for (let i = 0; i < totalLines; i++) {
    if (!covered.has(i)) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        ranges.push([start, i - 1]);
        start = -1;
      }
    }
  }
  if (start !== -1) ranges.push([start, totalLines - 1]);
  return ranges;
}

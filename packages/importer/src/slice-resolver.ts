// When importing a function, resolve all local dependencies to create
// the minimum viable importable unit.
// Research: Program slicing (Weiser 1981), dependency closure algorithms.

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface SliceSymbol {
  readonly uid: string;
  readonly name: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
  readonly exported: boolean;
  readonly imports: string[];
}

export interface SliceEdge {
  readonly srcUid: string;
  readonly dstUid: string;
  readonly kind: "calls" | "references" | "imports" | "extends";
}

export interface ImportSlice {
  /** The primary symbol being imported */
  readonly primarySymbol: SliceSymbol;
  /** Local helper symbols needed (types, constants, utilities) */
  readonly localDependencies: SliceSymbol[];
  /** External npm packages / modules needed */
  readonly externalImports: string[];
  /** Total lines of all symbols in the slice */
  readonly totalLines: number;
  /** True if no external deps needed */
  readonly selfContained: boolean;
  /** Depth of the dependency tree */
  readonly maxDepth: number;
}

// ─────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the minimum import closure for a symbol.
 *
 * Algorithm:
 *   1. BFS from primary symbol following calls/references/imports edges
 *   2. Collect all reachable local symbols up to maxDepth
 *   3. Track external imports (unresolved destinations)
 *   4. Compute total lines and self-contained status
 */
export function resolveSliceClosure(
  primaryUid: string,
  allSymbols: SliceSymbol[],
  edges: SliceEdge[],
  maxDepth = 3,
): ImportSlice | null {
  const symbolMap = new Map(allSymbols.map(s => [s.uid, s]));
  const primary = symbolMap.get(primaryUid);
  if (!primary) return null;

  const visited = new Set<string>();
  const localDeps: SliceSymbol[] = [];
  const externalImports = new Set<string>();

  const queue: Array<{ uid: string; depth: number }> = [{ uid: primaryUid, depth: 0 }];
  visited.add(primaryUid);
  let actualMaxDepth = 0;

  while (queue.length > 0) {
    const { uid, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    actualMaxDepth = Math.max(actualMaxDepth, depth);

    // Find outgoing edges
    const outEdges = edges.filter(e => e.srcUid === uid);

    for (const edge of outEdges) {
      if (visited.has(edge.dstUid)) continue;
      visited.add(edge.dstUid);

      const target = symbolMap.get(edge.dstUid);
      if (target) {
        // Local dependency — add to slice
        localDeps.push(target);
        queue.push({ uid: edge.dstUid, depth: depth + 1 });
      } else {
        // External import — record package name
        externalImports.add(edge.dstUid);
      }
    }

    // Also collect external imports from the symbol's own import list
    const sym = symbolMap.get(uid);
    if (sym) {
      for (const imp of sym.imports) {
        if (!symbolMap.has(imp)) {
          externalImports.add(imp);
        }
      }
    }
  }

  const allInSlice = [primary, ...localDeps];
  const totalLines = allInSlice.reduce(
    (sum, s) => sum + (s.endLine - s.startLine + 1), 0
  );

  return {
    primarySymbol: primary,
    localDependencies: localDeps,
    externalImports: [...externalImports],
    totalLines,
    selfContained: externalImports.size === 0,
    maxDepth: actualMaxDepth,
  };
}

/**
 * Check if an import slice is within acceptable size limits.
 */
export function isSliceAcceptable(
  slice: ImportSlice,
  opts?: { maxLines?: number; maxDeps?: number; maxExternalImports?: number },
): { acceptable: boolean; reasons: string[] } {
  const maxLines = opts?.maxLines ?? 200;
  const maxDeps = opts?.maxDeps ?? 10;
  const maxExternalImports = opts?.maxExternalImports ?? 5;
  const reasons: string[] = [];

  if (slice.totalLines > maxLines) {
    reasons.push(`Slice is ${slice.totalLines} lines (max ${maxLines})`);
  }
  if (slice.localDependencies.length > maxDeps) {
    reasons.push(`${slice.localDependencies.length} local dependencies (max ${maxDeps})`);
  }
  if (slice.externalImports.length > maxExternalImports) {
    reasons.push(`${slice.externalImports.length} external imports (max ${maxExternalImports})`);
  }

  return { acceptable: reasons.length === 0, reasons };
}

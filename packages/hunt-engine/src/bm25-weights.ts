
/** Per-field boost weights used by the BM25F scoring function. */
export interface BM25FWeights {
  symbolName: number;
  qualifiedName: number;
  signature: number;
  docComment: number;
  filePath: number;
  importLines: number;
  codeText: number;
}

export const DEFAULT_WEIGHTS: BM25FWeights = {
  symbolName: 10,
  qualifiedName: 6,
  signature: 4,
  docComment: 2,
  filePath: 3,
  importLines: 1,
  codeText: 1,
} as const;

export const LANGUAGE_WEIGHTS: Record<string, Partial<BM25FWeights>> = {
  typescript: { qualifiedName: 8, signature: 5, docComment: 3 },
  python: { docComment: 4, signature: 3, filePath: 4 },
  go: { qualifiedName: 8, filePath: 5 },
  rust: { qualifiedName: 9, filePath: 4 },
};

export function weightsFor(language: string): BM25FWeights {
  const overrides = LANGUAGE_WEIGHTS[language.toLowerCase()];
  if (!overrides) {
    return { ...DEFAULT_WEIGHTS };
  }
  return { ...DEFAULT_WEIGHTS, ...overrides };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a value to the [0, 1] range. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ---------------------------------------------------------------------------
// Lexical score
// ---------------------------------------------------------------------------

export interface LexicalScoreInput {
  rrfScore: number;
  exactSymbolBonus: number;
  pathRoleBonus: number;
  testAdjacencyBonus: number;
}

export function computeLexicalScore(input: LexicalScoreInput): number {
  const raw =
    0.65 * input.rrfScore +
    0.20 * input.exactSymbolBonus +
    0.10 * input.pathRoleBonus +
    0.05 * input.testAdjacencyBonus;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// Structural score
// ---------------------------------------------------------------------------

export interface StructuralScoreInput {
  qnameMatch: number;
  signatureMatch: number;
  shapeMatch: number;
  graphContextMatch: number;
  enclosingRoleMatch: number;
  precisionBonus: number;
}

export function computeStructuralScore(input: StructuralScoreInput): number {
  const raw =
    0.30 * input.qnameMatch +
    0.20 * input.signatureMatch +
    0.20 * input.shapeMatch +
    0.15 * input.graphContextMatch +
    0.10 * input.enclosingRoleMatch +
    0.05 * input.precisionBonus;
  return clamp01(raw);
}

// ---------------------------------------------------------------------------
// Composite retrieval score
// ---------------------------------------------------------------------------

export interface RetrievalScoreInput {
  lexicalScore: number;
  structuralScore: number;
  semanticScore?: number;
  semanticEnabled: boolean;
}

// When semantic is enabled:  0.50*lexical + 0.35*structural + 0.15*semantic
// When semantic is disabled: normalize to 0.588*lexical + 0.412*structural
export function computeRetrievalScore(input: RetrievalScoreInput): number {
  let raw: number;
  if (input.semanticEnabled && input.semanticScore !== undefined) {
    raw =
      0.50 * input.lexicalScore +
      0.35 * input.structuralScore +
      0.15 * input.semanticScore;
  } else {
    raw =
      0.588 * input.lexicalScore +
      0.412 * input.structuralScore;
  }
  return clamp01(raw);
}

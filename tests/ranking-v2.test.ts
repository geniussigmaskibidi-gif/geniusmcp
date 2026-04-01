import { describe, it, expect } from "vitest";
import {
  weightsFor,
  DEFAULT_WEIGHTS,
} from "@forgemcp/hunt-engine/bm25-weights";
import {
  computeRetrievalScore,
  computeLexicalScore,
  computeStructuralScore,
} from "@forgemcp/hunt-engine/retrieval-scorer";

// ---------------------------------------------------------------------------
// BM25F weights
// ---------------------------------------------------------------------------

describe("weightsFor", () => {
  it("returns default weights for an unknown language", () => {
    const w = weightsFor("cobol");
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });

  it("returns merged weights for typescript", () => {
    const w = weightsFor("typescript");
    expect(w.symbolName).toBe(10); // default kept
    expect(w.qualifiedName).toBe(8); // overridden
    expect(w.signature).toBe(5); // overridden
    expect(w.docComment).toBe(3); // overridden
    expect(w.filePath).toBe(3); // default kept
    expect(w.importLines).toBe(1); // default kept
    expect(w.codeText).toBe(1); // default kept
  });
});

// ---------------------------------------------------------------------------
// Retrieval scorer
// ---------------------------------------------------------------------------

describe("computeRetrievalScore", () => {
  it("computes weighted score with semantic enabled", () => {
    const score = computeRetrievalScore({
      lexicalScore: 1.0,
      structuralScore: 1.0,
      semanticScore: 1.0,
      semanticEnabled: true,
    });
    // 0.50 + 0.35 + 0.15 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("computes normalized score with semantic disabled", () => {
    const score = computeRetrievalScore({
      lexicalScore: 1.0,
      structuralScore: 1.0,
      semanticEnabled: false,
    });
    // 0.588 + 0.412 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("handles partial inputs with semantic disabled", () => {
    const score = computeRetrievalScore({
      lexicalScore: 0.5,
      structuralScore: 0.5,
      semanticEnabled: false,
    });
    // 0.588*0.5 + 0.412*0.5 = 0.5
    expect(score).toBeCloseTo(0.5, 5);
  });
});

describe("computeLexicalScore", () => {
  it("sums weighted components", () => {
    const score = computeLexicalScore({
      rrfScore: 1.0,
      exactSymbolBonus: 1.0,
      pathRoleBonus: 1.0,
      testAdjacencyBonus: 1.0,
    });
    // 0.65 + 0.20 + 0.10 + 0.05 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("weights components correctly", () => {
    const score = computeLexicalScore({
      rrfScore: 0.8,
      exactSymbolBonus: 0.5,
      pathRoleBonus: 0.3,
      testAdjacencyBonus: 0.2,
    });
    // 0.65*0.8 + 0.20*0.5 + 0.10*0.3 + 0.05*0.2 = 0.52 + 0.10 + 0.03 + 0.01 = 0.66
    expect(score).toBeCloseTo(0.66, 5);
  });
});

describe("computeStructuralScore", () => {
  it("sums weighted components", () => {
    const score = computeStructuralScore({
      qnameMatch: 1.0,
      signatureMatch: 1.0,
      shapeMatch: 1.0,
      graphContextMatch: 1.0,
      enclosingRoleMatch: 1.0,
      precisionBonus: 1.0,
    });
    // 0.30 + 0.20 + 0.20 + 0.15 + 0.10 + 0.05 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it("weights components correctly", () => {
    const score = computeStructuralScore({
      qnameMatch: 0.9,
      signatureMatch: 0.7,
      shapeMatch: 0.6,
      graphContextMatch: 0.4,
      enclosingRoleMatch: 0.3,
      precisionBonus: 0.1,
    });
    // 0.30*0.9 + 0.20*0.7 + 0.20*0.6 + 0.15*0.4 + 0.10*0.3 + 0.05*0.1
    // = 0.27 + 0.14 + 0.12 + 0.06 + 0.03 + 0.005 = 0.625
    expect(score).toBeCloseTo(0.625, 5);
  });
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("score clamping", () => {
  it("clamps lexical score to [0, 1]", () => {
    const score = computeLexicalScore({
      rrfScore: 2.0,
      exactSymbolBonus: 2.0,
      pathRoleBonus: 2.0,
      testAdjacencyBonus: 2.0,
    });
    expect(score).toBe(1);
  });

  it("clamps structural score to [0, 1]", () => {
    const score = computeStructuralScore({
      qnameMatch: 5.0,
      signatureMatch: 5.0,
      shapeMatch: 5.0,
      graphContextMatch: 5.0,
      enclosingRoleMatch: 5.0,
      precisionBonus: 5.0,
    });
    expect(score).toBe(1);
  });

  it("clamps retrieval score to [0, 1]", () => {
    const score = computeRetrievalScore({
      lexicalScore: 3.0,
      structuralScore: 3.0,
      semanticScore: 3.0,
      semanticEnabled: true,
    });
    expect(score).toBe(1);
  });

  it("clamps negative inputs to 0", () => {
    const score = computeLexicalScore({
      rrfScore: -1.0,
      exactSymbolBonus: -1.0,
      pathRoleBonus: -1.0,
      testAdjacencyBonus: -1.0,
    });
    expect(score).toBe(0);
  });
});

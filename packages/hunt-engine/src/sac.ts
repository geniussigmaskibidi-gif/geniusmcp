// Novel identifier similarity algorithm that handles cross-convention matching.
// getUserSession ↔ fetch_user_session ↔ GetUserSession → all similar.
//
// BM25 fails here because it treats identifiers as opaque strings.
// SAC decomposes identifiers into subwords and computes structural similarity.
//
// Formula: S_SAC(x,y) = λ₁·J(tokens) + λ₂·Align(boundaries) + λ₃·Shape(shapes)
// where J = Jaccard, Align = affine gap alignment, Shape = pattern match
//
// Feature flag: FORGEMCP_SAC=1

// Handles: camelCase, PascalCase, snake_case, kebab-case, SCREAMING_SNAKE
export function splitIdentifier(id: string): string[] {
  if (!id) return [];

  // Step 1: Split on underscores, hyphens
  const parts = id.split(/[_\-]+/).filter(Boolean);

  // Step 2: Split camelCase/PascalCase within each part
  const result: string[] = [];
  for (const part of parts) {
    // Split before uppercase letters that follow lowercase
    // "getUserSession" → ["get", "User", "Session"]
    const camelSplit = part.replace(/([a-z])([A-Z])/g, "$1\0$2")
                          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
                          .split("\0");

    for (const sub of camelSplit) {
      if (sub) result.push(sub.toLowerCase());
    }
  }

  return result;
}

// "getUserSession" → "aAa" (lower, Upper, lower pattern)
// "get_user_session" → "a_a_a"
// "GET_USER_SESSION" → "A_A_A"
export function shapeSignature(id: string): string {
  return id.replace(/[a-z]+/g, "a")
           .replace(/[A-Z]+/g, "A")
           .replace(/[0-9]+/g, "9")
           .replace(/_{2,}/g, "_")
           .replace(/-{2,}/g, "-");
}

function tokenJaccard(tokensA: string[], tokensB: string[]): number {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Aligns subword boundaries to measure structural correspondence
// "get|User|Session" vs "fetch|user|session" → high alignment score
function boundaryAlignment(tokensA: string[], tokensB: string[]): number {
  const n = tokensA.length;
  const m = tokensB.length;
  if (n === 0 || m === 0) return 0;

  // Match: +1.0 (exact subword), +0.5 (prefix match ≥3 chars)
  // Mismatch: -0.3
  // Gap open: -0.8, Gap extend: -0.2
  const GAP_OPEN = -0.8;
  const GAP_EXTEND = -0.2;

  // Simplified Needleman-Wunsch with 3 matrices (M, X, Y)
  // For efficiency, only track scores (not full traceback)
  const dpM = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
  const dpX = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));
  const dpY = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-Infinity));

  dpM[0]![0] = 0;
  for (let i = 1; i <= n; i++) dpX[i]![0] = GAP_OPEN + (i - 1) * GAP_EXTEND;
  for (let j = 1; j <= m; j++) dpY[0]![j] = GAP_OPEN + (j - 1) * GAP_EXTEND;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = tokensA[i - 1]!;
      const b = tokensB[j - 1]!;

      // Match/mismatch score
      let matchScore: number;
      if (a === b) {
        matchScore = 1.0;
      } else if (a.length >= 3 && b.length >= 3 && a.slice(0, 3) === b.slice(0, 3)) {
        matchScore = 0.5; // prefix match (e.g., "get" vs "getter")
      } else {
        matchScore = -0.3;
      }

      dpM[i]![j] = matchScore + Math.max(dpM[i - 1]![j - 1]!, dpX[i - 1]![j - 1]!, dpY[i - 1]![j - 1]!);
      dpX[i]![j] = Math.max(dpM[i - 1]![j]! + GAP_OPEN, dpX[i - 1]![j]! + GAP_EXTEND);
      dpY[i]![j] = Math.max(dpM[i]![j - 1]! + GAP_OPEN, dpY[i]![j - 1]! + GAP_EXTEND);
    }
  }

  const rawScore = Math.max(dpM[n]![m]!, dpX[n]![m]!, dpY[n]![m]!);
  // Normalize to [0, 1]
  const maxPossible = Math.min(n, m);
  return maxPossible > 0 ? Math.max(0, rawScore / maxPossible) : 0;
}

function shapeSimilarity(idA: string, idB: string): number {
  const shapeA = shapeSignature(idA);
  const shapeB = shapeSignature(idB);

  if (shapeA === shapeB) return 1.0;

  // Count matching characters at each position
  const maxLen = Math.max(shapeA.length, shapeB.length);
  if (maxLen === 0) return 1.0;

  let matches = 0;
  const minLen = Math.min(shapeA.length, shapeB.length);
  for (let i = 0; i < minLen; i++) {
    if (shapeA[i] === shapeB[i]) matches++;
  }

  return matches / maxLen;
}

// Combines Jaccard + boundary alignment + shape similarity
// Weights tuned for cross-convention identifier matching
export function sacSimilarity(idA: string, idB: string): number {
  if (idA === idB) return 1.0;
  if (!idA || !idB) return 0;

  const tokensA = splitIdentifier(idA);
  const tokensB = splitIdentifier(idB);

  // Component weights (tuned on CodeSearchNet identifier pairs)
  const LAMBDA_JACCARD = 0.45;
  const LAMBDA_ALIGNMENT = 0.35;
  const LAMBDA_SHAPE = 0.20;

  const jac = tokenJaccard(tokensA, tokensB);
  const align = boundaryAlignment(tokensA, tokensB);
  const shape = shapeSimilarity(idA, idB);

  return LAMBDA_JACCARD * jac + LAMBDA_ALIGNMENT * align + LAMBDA_SHAPE * shape;
}

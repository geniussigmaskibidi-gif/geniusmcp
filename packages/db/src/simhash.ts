// Research: Charikar 2002, Google SimHash for web-scale dedup.
// Use cases:
//   1. Fork/vendor dedup hints in genius.find_best
//   2. Memory dedup of nearly-identical local edits
//   3. Cluster collapse in ranking
// Hamming distance <= 3 ~ near-duplicate (empirical threshold from literature).

/**
 * Compute 64-bit SimHash from text content.
 *
 * Algorithm:
 *   1. Normalize text (lowercase, strip comments, collapse whitespace)
 *   2. Extract bigram shingles as features
 *   3. Hash each shingle with FNV-1a 64-bit
 *   4. Accumulate weighted bit-vectors (+1 for set bits, -1 for unset)
 *   5. Threshold: positive → 1, non-positive → 0
 *
 * Returns BigInt (64-bit fingerprint).
 */
export function simhash64(text: string): bigint {
  const normalized = text
    .replace(/\/\/.*$/gm, "")           // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/#.*$/gm, "")              // Python comments
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

  if (normalized.length < 4) return 0n;

  const tokens = normalized.split(/\s+/);
  if (tokens.length < 2) return fnv1a64(normalized);

  const shingles: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    shingles.push(tokens[i]! + " " + tokens[i + 1]!);
  }

  const v = new Float64Array(64);

  for (let s = 0; s < shingles.length; s++) {
    const hash = fnv1a64(shingles[s]!);
    for (let i = 0; i < 64; i++) {
      if ((hash >> BigInt(i)) & 1n) {
        v[i]! += 1;
      } else {
        v[i]! -= 1;
      }
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i]! > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

/**
 * Hamming distance between two SimHash values.
 * Counts the number of differing bits — O(popcount(XOR)).
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Check if two documents are near-duplicates.
 * Default threshold: Hamming distance <= 3 (from Google's dedup research).
 */
export function isNearDuplicate(a: bigint, b: bigint, threshold = 3): boolean {
  return hammingDistance(a, b) <= threshold;
}

/**
 * FNV-1a 64-bit hash — fast, well-distributed, zero-dependency.
 * Used internally for shingle hashing. Not cryptographic.
 */
function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;  // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);  // FNV prime
  }
  return hash;
}

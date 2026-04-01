// From: Schleimer, Wilkerson, Aiken (2003) "Winnowing: Local Algorithms for Document Fingerprinting"
// Used for 3-level dedup: exact SHA → normalized AST hash → winnowing families
//
// Algorithm:
//   1. Normalize code (strip whitespace, lowercase identifiers, keep keywords)
//   2. Compute k-gram hashes (rolling hash, k=5)
//   3. Winnowing: in sliding window of size w=4, select minimum hash
//   4. Result: compact fingerprint (~10% of original size)
//   5. Compare by Jaccard similarity of fingerprint sets

import { createHash } from "node:crypto";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface WinnowingFingerprint {
  readonly hashes: number[];      // selected minimum hashes
  readonly kgramSize: number;
  readonly windowSize: number;
  readonly normalizedLength: number;  // length of normalized code
}

// ─────────────────────────────────────────────────────────────
// Code normalization (language-agnostic)
// ─────────────────────────────────────────────────────────────

const KEYWORDS = new Set([
  // JS/TS
  "function", "class", "const", "let", "var", "if", "else", "for", "while",
  "return", "import", "export", "async", "await", "try", "catch", "throw",
  "new", "this", "switch", "case", "break", "continue", "default",
  // Python
  "def", "class", "return", "if", "elif", "else", "for", "while", "import",
  "from", "try", "except", "raise", "with", "as", "yield", "lambda",
  // Go
  "func", "type", "struct", "interface", "return", "if", "else", "for",
  "range", "switch", "case", "select", "go", "defer", "chan",
  // Rust
  "fn", "struct", "enum", "impl", "trait", "match", "if", "else", "for",
  "while", "loop", "return", "let", "mut", "pub", "use", "mod",
]);

export function normalizeCode(code: string): string {
  // Strip string literals
  let normalized = code.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, "_S_");
  // Strip comments
  normalized = normalized.replace(/\/\/.*$/gm, "");
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, "");
  normalized = normalized.replace(/#.*$/gm, "");
  // Strip number literals
  normalized = normalized.replace(/\b\d+(\.\d+)?\b/g, "_N_");
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();
  // Lowercase non-keywords (keywords stay, identifiers become lowercase)
  normalized = normalized.replace(/\b[a-zA-Z_]\w*\b/g, (m) =>
    KEYWORDS.has(m) ? m : m.toLowerCase(),
  );
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// K-gram hashing (rolling polynomial hash)
// ─────────────────────────────────────────────────────────────

function kgramHashes(text: string, k: number): number[] {
  if (text.length < k) return [];
  const hashes: number[] = [];
  for (let i = 0; i <= text.length - k; i++) {
    // Simple polynomial hash (FNV-1a inspired)
    let h = 2166136261;
    for (let j = 0; j < k; j++) {
      h = Math.imul(h ^ text.charCodeAt(i + j), 16777619);
    }
    hashes.push(h >>> 0); // unsigned 32-bit
  }
  return hashes;
}

// ─────────────────────────────────────────────────────────────
// Winnowing: select minimum hash in each window
// ─────────────────────────────────────────────────────────────

export function computeFingerprint(
  code: string,
  k: number = 5,
  w: number = 4,
): WinnowingFingerprint {
  const normalized = normalizeCode(code);
  const hashes = kgramHashes(normalized, k);

  if (hashes.length === 0) {
    return { hashes: [], kgramSize: k, windowSize: w, normalizedLength: normalized.length };
  }

  // Winnowing: slide window of size w, pick minimum in each window
  const selected: number[] = [];
  let prevMinIdx = -1;

  for (let i = 0; i <= hashes.length - w; i++) {
    // Find minimum in window [i, i+w)
    let minVal = hashes[i]!;
    let minIdx = i;
    for (let j = i + 1; j < i + w; j++) {
      if (hashes[j]! <= minVal) {
        minVal = hashes[j]!;
        minIdx = j;
      }
    }
    // Only add if this is a new minimum (avoids duplicates)
    if (minIdx !== prevMinIdx) {
      selected.push(minVal);
      prevMinIdx = minIdx;
    }
  }

  return {
    hashes: selected,
    kgramSize: k,
    windowSize: w,
    normalizedLength: normalized.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Jaccard similarity between two fingerprints
// ─────────────────────────────────────────────────────────────

export function jaccardSimilarity(a: WinnowingFingerprint, b: WinnowingFingerprint): number {
  if (a.hashes.length === 0 && b.hashes.length === 0) return 1;
  if (a.hashes.length === 0 || b.hashes.length === 0) return 0;

  const setA = new Set(a.hashes);
  const setB = new Set(b.hashes);

  let intersection = 0;
  for (const h of setA) {
    if (setB.has(h)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─────────────────────────────────────────────────────────────
// Cluster fingerprints by Jaccard similarity
// ─────────────────────────────────────────────────────────────

export interface FingerprintCluster {
  readonly id: string;
  readonly members: Array<{ id: string; similarity: number }>;
  readonly centroidId: string;
  readonly size: number;
}

export function clusterByJaccard(
  items: Array<{ id: string; fingerprint: WinnowingFingerprint }>,
  threshold: number = 0.6,
): FingerprintCluster[] {
  // Simple single-pass greedy clustering
  const clusters: FingerprintCluster[] = [];
  const assigned = new Set<string>();

  // Sort by fingerprint size descending (larger = more representative)
  const sorted = [...items].sort((a, b) => b.fingerprint.hashes.length - a.fingerprint.hashes.length);

  for (const item of sorted) {
    if (assigned.has(item.id)) continue;

    // Try to merge into existing cluster
    let merged = false;
    for (const cluster of clusters) {
      const centroid = items.find((i) => i.id === cluster.centroidId);
      if (!centroid) continue;

      const sim = jaccardSimilarity(item.fingerprint, centroid.fingerprint);
      if (sim >= threshold) {
        (cluster.members as Array<{ id: string; similarity: number }>).push({
          id: item.id,
          similarity: sim,
        });
        (cluster as { size: number }).size++;
        assigned.add(item.id);
        merged = true;
        break;
      }
    }

    // New cluster
    if (!merged) {
      clusters.push({
        id: `cluster-${clusters.length}`,
        members: [{ id: item.id, similarity: 1.0 }],
        centroidId: item.id,
        size: 1,
      });
      assigned.add(item.id);
    }
  }

  return clusters;
}

// ─────────────────────────────────────────────────────────────
// Content hash for exact dedup (first level)
// ─────────────────────────────────────────────────────────────

export function contentHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

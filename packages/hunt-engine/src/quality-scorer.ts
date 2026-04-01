// Buckets: queryFit, durability, vitality, importability, evidenceConfidence
// overall = queryFit(0.30) + qualityComposite(0.45) + importability(0.15) + evidence(0.10)
// Every score has human-readable explanation.

import type { ScoreBreakdown, ScoredCandidate, RankingPreset } from "@forgemcp/data-sources";

// ─────────────────────────────────────────────────────────────
// Input: raw signals from various sources
// ─────────────────────────────────────────────────────────────

export interface RawSignals {
  // Query fit
  readonly nameMatch: boolean;        // symbol name contains query terms
  readonly signatureMatch: boolean;   // signature contains query terms
  readonly snippetMatch: boolean;     // code snippet contains query terms

  // Durability
  readonly repoStars: number;
  readonly repoAge?: number;          // years (if known)
  readonly hasTests: boolean;
  readonly releaseCount?: number;

  // Vitality
  readonly lastPushed?: string;       // ISO date
  readonly archived: boolean;
  readonly openIssues?: number;
  readonly contributorCount?: number;

  // Importability
  readonly externalDepCount: number;
  readonly linesOfCode: number;
  readonly exported: boolean;
  readonly licenseSpdx: string | null;
  readonly selfContained: boolean;    // can be extracted without many local deps

  // Evidence confidence
  readonly sourceCount: number;       // how many sources found this
  readonly hasFullCode: boolean;      // do we have the complete code (not just snippet)
  readonly repoMetadataAvailable: boolean;
  readonly blindSpots: string[];
}

// ─────────────────────────────────────────────────────────────
// Score computation
// ─────────────────────────────────────────────────────────────

export function computeScore(signals: RawSignals): {
  breakdown: ScoreBreakdown;
  why: string[];
  gaps: string[];
} {
  const why: string[] = [];
  const gaps: string[] = [];

  // ── Query Fit (0-1) ──
  let queryFit = 0;
  if (signals.nameMatch) { queryFit += 0.5; why.push("Symbol name matches query"); }
  if (signals.signatureMatch) { queryFit += 0.3; why.push("Function signature matches"); }
  if (signals.snippetMatch) { queryFit += 0.2; }
  queryFit = Math.min(1, queryFit);

  // Stars: log10 scale, 1K=0.6, 10K=0.8, 100K=1.0
  const starScore = Math.min(1, Math.log10(signals.repoStars + 1) / 5);
  let durability = starScore * 0.4;
  if (signals.hasTests) { durability += 0.25; why.push("Has associated tests"); }
  if (signals.repoAge && signals.repoAge > 2) {
    durability += 0.15; why.push(`Repo is ${signals.repoAge.toFixed(0)} years old`);
  }
  if (signals.releaseCount && signals.releaseCount > 5) {
    durability += 0.2; why.push(`${signals.releaseCount} releases`);
  }
  if (signals.repoStars > 1000) why.push(`${signals.repoStars} stars`);
  durability = Math.min(1, durability);

  // ── Vitality (0-1) ──
  let vitality = 0;
  if (signals.archived) {
    vitality = 0; why.push("⚠️ Repository is archived");
  } else {
    if (signals.lastPushed) {
      const daysSincePush = (Date.now() - new Date(signals.lastPushed).getTime()) / (86400000);
      if (daysSincePush < 7) { vitality += 0.55; why.push("Active: pushed this week"); }
      else if (daysSincePush < 30) { vitality += 0.45; why.push("Active: pushed within 30 days"); }
      else if (daysSincePush < 180) { vitality += 0.3; }
      else if (daysSincePush < 365) { vitality += 0.15; }
      else { why.push("⚠️ No push in >1 year"); }
    } else {
      gaps.push("Last push date unknown");
    }
    if (signals.contributorCount && signals.contributorCount > 3) {
      vitality += 0.3; why.push(`${signals.contributorCount} contributors`);
    }
    if (signals.openIssues !== undefined && signals.openIssues < 50) {
      vitality += 0.15;
    }
  }
  vitality = Math.min(1, vitality);

  // ── Importability (0-1) ──
  let importability = 0;
  // Fewer deps = better
  const depPenalty = Math.min(1, signals.externalDepCount / 10);
  importability += (1 - depPenalty) * 0.3;
  if (signals.externalDepCount === 0) why.push("Zero external dependencies");
  // Smaller = better
  if (signals.linesOfCode < 50) { importability += 0.3; why.push("Compact (<50 LOC)"); }
  else if (signals.linesOfCode < 200) { importability += 0.15; }
  // Exported = importable
  if (signals.exported) importability += 0.15;
  // Self-contained
  if (signals.selfContained) { importability += 0.15; why.push("Self-contained function"); }
  // License
  if (signals.licenseSpdx) {
    const permissive = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"];
    if (permissive.includes(signals.licenseSpdx)) {
      importability += 0.1; why.push(`License: ${signals.licenseSpdx}`);
    }
  } else {
    gaps.push("License unknown");
  }
  importability = Math.min(1, importability);

  // ── Code Quality (0-1) — part of qualityComposite ──
  let codeQuality = 0.5; // baseline
  if (signals.hasTests) codeQuality += 0.2;
  if (signals.linesOfCode > 0 && signals.linesOfCode < 300) codeQuality += 0.1;
  if (signals.exported) codeQuality += 0.1;
  codeQuality = Math.min(1, codeQuality);

  // Baseline raised: if we found it and have metadata, confidence should be decent
  let evidenceConfidence = 0.55;
  if (signals.hasFullCode) evidenceConfidence += 0.2;
  if (signals.repoMetadataAvailable) evidenceConfidence += 0.15;
  if (signals.sourceCount >= 2) { evidenceConfidence += 0.1; why.push("Found by multiple search engines"); }
  if (signals.repoStars > 5000) evidenceConfidence += 0.05;
  if (signals.repoStars > 50000) evidenceConfidence += 0.05;
  evidenceConfidence -= Math.min(0.25, signals.blindSpots.length * 0.08);
  evidenceConfidence = Math.max(0.15, Math.min(1, evidenceConfidence));
  if (signals.blindSpots.length > 0) {
    gaps.push(...signals.blindSpots);
  }

  return {
    breakdown: { queryFit, durability, vitality, importability, codeQuality, evidenceConfidence },
    why,
    gaps,
  };
}

// ─────────────────────────────────────────────────────────────
// Composite score by preset
// ─────────────────────────────────────────────────────────────

const PRESET_WEIGHTS: Record<RankingPreset, {
  queryFit: number; durability: number; vitality: number;
  importability: number; codeQuality: number; evidenceConfidence: number;
}> = {
  battle_tested:      { queryFit: 0.30, durability: 0.25, vitality: 0.10, importability: 0.15, codeQuality: 0.10, evidenceConfidence: 0.10 },
  modern_active:      { queryFit: 0.25, durability: 0.10, vitality: 0.30, importability: 0.15, codeQuality: 0.10, evidenceConfidence: 0.10 },
  minimal_dependency: { queryFit: 0.25, durability: 0.10, vitality: 0.10, importability: 0.35, codeQuality: 0.10, evidenceConfidence: 0.10 },
  teaching_quality:   { queryFit: 0.20, durability: 0.05, vitality: 0.05, importability: 0.10, codeQuality: 0.50, evidenceConfidence: 0.10 },
};

// Each preset defines weights that sum to 1.0 across all 6 factors.
// Previous formula had 0.35*queryFit + 0.50*qualityComposite + 0.15*evidence
// which double-counted queryFit (once in fixed 0.35, once in preset weights).
export function compositeScore(breakdown: ScoreBreakdown, preset: RankingPreset): number {
  const w = PRESET_WEIGHTS[preset];

  return (
    w.queryFit * breakdown.queryFit +
    w.durability * breakdown.durability +
    w.vitality * breakdown.vitality +
    w.importability * breakdown.importability +
    w.codeQuality * breakdown.codeQuality +
    w.evidenceConfidence * breakdown.evidenceConfidence
  );
}

/**
 * RFC v2 Section 16.4: Hard caps and penalties.
 * Apply BEFORE composite scoring. Caps prevent overconfident results.
 */
export function applyHardCaps(breakdown: ScoreBreakdown, signals: RawSignals): ScoreBreakdown {
  let { evidenceConfidence, importability, vitality } = breakdown;

  // snippet_only → cap evidence at 0.60
  if (!signals.hasFullCode) {
    evidenceConfidence = Math.min(evidenceConfidence, 0.60);
  }

  // dependency closure partial → cap importability and evidence
  if (!signals.selfContained && signals.externalDepCount > 3) {
    importability = Math.min(importability, 0.50);
    evidenceConfidence = Math.min(evidenceConfidence, 0.65);
  }

  // archived → cap vitality at 0.20
  if (signals.archived) {
    vitality = Math.min(vitality, 0.20);
  }

  // license unknown + not reference_only → cap importability at 0.20
  if (!signals.licenseSpdx) {
    importability = Math.min(importability, 0.20);
  }

  return {
    ...breakdown,
    evidenceConfidence,
    importability,
    vitality,
  };
}

// ─────────────────────────────────────────────────────────────
// MMR Diversification — build spec Section 5, Stage 3
// MMR(c) = λ * score(c) - (1-λ) * max(sim(c, s))
// ─────────────────────────────────────────────────────────────

/** Preset lambda values. Higher λ = more relevance, less diversity. */
const MMR_LAMBDA: Record<RankingPreset, number> = {
  battle_tested: 0.78,
  modern_active: 0.72,
  minimal_dependency: 0.82,
  teaching_quality: 0.68,
};

export interface ScoredItem {
  readonly id: string;
  readonly score: number;
  readonly fingerprint: string;  // for similarity computation
  readonly familyId?: string;    // deterministic algorithm family
}

/**
 * Build spec: MMR diversification after reranking.
 * Selects top-K items that balance relevance with diversity.
 * Uses fingerprint Jaccard similarity for diversity penalty.
 */
export function mmrDiversify(
  candidates: ScoredItem[],
  preset: RankingPreset,
  maxItems: number,
): ScoredItem[] {
  const lambda = MMR_LAMBDA[preset];
  const selected: ScoredItem[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  while (selected.length < maxItems && remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const c = candidates[idx]!;
      const relevance = c.score;

      // Max similarity to any already-selected item
      let maxSim = 0;
      for (const s of selected) {
        const sim = computeSimilarity(c, s);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(candidates[bestIdx]!);
      remaining.delete(bestIdx);
    } else {
      break;
    }
  }

  return selected;
}

/** Similarity between two candidates for MMR. */
function computeSimilarity(a: ScoredItem, b: ScoredItem): number {
  // Same deterministic family → highest similarity
  if (a.familyId && b.familyId && a.familyId === b.familyId) return 1.0;
  // Same fingerprint → near-clone
  if (a.fingerprint === b.fingerprint) return 0.95;
  // Fingerprint Jaccard (approximated by character overlap for speed)
  if (a.fingerprint.length > 0 && b.fingerprint.length > 0) {
    const setA = new Set(a.fingerprint.split(""));
    const setB = new Set(b.fingerprint.split(""));
    let intersection = 0;
    for (const ch of setA) if (setB.has(ch)) intersection++;
    const union = setA.size + setB.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard > 0.8) return 0.85;
    if (jaccard > 0.5) return 0.5;
  }
  return 0;
}

/**
 * Durability × Vitality product — build spec Section 8.
 * `dv = sqrt(durability * vitality)`
 * Penalizes "ancient but dead" and "active but flaky".
 */
export function durabilityVitality(durability: number, vitality: number): number {
  return Math.sqrt(durability * vitality);
}

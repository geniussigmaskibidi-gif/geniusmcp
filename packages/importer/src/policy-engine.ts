// Import is NOT a side effect of hunt. It's a separate policy-aware subsystem.
//
// Modes:
//   reference_only          — always allowed
//   generate_inspired_by    — usually allowed
//   vendor_with_attribution — conditionally allowed (license + closure required)
//   snippet_transplant      — conditionally allowed (full verification required)
//
// Policy rules:
//   - unknown license + restricted mode → BLOCK
//   - unresolved closure → BLOCK for transplant
//   - archived repo → WARN
//   - every result includes ProvenanceManifest

import { createHash } from "node:crypto";
import type { ImportMode, LicensePolicy, LicenseVerdict } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// Types from RFC v2
// ─────────────────────────────────────────────────────────────

export type PolicyDecision = "allow" | "warn" | "block";

export type BlindSpot =
  | "snippet_only"
  | "default_branch_only"
  | "license_unknown"
  | "dependency_closure_partial"
  | "tree_truncated"
  | "unsupported_language_parser";

export interface ProvenanceManifest {
  readonly repo: string;
  readonly path: string;
  readonly symbolName?: string;
  readonly discoveredVia: Array<{
    source: string;
    query: string;
    timestamp: string;
  }>;
  readonly repoLicense: string | null;
  readonly retrievalMode: "snippet" | "file" | "symbol" | "closure";
  readonly importPolicy: PolicyDecision;
}

export interface ImportPolicyInput {
  readonly mode: ImportMode;
  readonly licenseSpdx: string | null;
  readonly closureResolved: boolean;
  readonly archived: boolean;
  readonly blindSpots: BlindSpot[];
  readonly depCount: number;
}

export interface ImportPolicyResult {
  readonly decision: PolicyDecision;
  readonly reason: string;
  readonly blockers: string[];
  readonly warnings: string[];
}

// ─────────────────────────────────────────────────────────────
// Default license policy
// ─────────────────────────────────────────────────────────────

const DEFAULT_BLOCKED = new Set([
  "GPL-2.0-only", "GPL-2.0-or-later",
  "GPL-3.0-only", "GPL-3.0-or-later",
  "AGPL-1.0-only", "AGPL-3.0-only", "AGPL-3.0-or-later",
  "SSPL-1.0", "EUPL-1.1", "EUPL-1.2",
]);

const DEFAULT_PERMISSIVE = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "ISC", "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0",
]);

// ─────────────────────────────────────────────────────────────
// Policy evaluation
// ─────────────────────────────────────────────────────────────

export function evaluateImportPolicy(input: ImportPolicyInput): ImportPolicyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── reference_only is ALWAYS allowed ──
  if (input.mode === "reference_only") {
    if (input.archived) warnings.push("Repository is archived — reference may be outdated");
    return { decision: "allow", reason: "Reference-only mode is always safe", blockers: [], warnings };
  }

  // ── License checks ──
  if (!input.licenseSpdx) {
    if (input.mode === "snippet_transplant" || input.mode === "vendor_with_attribution") {
      blockers.push("License unknown — cannot transplant or vendor without license verification");
    } else {
      warnings.push("License unknown — use with caution");
    }
  } else if (DEFAULT_BLOCKED.has(input.licenseSpdx)) {
    blockers.push(`License ${input.licenseSpdx} is copyleft — incompatible with most projects`);
  } else if (!DEFAULT_PERMISSIVE.has(input.licenseSpdx)) {
    warnings.push(`License ${input.licenseSpdx} is non-standard — verify compatibility`);
  }

  // ── Closure checks ──
  if (!input.closureResolved) {
    if (input.mode === "snippet_transplant") {
      blockers.push("Import closure not fully resolved — cannot guarantee transplant correctness");
    } else {
      warnings.push("Dependency closure partially resolved — some imports may be missing");
    }
  }

  // ── Archive check ──
  if (input.archived) {
    warnings.push("Repository is archived — no future maintenance expected");
  }

  // ── Dependency count check ──
  if (input.depCount > 10) {
    warnings.push(`High dependency count (${input.depCount}) — increases import complexity`);
  }

  // ── Blind spot checks ──
  if (input.blindSpots.includes("snippet_only") && input.mode === "snippet_transplant") {
    blockers.push("Only snippet available — full file needed for transplant mode");
  }

  // ── Decision ──
  if (blockers.length > 0) {
    return {
      decision: "block",
      reason: blockers[0]!,
      blockers,
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      decision: "warn",
      reason: `Allowed with ${warnings.length} warning(s)`,
      blockers: [],
      warnings,
    };
  }

  return {
    decision: "allow",
    reason: "All policy checks passed",
    blockers: [],
    warnings: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Provenance manifest builder
// ─────────────────────────────────────────────────────────────

export function buildProvenanceManifest(opts: {
  repo: string;
  path: string;
  symbolName?: string;
  sources: Array<{ source: string; query: string }>;
  licenseSpdx: string | null;
  hasFullCode: boolean;
  closureResolved: boolean;
  policyDecision: PolicyDecision;
}): ProvenanceManifest {
  const now = new Date().toISOString();

  let retrievalMode: ProvenanceManifest["retrievalMode"];
  if (opts.closureResolved) retrievalMode = "closure";
  else if (opts.symbolName) retrievalMode = "symbol";
  else if (opts.hasFullCode) retrievalMode = "file";
  else retrievalMode = "snippet";

  return {
    repo: opts.repo,
    path: opts.path,
    symbolName: opts.symbolName,
    discoveredVia: opts.sources.map((s) => ({
      source: s.source,
      query: s.query,
      timestamp: now,
    })),
    repoLicense: opts.licenseSpdx,
    retrievalMode,
    importPolicy: opts.policyDecision,
  };
}

// ─────────────────────────────────────────────────────────────
// Attribution comment generator
// ─────────────────────────────────────────────────────────────

export function generateAttribution(provenance: ProvenanceManifest): string {
  const hash = createHash("sha256")
    .update(`${provenance.repo}:${provenance.path}#${provenance.symbolName ?? ""}`)
    .digest("hex")
    .slice(0, 16);

  return [
    `// Sourced from: ${provenance.repo}/${provenance.path}`,
    provenance.symbolName ? `// Symbol: ${provenance.symbolName}` : null,
    `// License: ${provenance.repoLicense ?? "UNKNOWN"}`,
    `// Retrieval: ${provenance.retrievalMode}`,
    `// Policy: ${provenance.importPolicy}`,
    `// Provenance: ${hash}`,
    `// Generated by ForgeMCP`,
  ].filter(Boolean).join("\n");
}

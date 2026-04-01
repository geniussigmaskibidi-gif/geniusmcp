// L1 Index Card:    < 80 tokens — name, kind, confidence, signature
// L2 Detail Capsule: < 300 tokens — + description, deps, callers, location
// L3 Full Context:  < 2000 tokens — + code, call graph, evidence
//
// Design: Agent gets compact L1 by default. Requests L2/L3 only when needed.
// This follows Repomix/Aider/Claude Code patterns for context compression.

import { estimateTokens } from "./token-budget.js";

export interface TierableResult {
  readonly name: string;
  readonly kind: string;
  readonly language?: string;
  readonly confidence?: number;
  readonly signature?: string;
  readonly description?: string;
  readonly file?: string;
  readonly repo?: string;
  readonly lines?: string;
  readonly callers?: readonly string[];
  readonly deps?: readonly string[];
  readonly sourceType?: string;
  readonly code?: string;
  readonly timesRecalled?: number;
  readonly lastRecalledAt?: string;
}

// Enough for routing decisions: "is this the right result?"
export function buildL1Card(result: TierableResult): string {
  const conf = result.confidence != null ? ` ${Math.round(result.confidence * 100)}%` : "";
  const sig = result.signature ? ` :: ${result.signature}` : "";
  const recalled = result.timesRecalled ? ` :: recalled ${result.timesRecalled}x` : "";
  const lang = result.language ? ` :: ${result.language}` : "";

  return `${result.name} > ${result.kind}${lang}${conf}${sig}${recalled}`;
}

// Enough for understanding: "what does this do and where is it?"
export function buildL2Capsule(result: TierableResult): string {
  const l1 = buildL1Card(result);
  const parts: string[] = [l1];

  if (result.description) {
    parts.push(result.description);
  }
  if (result.deps && result.deps.length > 0) {
    parts.push(`Deps: ${result.deps.slice(0, 8).join(", ")}`);
  }
  if (result.callers && result.callers.length > 0) {
    parts.push(`Callers: ${result.callers.slice(0, 5).join(", ")}`);
  }
  if (result.file) {
    const location = result.lines ? `${result.file}:${result.lines}` : result.file;
    const repo = result.repo ? `${result.repo}/` : "";
    parts.push(`File: ${repo}${location}`);
  }
  if (result.sourceType) {
    parts.push(`Source: ${result.sourceType}`);
  }

  return parts.join("\n");
}

// Enough for implementation: includes actual code
export function buildL3Full(result: TierableResult): string {
  const l2 = buildL2Capsule(result);
  const parts: string[] = [l2];

  if (result.code) {
    const lang = result.language ?? "typescript";
    const maxCodeChars = 4000;
    let code = result.code;
    if (code.length > maxCodeChars) {
      code = code.slice(0, maxCodeChars) + "\n// ... truncated";
    }
    parts.push("```" + lang + "\n" + code + "\n```");
  }

  return parts.join("\n\n");
}

export function formatTieredResults(
  results: readonly TierableResult[],
  tier: "L1" | "L2" | "L3",
): string {
  const builder = tier === "L3" ? buildL3Full : tier === "L2" ? buildL2Capsule : buildL1Card;
  const separator = tier === "L1" ? "\n" : "\n---\n";

  const formatted = results.map((r, i) => `${i + 1}. ${builder(r)}`);
  const output = formatted.join(separator);
  const tokens = estimateTokens(output);

  return `[${results.length} results, ${tier} tier, ~${tokens} tokens]\n\n${output}`;
}

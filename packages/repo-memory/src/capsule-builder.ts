// Produces L1 (card), L2 (capsule), and L3 (full) views at different token budgets.

// ── Types ──────────────────────────────────────────────────────────────────

/** Input descriptor for capsule rendering. */
export interface CapsuleInput {
  name: string;
  kind: string;
  language: string;
  confidence: number;
  signature?: string;
  description?: string;
  imports?: string[];
  timesRecalled: number;
  lastRecalledAt?: string;
  sourceType: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Rough token estimate (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Human-readable relative time from an ISO-8601 date string. */
export function timeSince(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ── Builders ───────────────────────────────────────────────────────────────

/**
 * L1 Card — ultra-compact summary (40-60 tokens).
 * Format: ## name (kind) | Confidence | Signature | Language | Recalls
 */
export function buildL1Card(input: CapsuleInput): string {
  const lines: string[] = [];
  lines.push(`## ${input.name} (${input.kind})`);
  lines.push(`Confidence: ${input.confidence}%`);
  if (input.signature) {
    lines.push(`Sig: ${input.signature}`);
  }
  lines.push(`${input.language} | ${input.timesRecalled} recalls`);
  return lines.join("\n");
}

/**
 * L2 Capsule — moderate detail (120-220 tokens).
 * Extends L1 with description, dependency list, last recalled, and source type.
 */
export function buildL2Capsule(input: CapsuleInput, l1Card: string): string {
  const sections: string[] = [l1Card];

  if (input.description) {
    sections.push(`\n${input.description}`);
  }

  if (input.imports && input.imports.length > 0) {
    sections.push(`\nDeps: ${input.imports.join(", ")}`);
  }

  if (input.lastRecalledAt) {
    sections.push(`Last recalled: ${timeSince(input.lastRecalledAt)}`);
  }

  sections.push(`Source: ${input.sourceType}`);

  return sections.join("\n");
}

/**
 * L3 Full — rich view with source code (up to ~1500 tokens).
 * Extends L2 with a fenced code block, truncated at 4000 chars.
 */
export function buildL3Full(
  input: CapsuleInput,
  l2Capsule: string,
  code: string,
): string {
  const maxCodeChars = 4000;
  let codeContent = code;
  if (codeContent.length > maxCodeChars) {
    codeContent = codeContent.slice(0, maxCodeChars) + "\n// ... truncated";
  }

  const sections: string[] = [
    l2Capsule,
    "",
    `\`\`\`${input.language}`,
    codeContent,
    "```",
  ];

  return sections.join("\n");
}

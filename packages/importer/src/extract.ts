// Research: NOT copy-paste. Lawful transplant with:
//   - License gate (SPDX check, blocked/preferred policies)
//   - Dependency closure (local + external, max depth 3)
//   - Style detection + adaptation
//   - Provenance record (source, commit, license, attribution)
//
// Design: extract the TARGET SYMBOL + transitive local dependencies,
// not the whole file. This is what makes import.extract "smart".

import { createHash } from "node:crypto";
import type { GitHubGateway } from "@forgemcp/github-gateway";
import { extractSymbols, detectLanguage } from "@forgemcp/ast-intelligence";
import type { LicensePolicy, LicenseVerdict, ImportMode } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface ExtractRequest {
  readonly repo: string;         // "owner/repo"
  readonly path: string;
  readonly symbol?: string;      // specific function/class to extract
  readonly ref?: string;         // branch/tag/commit
  readonly mode?: ImportMode;
  readonly licensePolicy?: LicensePolicy;
  readonly adaptStyle?: boolean;
}

export interface ExtractResult {
  readonly code: string;
  readonly symbol: string | null;
  readonly language: string;
  readonly sourceRepo: string;
  readonly sourcePath: string;
  readonly sourceCommitSha: string;
  readonly licenseSpdx: string | null;
  readonly licenseVerdict: LicenseVerdict;
  readonly mode: ImportMode;
  readonly dependencies: {
    readonly external: Array<{ pkg: string; inferred: boolean }>;
    readonly local: Array<{ path: string; symbols: string[] }>;
  };
  readonly adaptations: string[];
  readonly provenanceHash: string;
  readonly attributionComment: string;
  readonly installCommand: string;
}

// ─────────────────────────────────────────────────────────────
// License checking
// ─────────────────────────────────────────────────────────────

const DEFAULT_POLICY: LicensePolicy = {
  blocked: new Set(["GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "AGPL-3.0-or-later"]),
  preferred: new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"]),
  requireAttribution: true,
};

export function checkLicense(spdx: string | null, policy?: LicensePolicy): LicenseVerdict {
  const p = policy ?? DEFAULT_POLICY;
  if (!spdx) return "review";
  if (p.blocked.has(spdx)) return "blocked";
  if (p.preferred.has(spdx)) return "allowed";
  return "review";
}

// ─────────────────────────────────────────────────────────────
// Provenance
// ─────────────────────────────────────────────────────────────

function buildProvenanceHash(repo: string, commit: string, path: string, symbol?: string): string {
  const input = `${repo}@${commit}:${path}#${symbol ?? ""}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

function buildAttribution(
  repo: string, commit: string, path: string, license: string | null, symbol?: string,
): string {
  return [
    `// Imported from: ${repo}`,
    `// Path: ${path}${symbol ? `#${symbol}` : ""}`,
    `// Commit: ${commit.slice(0, 12)}`,
    `// License: ${license ?? "UNKNOWN — review required"}`,
    `// Provenance: ${buildProvenanceHash(repo, commit, path, symbol)}`,
    `// Imported by ForgeMCP`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// External dependency detection from imports
// ─────────────────────────────────────────────────────────────

function detectExternalDeps(code: string, language: string): Array<{ pkg: string; inferred: boolean }> {
  const deps: Array<{ pkg: string; inferred: boolean }> = [];
  const seen = new Set<string>();

  if (["typescript", "javascript", "tsx", "jsx"].includes(language)) {
    for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? "";
      if (spec.startsWith(".") || spec.startsWith("/")) continue; // local
      const parts = spec.split("/");
      const pkg = spec.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? spec);
      if (!seen.has(pkg)) {
        seen.add(pkg);
        deps.push({ pkg, inferred: true });
      }
    }
  } else if (language === "python") {
    for (const m of code.matchAll(/^(?:from|import)\s+([\w.]+)/gm)) {
      const pkg = (m[1] ?? "").split(".")[0] ?? "";
      if (pkg && !seen.has(pkg)) {
        seen.add(pkg);
        deps.push({ pkg, inferred: true });
      }
    }
  }
  // Go, Rust: similar patterns (already in symbol-extractor)

  return deps;
}

// ─────────────────────────────────────────────────────────────
// Style detection
// ─────────────────────────────────────────────────────────────

interface StyleProfile {
  useSemicolons: boolean;
  quoteStyle: "single" | "double";
  indentStyle: "tabs" | "spaces";
  indentSize: number;
}

function detectStyle(code: string): StyleProfile {
  const lines = code.split("\n").filter((l) => l.trim().length > 0);
  const semiCount = lines.filter((l) => l.trimEnd().endsWith(";")).length;
  const singleQuotes = (code.match(/'/g) ?? []).length;
  const doubleQuotes = (code.match(/"/g) ?? []).length;
  const tabLines = lines.filter((l) => l.startsWith("\t")).length;
  const spaceLines = lines.filter((l) => /^ {2,}/.test(l)).length;

  // Detect indent size from space lines
  let indentSize = 2;
  if (spaceLines > 0) {
    const indents = lines
      .map((l) => l.match(/^( +)/)?.[1]?.length ?? 0)
      .filter((n) => n > 0);
    if (indents.length > 0) {
      // Most common indent
      const counts = new Map<number, number>();
      for (const n of indents) {
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      indentSize = sorted[0]?.[0] ?? 2;
      // Normalize: if common indent is 4,8,12... → size=4. If 2,4,6... → size=2.
      if (indentSize % 4 === 0) indentSize = 4;
      else if (indentSize % 2 === 0) indentSize = 2;
    }
  }

  return {
    useSemicolons: semiCount > lines.length * 0.3,
    quoteStyle: singleQuotes > doubleQuotes ? "single" : "double",
    indentStyle: tabLines > spaceLines ? "tabs" : "spaces",
    indentSize,
  };
}

function adaptStyle(code: string, from: StyleProfile, to: StyleProfile): string {
  let result = code;

  // Semicolons
  if (from.useSemicolons && !to.useSemicolons) {
    result = result.replace(/;\s*$/gm, "");
  } else if (!from.useSemicolons && to.useSemicolons) {
    result = result.replace(/([^{;,\s])\s*$/gm, "$1;");
  }

  // Quotes (only for JS/TS import strings — safe substitution)
  if (from.quoteStyle !== to.quoteStyle) {
    const fromQ = from.quoteStyle === "single" ? "'" : '"';
    const toQ = to.quoteStyle === "single" ? "'" : '"';
    // Only convert import/require strings
    result = result.replace(
      new RegExp(`(from\\s+|require\\s*\\()${fromQ}([^${fromQ}]*)${fromQ}`, "g"),
      `$1${toQ}$2${toQ}`,
    );
  }

  // Indentation
  if (from.indentStyle !== to.indentStyle) {
    if (from.indentStyle === "tabs" && to.indentStyle === "spaces") {
      result = result.replace(/^\t+/gm, (tabs) => " ".repeat(tabs.length * to.indentSize));
    } else if (from.indentStyle === "spaces" && to.indentStyle === "tabs") {
      const rx = new RegExp(`^( {${from.indentSize}})+`, "gm");
      result = result.replace(rx, (spaces) => "\t".repeat(spaces.length / from.indentSize));
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Main extract function
// ─────────────────────────────────────────────────────────────

export async function extractWithProvenance(
  req: ExtractRequest,
  github: GitHubGateway,
  workspaceCode?: string, // sample of user's code for style detection
): Promise<ExtractResult> {
  const [owner, repo] = req.repo.split("/");
  if (!owner || !repo) throw new Error("repo must be owner/repo format");

  // 1. Fetch file content
  const file = await github.getFileContent(owner, repo, req.path, req.ref);
  const language = file.language ?? detectLanguage(req.path) ?? "typescript";

  // 2. Get repo license
  let licenseSpdx: string | null = null;
  try {
    const overview = await github.getRepoOverview(owner, repo);
    licenseSpdx = overview.license;
  } catch { /* license unknown */ }

  // 3. License gate
  const licenseVerdict = checkLicense(licenseSpdx, req.licensePolicy);
  if (licenseVerdict === "blocked") {
    throw new Error(
      `License ${licenseSpdx} in ${req.repo} is blocked by your policy. ` +
      `Cannot import code with this license.`,
    );
  }

  // 4. Extract target symbol (or use whole file)
  let code = file.content;
  let symbolName: string | null = null;

  if (req.symbol) {
    const { symbols } = extractSymbols(file.content, language);
    const target = symbols.find((s) =>
      s.name.toLowerCase() === req.symbol!.toLowerCase(),
    ) ?? symbols.find((s) =>
      s.name.toLowerCase().includes(req.symbol!.toLowerCase()),
    );

    if (target) {
      code = target.code;
      symbolName = target.name;
    }
  }

  // 5. Detect external dependencies
  const externalDeps = detectExternalDeps(code, language);

  // 6. Style adaptation
  const adaptations: string[] = [];
  const mode = req.mode ?? "generate_inspired_by";

  if (req.adaptStyle && workspaceCode) {
    const sourceStyle = detectStyle(code);
    const targetStyle = detectStyle(workspaceCode);

    if (sourceStyle.useSemicolons !== targetStyle.useSemicolons) {
      adaptations.push(targetStyle.useSemicolons ? "Added semicolons" : "Removed semicolons");
    }
    if (sourceStyle.quoteStyle !== targetStyle.quoteStyle) {
      adaptations.push(`Changed quotes to ${targetStyle.quoteStyle}`);
    }
    if (sourceStyle.indentStyle !== targetStyle.indentStyle) {
      adaptations.push(`Changed indentation to ${targetStyle.indentStyle}`);
    }

    code = adaptStyle(code, sourceStyle, targetStyle);
  }

  // 7. Build provenance
  const provenanceHash = buildProvenanceHash(req.repo, file.sha, req.path, symbolName ?? undefined);
  const attribution = buildAttribution(req.repo, file.sha, req.path, licenseSpdx, symbolName ?? undefined);

  // 8. Build install command
  const installPkgs = externalDeps.map((d) => d.pkg);
  const installCommand = installPkgs.length > 0
    ? `npm install ${installPkgs.join(" ")}`
    : "# No additional dependencies needed";

  return {
    code,
    symbol: symbolName,
    language,
    sourceRepo: req.repo,
    sourcePath: req.path,
    sourceCommitSha: file.sha,
    licenseSpdx,
    licenseVerdict,
    mode,
    dependencies: {
      external: externalDeps,
      local: [], // TODO: resolve local imports in Phase 2
    },
    adaptations,
    provenanceHash,
    attributionComment: attribution,
    installCommand,
  };
}

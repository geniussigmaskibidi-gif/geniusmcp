// Check for naming conflicts between imported code and existing workspace.
// Research: TypeScript compiler conflict resolution, ESLint no-shadow rule.

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ConflictSeverity = "error" | "warning" | "info";

export interface ConflictReport {
  readonly conflicts: Conflict[];
  readonly hasBlockingConflicts: boolean;
}

export interface Conflict {
  readonly severity: ConflictSeverity;
  readonly kind: ConflictKind;
  readonly symbolName: string;
  readonly importedFrom: string;
  readonly existingLocation: string;
  readonly suggestion: string;
}

export type ConflictKind =
  | "name_collision"       // same export name exists
  | "type_mismatch"        // same name, different type (function vs class)
  | "namespace_shadow"     // import would shadow existing module-level name
  | "dependency_version"   // imported code needs different version of a dep
  | "style_mismatch";      // naming convention doesn't match project

// ─────────────────────────────────────────────────────────────
// Workspace symbol for comparison
// ─────────────────────────────────────────────────────────────

export interface WorkspaceSymbol {
  readonly name: string;
  readonly kind: string;
  readonly filePath: string;
  readonly exported: boolean;
}

export interface ImportCandidate {
  readonly name: string;
  readonly kind: string;
  readonly sourceRepo: string;
}

// ─────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────

/**
 * Detect naming conflicts between import candidates and workspace symbols.
 *
 * Checks:
 *   1. Exact name collision (same exported name)
 *   2. Type mismatch (same name, different kind)
 *   3. Namespace shadowing (would shadow an existing binding)
 */
export function detectConflicts(
  candidates: ImportCandidate[],
  workspaceSymbols: WorkspaceSymbol[],
): ConflictReport {
  const conflicts: Conflict[] = [];
  const exportedNames = new Map<string, WorkspaceSymbol>();

  for (const ws of workspaceSymbols) {
    if (ws.exported) {
      exportedNames.set(ws.name, ws);
    }
  }

  for (const candidate of candidates) {
    const existing = exportedNames.get(candidate.name);

    if (existing) {
      if (existing.kind !== candidate.kind) {
        conflicts.push({
          severity: "error",
          kind: "type_mismatch",
          symbolName: candidate.name,
          importedFrom: candidate.sourceRepo,
          existingLocation: existing.filePath,
          suggestion: `Rename imported ${candidate.kind} '${candidate.name}' to avoid collision with existing ${existing.kind}`,
        });
      } else {
        conflicts.push({
          severity: "warning",
          kind: "name_collision",
          symbolName: candidate.name,
          importedFrom: candidate.sourceRepo,
          existingLocation: existing.filePath,
          suggestion: `Consider aliasing: import { ${candidate.name} as ${candidate.name}Imported }`,
        });
      }
    }

    const shadowed = workspaceSymbols.find(
      ws => ws.name === candidate.name && !ws.exported
    );
    if (shadowed) {
      conflicts.push({
        severity: "info",
        kind: "namespace_shadow",
        symbolName: candidate.name,
        importedFrom: candidate.sourceRepo,
        existingLocation: shadowed.filePath,
        suggestion: `Import may shadow local '${candidate.name}' in ${shadowed.filePath}`,
      });
    }
  }

  return {
    conflicts,
    hasBlockingConflicts: conflicts.some(c => c.severity === "error"),
  };
}

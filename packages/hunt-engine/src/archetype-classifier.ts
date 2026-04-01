// Categories: minimal_inline, configurable_utility, middleware_decorator,
//             context_aware, enterprise_heavy, wrapper_adapter
// No ML needed. Pure structural heuristics.

import type { ArchetypeCategory } from "@forgemcp/data-sources";
import type { ExtractedSymbol } from "@forgemcp/ast-intelligence";

export interface ClassifiedSymbol {
  readonly symbol: ExtractedSymbol;
  readonly category: ArchetypeCategory;
  readonly categoryConfidence: number;  // 0-1
  readonly features: {
    readonly linesOfCode: number;
    readonly importCount: number;
    readonly hasOptionsParam: boolean;
    readonly hasContextParam: boolean;
    readonly isMiddleware: boolean;
    readonly isWrapper: boolean;
  };
}

export function classifySymbol(symbol: ExtractedSymbol): ClassifiedSymbol {
  const code = symbol.code.toLowerCase();
  const loc = symbol.endLine - symbol.startLine + 1;
  const importCount = symbol.imports.length;

  // Snippets from grep.app are truncated (~10 lines), so LOC is unreliable.
  // Instead, detect structural patterns from keywords in the code body.
  const hasOptionsParam = /\boptions\b|\bconfig\b|\bopts\b|\bsettings\b|\bparams\b/.test(code);
  const hasContextParam = /\bcontext\b|\bctx\b|\bcancel\b|\btimeout\b|\babort\b|\bsignal\b/.test(code);
  const isMiddleware = /\bapp\.use\b|\brouter\.use\b|\bnext\s*\(/.test(code)
    || /\breq\b.*\bres\b.*\bnext\b/.test(code)
    || /\bmiddleware\b/.test(code);
  const isWrapper = /\brequire\s*\(|\bimport\b.*\bfrom\b/.test(code)
    && loc < 30
    && /\breturn\b.*\bnew\b|\breturn\b.*\bcreate/.test(code);
  const isDistributed = /\bredis\b|\bmemcached\b|\bdynamo\b|\bpostgres\b|\bsql\b|\bstore\b|\bclient\.connect\b|\bcluster\b/.test(code);
  const hasClassDecl = /\bclass\s+\w/.test(code);
  const hasInterface = /\binterface\s+\w|\btype\s+\w.*=\s*\{/.test(code);
  const hasErrorHandling = /\btry\b.*\bcatch\b|\b\.catch\b|\bthrow\b/.test(code);
  const hasAsync = /\basync\b|\bawait\b|\bPromise\b/.test(code);
  const hasEventEmitter = /\b(on|emit|addListener|removeListener|once)\b/.test(code) && /\bevent\b/.test(code);

  const features = { linesOfCode: loc, importCount, hasOptionsParam, hasContextParam, isMiddleware, isWrapper };

  // A 10-line snippet with class+async+error handling is NOT minimal_inline
  const complexitySignals =
    (hasClassDecl ? 2 : 0) +
    (hasInterface ? 1 : 0) +
    (hasErrorHandling ? 1 : 0) +
    (hasAsync ? 1 : 0) +
    (hasEventEmitter ? 1 : 0) +
    (hasOptionsParam ? 1 : 0) +
    (hasContextParam ? 1 : 0);

  // Classification heuristics (ordered by specificity, content signals first)
  let category: ArchetypeCategory;
  let confidence: number;

  if (isWrapper && loc < 30) {
    category = "wrapper_adapter";
    confidence = 0.8;
  } else if (isDistributed) {
    category = "distributed_backed";
    confidence = 0.75;
  } else if (isMiddleware) {
    category = "middleware_decorator";
    confidence = 0.85;
  } else if (hasContextParam && (hasOptionsParam || complexitySignals >= 3)) {
    category = "context_aware";
    confidence = 0.7;
  } else if (loc > 150 || importCount > 8 || complexitySignals >= 5) {
    category = "enterprise_heavy";
    confidence = 0.6;
  } else if (hasOptionsParam || hasClassDecl || complexitySignals >= 3) {
    category = "configurable_utility";
    confidence = 0.75;
  } else if (loc <= 10 && importCount === 0 && complexitySignals <= 1) {
    category = "minimal_inline";
    confidence = 0.85;
  } else {
    category = "configurable_utility";
    confidence = 0.55;
  }

  return { symbol, category, categoryConfidence: confidence, features };
}

/** Group classified symbols into archetype families by category. */
export function groupByArchetype(
  classified: ClassifiedSymbol[],
): Map<ArchetypeCategory, ClassifiedSymbol[]> {
  const groups = new Map<ArchetypeCategory, ClassifiedSymbol[]>();
  for (const c of classified) {
    const group = groups.get(c.category) ?? [];
    group.push(c);
    groups.set(c.category, group);
  }
  return groups;
}

/** Generate archetype name from category. */
export function archetypeName(category: ArchetypeCategory, queryContext: string): string {
  const base = queryContext.split(/\s+/).slice(0, 3).join(" ");
  switch (category) {
    case "minimal_inline": return `Minimal ${base}`;
    case "configurable_utility": return `Configurable ${base}`;
    case "middleware_decorator": return `${base} middleware`;
    case "context_aware": return `Context-aware ${base}`;
    case "distributed_backed": return `Distributed ${base}`;
    case "enterprise_heavy": return `Enterprise ${base}`;
    case "wrapper_adapter": return `${base} wrapper`;
  }
}

/** Generate tradeoff descriptions for a category. */
export function archetypeTradeoffs(category: ArchetypeCategory): string[] {
  switch (category) {
    case "minimal_inline":
      return ["Simple, copy-paste ready", "No configuration", "May lack edge case handling"];
    case "configurable_utility":
      return ["Flexible options", "Good for reuse", "Slightly more complex setup"];
    case "middleware_decorator":
      return ["Framework-integrated", "Request pipeline compatible", "Framework-dependent"];
    case "context_aware":
      return ["Handles cancellation/timeouts", "Production-ready", "More complex API"];
    case "distributed_backed":
      return ["Supports distributed deployments", "Requires external store (Redis/DB)", "Higher operational complexity", "Better for multi-instance scaling"];
    case "enterprise_heavy":
      return ["Full-featured", "Well-tested", "Heavy dependencies", "Complex config"];
    case "wrapper_adapter":
      return ["Thin abstraction", "Easy to swap", "Depends on underlying package"];
  }
}

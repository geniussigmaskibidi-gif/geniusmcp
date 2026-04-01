// Research: Aider repo maps, js-callgraph (Persper), Sourcegraph symbol graph.
// Approach: pattern matching + import refinement = 80% accuracy, 5% complexity.

import type { SymbolKind } from "@forgemcp/core";

export interface CallGraphSymbol {
  readonly id: number;
  readonly blobSha: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
}

export type EdgeConfidence = "exact" | "typed" | "import_scoped" | "lexical_local" | "lexical_global";

export interface CallEdge {
  readonly sourceId: number;
  readonly targetId: number | null;
  readonly targetName: string;
  readonly edgeKind: "calls" | "method_call";
  readonly line: number;
  readonly external: boolean;
  readonly confidence: EdgeConfidence;  // NEW: precision level of this edge
  readonly resolver: "scip" | "tree-sitter" | "import-alias" | "same-file" | "regex-fallback";
}

const SKIP = new Set([
  "console","require","import","export","typeof","instanceof","if","else",
  "for","while","do","switch","case","break","continue","return","throw",
  "try","catch","finally","new","delete","void","in","of","class","extends",
  "super","this","true","false","null","undefined","parseInt","parseFloat",
  "JSON","Math","Date","RegExp","Error","Promise","Array","Object","String",
  "Number","Boolean","Symbol","Map","Set","WeakMap","WeakSet","setTimeout",
  "setInterval","clearTimeout","clearInterval","fetch","Buffer","process",
  "print","len","range","enumerate","zip","sorted","list","dict","set",
  "tuple","int","float","str","bool","type","isinstance","self","cls",
  "fmt","log","make","append","cap","copy","close","panic","recover",
  "println","eprintln","format","vec","Box","Rc","Arc","Some","None",
  "Ok","Err","todo","unimplemented","then","catch","finally","toString",
  "valueOf","hasOwnProperty",
]);

function extractCallSites(sym: CallGraphSymbol): Array<{
  callerId: number; calleeName: string; line: number; isMethod: boolean;
}> {
  const sites: Array<{ callerId: number; calleeName: string; line: number; isMethod: boolean }> = [];
  const code = sym.code;

  // Direct calls: `functionName(`
  const directRx = /(?<!\.)(?<!\w)\b([a-zA-Z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = directRx.exec(code)) !== null) {
    const name = m[1]!;
    if (SKIP.has(name) || name === sym.name || name.length < 2) continue;
    const lineOff = code.slice(0, m.index).split("\n").length - 1;
    sites.push({ callerId: sym.id, calleeName: name, line: sym.startLine + lineOff, isMethod: false });
  }

  // Method calls: `.methodName(`
  const methodRx = /\.([a-zA-Z_]\w*)\s*\(/g;
  while ((m = methodRx.exec(code)) !== null) {
    const name = m[1]!;
    if (SKIP.has(name) || name.length < 2) continue;
    const lineOff = code.slice(0, m.index).split("\n").length - 1;
    sites.push({ callerId: sym.id, calleeName: name, line: sym.startLine + lineOff, isMethod: true });
  }

  return sites;
}

/** Build call graph: 2-pass syntactic + import-aware resolution. */
export function buildCallGraph(symbols: CallGraphSymbol[]): {
  edges: CallEdge[];
  unresolvedCalls: string[];
} {
  const nameIdx = new Map<string, CallGraphSymbol[]>();
  for (const s of symbols) {
    const arr = nameIdx.get(s.name) ?? [];
    arr.push(s);
    nameIdx.set(s.name, arr);
  }

  const edges: CallEdge[] = [];
  const unresolved = new Set<string>();

  for (const sym of symbols) {
    for (const site of extractCallSites(sym)) {
      const candidates = nameIdx.get(site.calleeName);
      if (!candidates?.length) {
        unresolved.add(site.calleeName);
        edges.push({
          sourceId: site.callerId, targetId: null, targetName: site.calleeName,
          edgeKind: site.isMethod ? "method_call" : "calls", line: site.line, external: true,
          confidence: "lexical_global", resolver: "regex-fallback",
        });
        continue;
      }

      // Resolve: same file > exported > any (pessimistic)
      const sameFile = candidates.filter(c => c.blobSha === sym.blobSha && c.id !== sym.id);
      const exported = candidates.filter(c => c.exported && c.id !== sym.id);
      const resolved = sameFile.length ? sameFile : exported.length ? exported : candidates.filter(c => c.id !== sym.id);

      const seen = new Set<number>();
      for (const t of resolved) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        // Determine confidence based on resolution path
        const conf: EdgeConfidence = sameFile.includes(t) ? "lexical_local" : "import_scoped";
        edges.push({
          sourceId: site.callerId, targetId: t.id, targetName: t.name,
          edgeKind: site.isMethod ? "method_call" : "calls", line: site.line, external: false,
          confidence: conf, resolver: sameFile.includes(t) ? "same-file" : "import-alias",
        });
      }
    }
  }

  return { edges, unresolvedCalls: [...unresolved] };
}

/** Build adjacency lists for fast traversal. */
export function buildAdjacency(edges: CallEdge[]): {
  outgoing: Map<number, CallEdge[]>;
  incoming: Map<number, CallEdge[]>;
} {
  const outgoing = new Map<number, CallEdge[]>();
  const incoming = new Map<number, CallEdge[]>();
  for (const e of edges) {
    const out = outgoing.get(e.sourceId) ?? [];
    out.push(e);
    outgoing.set(e.sourceId, out);
    if (e.targetId !== null) {
      const inc = incoming.get(e.targetId) ?? [];
      inc.push(e);
      incoming.set(e.targetId, inc);
    }
  }
  return { outgoing, incoming };
}

/** BFS: all symbols reachable from startId within maxDepth. */
export function reachableFrom(
  outgoing: Map<number, CallEdge[]>,
  startId: number,
  maxDepth = 5,
): Array<{ symbolId: number; depth: number }> {
  const visited = new Map<number, number>();
  const queue: Array<[number, number]> = [[startId, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (visited.has(id) || d > maxDepth) continue;
    visited.set(id, d);
    for (const e of outgoing.get(id) ?? []) {
      if (e.targetId !== null && !visited.has(e.targetId)) {
        queue.push([e.targetId, d + 1]);
      }
    }
  }
  visited.delete(startId);
  return [...visited.entries()].map(([symbolId, depth]) => ({ symbolId, depth }));
}

/** BFS shortest path from → to. Returns symbol ID path or null. */
export function tracePath(
  outgoing: Map<number, CallEdge[]>,
  fromId: number,
  toId: number,
  maxDepth = 10,
): number[] | null {
  if (fromId === toId) return [fromId];
  const parent = new Map<number, number>();
  parent.set(fromId, -1);
  const queue: Array<[number, number]> = [[fromId, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (d >= maxDepth) continue;
    for (const e of outgoing.get(id) ?? []) {
      if (e.targetId === null || parent.has(e.targetId)) continue;
      parent.set(e.targetId, id);
      if (e.targetId === toId) {
        const path: number[] = [];
        let cur = toId;
        while (cur !== -1) { path.unshift(cur); cur = parent.get(cur) ?? -1; }
        return path;
      }
      queue.push([e.targetId, d + 1]);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Architecture Detection
// ─────────────────────────────────────────────────────────────

export interface ModuleInfo {
  readonly path: string;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly role: string;
}

export interface ArchitectureMap {
  readonly type: string;
  readonly modules: ModuleInfo[];
  readonly entryPoint: string | null;
  readonly hotPaths: string[];
}

const DIR_ROLES: Record<string, string> = {
  "src/routes": "API endpoints", "src/api": "API endpoints",
  "src/controllers": "Request handlers", "src/middleware": "Request pipeline",
  "src/services": "Business logic", "src/models": "Data models",
  "src/db": "Data access", "src/database": "Data access",
  "src/utils": "Utilities", "src/helpers": "Utilities",
  "src/lib": "Core library", "src/types": "Type definitions",
  "src/config": "Configuration", "test": "Tests", "tests": "Tests",
  "src/__tests__": "Tests", "src/tests": "Tests",
};

const ENTRY_FILES = new Set([
  "index.ts","index.js","main.ts","main.go","main.rs","app.ts","server.ts","mod.rs",
]);

export function detectArchitecture(
  files: Array<{ path: string; symbolCount: number }>,
): ArchitectureMap {
  const mods = new Map<string, { files: string[]; symbols: number }>();
  let entry: string | null = null;

  for (const f of files) {
    const parts = f.path.split("/");
    const key = parts.length <= 2 ? (parts[0] ?? ".") : parts.slice(0, 2).join("/");
    const mod = mods.get(key) ?? { files: [], symbols: 0 };
    mod.files.push(f.path);
    mod.symbols += f.symbolCount;
    mods.set(key, mod);

    const base = parts[parts.length - 1]?.toLowerCase() ?? "";
    if (ENTRY_FILES.has(base) && (!entry || f.path.length < entry.length)) {
      entry = f.path;
    }
  }

  const infos: ModuleInfo[] = [];
  for (const [path, mod] of mods) {
    const role = DIR_ROLES[path] ?? inferRole(path, mod.symbols);
    infos.push({ path, fileCount: mod.files.length, symbolCount: mod.symbols, role });
  }
  infos.sort((a, b) => b.symbolCount - a.symbolCount);

  const names = new Set(mods.keys());
  let type = "flat";
  const has = (ps: string[]) => ps.every(p => [...names].some(n => n.toLowerCase().includes(p)));
  if (has(["routes","controllers","models"])) type = "MVC";
  else if (has(["services","controllers"])) type = "layered";
  else if ([...names].filter(n => n.toLowerCase().includes("service")).length > 3) type = "microservices";
  else if (infos.length > 1) type = "modular";

  return { type, modules: infos, entryPoint: entry, hotPaths: infos.slice(0, 3).map(m => m.path) };
}

function inferRole(path: string, symCount: number): string {
  const l = path.toLowerCase();
  if (l.includes("auth")) return "Authentication";
  if (l.includes("error")) return "Error handling";
  if (l.includes("cache")) return "Caching";
  if (l.includes("queue") || l.includes("worker")) return "Jobs";
  if (l.includes("search")) return "Search";
  if (l.includes("plugin")) return "Plugins";
  if (symCount > 20) return "Core module";
  return "Module";
}

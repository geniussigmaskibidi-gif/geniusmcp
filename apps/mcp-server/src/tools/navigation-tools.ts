// @ts-nocheck
import {
  buildForgeTool,
  clamp,
  err,
  ok,
  type CallGraphEdge,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
  type PackageDependency,
  type SymbolRecord,
  type WorkspaceGateway,
} from '@forgemcp/core/tool-factory';

function createReadTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool({
    name,
    description,
    category: 'navigation',
    inputSchema,
    tags: ['code', 'navigation'],
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute,
  });
}

function requireWorkspace(ctx: ForgeToolContext): ForgeResult<WorkspaceGateway> {
  return ctx.services.workspace ? ok(ctx.services.workspace) : err('SERVICE_UNAVAILABLE', 'Workspace gateway is required for navigation tools');
}

async function listSymbols(ctx: ForgeToolContext, scope?: string): Promise<ForgeResult<readonly SymbolRecord[]>> {
  const workspace = requireWorkspace(ctx);
  if (!workspace.ok) {
    return workspace;
  }
  return workspace.value.listSymbols(scope);
}

async function listEdges(ctx: ForgeToolContext, scope?: string): Promise<ForgeResult<readonly CallGraphEdge[]>> {
  const workspace = requireWorkspace(ctx);
  if (!workspace.ok) {
    return workspace;
  }
  return workspace.value.getCallGraph(scope);
}

async function findSymbol(ctx: ForgeToolContext, symbol: string, scope?: string): Promise<ForgeResult<SymbolRecord | null>> {
  const workspace = requireWorkspace(ctx);
  if (!workspace.ok) {
    return workspace;
  }
  const direct = await workspace.value.getSymbol(symbol, scope);
  if (direct.ok && direct.value) {
    return direct;
  }
  const symbols = await workspace.value.listSymbols(scope);
  if (!symbols.ok) {
    return err('NOT_FOUND', `Unable to list symbols while resolving ${symbol}`);
  }
  return ok(symbols.value.find((entry) => entry.name === symbol || entry.uid === symbol) ?? null);
}

function precisionRank(precision: CallGraphEdge['precision']): number {
  return {
    exact: 4,
    typed: 3,
    import_scoped: 2,
    lexical: 1,
  }[precision];
}

function parseImportsFromContent(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+[^'"\n]+from\s+['"]([^'"]+)['"]/gu,
    /import\s+['"]([^'"]+)['"]/gu,
    /require\(['"]([^'"]+)['"]\)/gu,
  ];
  patterns.forEach((pattern) => {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  });
  return [...imports];
}

function parseExportsFromContent(content: string): Array<{ name: string; kind: string }> {
  const exports: Array<{ name: string; kind: string }> = [];
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /export\s+function\s+([A-Za-z0-9_]+)/gu, kind: 'function' },
    { regex: /export\s+class\s+([A-Za-z0-9_]+)/gu, kind: 'class' },
    { regex: /export\s+interface\s+([A-Za-z0-9_]+)/gu, kind: 'interface' },
    { regex: /export\s+type\s+([A-Za-z0-9_]+)/gu, kind: 'type' },
    { regex: /export\s+const\s+([A-Za-z0-9_]+)/gu, kind: 'const' },
  ];
  patterns.forEach(({ regex, kind }) => {
    for (const match of content.matchAll(regex)) {
      if (match[1]) {
        exports.push({ name: match[1], kind });
      }
    }
  });
  return exports;
}

function modulePurpose(path: string, content: string): string {
  const comment = content.match(/\/\*\*([\s\S]{0,200}?)\*\//u)?.[1]?.replace(/\*/gu, '').trim();
  if (comment) {
    return comment;
  }
  if (/controller|route|handler/u.test(path)) return 'Request handling module';
  if (/service/u.test(path)) return 'Service orchestration module';
  if (/util|helper/u.test(path)) return 'Utility module';
  if (/config/u.test(path)) return 'Configuration module';
  return 'General application module';
}

function complexityOf(content: string): { cyclomatic: number; cognitive: number; hotspots: string[] } {
  const keywordMatches = content.match(/\b(if|for|while|case|catch|&&|\|\||\?)\b/gu) ?? [];
  const nestingMatches = content.match(/\{\s*(if|for|while|switch)/gu) ?? [];
  const cyclomatic = 1 + keywordMatches.length;
  const cognitive = cyclomatic + nestingMatches.length;
  const hotspots = [
    cyclomatic > 10 ? `cyclomatic>${cyclomatic}` : '',
    cognitive > 15 ? `cognitive>${cognitive}` : '',
    /Promise\.all/u.test(content) ? 'parallelism' : '',
    /eval\(|new Function/u.test(content) ? 'dynamic-eval' : '',
  ].filter(Boolean);
  return { cyclomatic, cognitive, hotspots };
}

function buildAsciiMap(files: readonly string[], importCounts: Readonly<Record<string, number>>): string {
  const sorted = [...files].sort();
  const lines: string[] = [];
  sorted.forEach((file) => {
    const parts = file.split('/');
    const indent = '  '.repeat(Math.max(0, parts.length - 1));
    lines.push(`${indent}${parts[parts.length - 1]} (${importCounts[file] ?? 0} imports)`);
  });
  return lines.join('\n');
}

function bfsPath(edges: readonly CallGraphEdge[], from: string, to: string, maxDepth: number): CallGraphEdge[] | null {
  const adjacency = new Map<string, CallGraphEdge[]>();
  edges.forEach((edge) => {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  });
  const queue: Array<{ node: string; path: CallGraphEdge[] }> = [{ node: from, path: [] }];
  const seen = new Set<string>([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (current.path.length > maxDepth) continue;
    if (current.node === to) return current.path;
    for (const edge of adjacency.get(current.node) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push({ node: edge.to, path: [...current.path, edge] });
    }
  }
  return null;
}

async function readContent(ctx: ForgeToolContext, path: string): Promise<ForgeResult<string>> {
  const workspace = requireWorkspace(ctx);
  if (!workspace.ok) return workspace;
  return workspace.value.readFile(path);
}

export function createNavigationTools(): ForgeTool<object, unknown>[] {
  const reachTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.reach',
    'Return a definition, signature, callers, callees, and dependencies for a symbol.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const [symbolResult, edgesResult] = await Promise.all([findSymbol(ctx, input.symbol, input.scope), listEdges(ctx, input.scope)]);
      if (!symbolResult.ok) return symbolResult;
      if (!edgesResult.ok) return edgesResult;
      const symbol = symbolResult.value;
      if (!symbol) return err('NOT_FOUND', `No symbol found for ${input.symbol}`);
      const callers = edgesResult.value
        .filter((edge) => edge.to === symbol.uid || edge.to === symbol.name)
        .sort((a, b) => precisionRank(b.precision) - precisionRank(a.precision));
      const callees = edgesResult.value
        .filter((edge) => edge.from === symbol.uid || edge.from === symbol.name)
        .sort((a, b) => precisionRank(b.precision) - precisionRank(a.precision));
      return ok({ symbol, callers, callees, dependencies: symbol.externalDeps ?? symbol.imports ?? [] });
    },
  );

  const mapTool = createReadTool<{ scope?: string }, Readonly<Record<string, unknown>>>(
    'code.map',
    'Generate an architecture map with entry points and import hotspots.',
    { type: 'object', properties: { scope: { type: 'string' } } },
    async (input, ctx) => {
      const workspace = requireWorkspace(ctx);
      if (!workspace.ok) return workspace;
      const files = await workspace.value.glob(['**/*.{ts,tsx,js,jsx,go,rs,py}']);
      if (!files.ok) return files;
      const importCounts: Record<string, number> = {};
      const entryPoints = files.value.filter((file) => /(^|\/)(main|index|app|server)\.(ts|tsx|js|jsx|py|go|rs)$/u.test(file));
      for (const file of files.value.slice(0, 200)) {
        const imports = await workspace.value.getImports(file);
        importCounts[file] = imports.ok ? imports.value.length : 0;
      }
      const hotspots = Object.entries(importCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([file, count]) => ({ file, imports: count }));
      return ok({ entryPoints, hotspots, map: buildAsciiMap(files.value.slice(0, 80), importCounts) });
    },
  );

  const traceTool = createReadTool<{ from: string; to: string; scope?: string; maxDepth?: number }, Readonly<Record<string, unknown>>>(
    'code.trace',
    'Compute a shortest call chain between two functions.',
    { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, scope: { type: 'string' }, maxDepth: { type: 'number' } } },
    async (input, ctx) => {
      const edgesResult = await listEdges(ctx, input.scope);
      if (!edgesResult.ok) return edgesResult;
      const path = bfsPath(edgesResult.value, input.from, input.to, input.maxDepth ?? 5);
      return path ? ok({ path, length: path.length }) : err('NOT_FOUND', `No path found from ${input.from} to ${input.to}`);
    },
  );

  const symbolsTool = createReadTool<{ scope?: string }, Readonly<Record<string, unknown>>>(
    'code.symbols',
    'List exported symbols in a scope grouped by kind and sorted by impact.',
    { type: 'object', properties: { scope: { type: 'string' } } },
    async (input, ctx) => {
      const symbols = await listSymbols(ctx, input.scope);
      if (!symbols.ok) return symbols;
      const grouped = symbols.value
        .filter((symbol) => symbol.exported)
        .sort((a, b) => (b.referencesCount ?? 0) - (a.referencesCount ?? 0))
        .reduce<Record<string, SymbolRecord[]>>((acc, symbol) => {
          acc[symbol.kind] = [...(acc[symbol.kind] ?? []), symbol];
          return acc;
        }, {});
      return ok({ grouped });
    },
  );

  const understandTool = createReadTool<{ path: string }, Readonly<Record<string, unknown>>>(
    'code.understand',
    'Compress a module into purpose, exports, data flow, external dependencies, and complexity.',
    { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    async (input, ctx) => {
      const content = await readContent(ctx, input.path);
      if (!content.ok) return content;
      const imports = parseImportsFromContent(content.value);
      const exports = parseExportsFromContent(content.value);
      const complexity = complexityOf(content.value);
      return ok({
        path: input.path,
        purpose: modulePurpose(input.path, content.value),
        exports,
        dataFlow: { imports, transforms: complexity.hotspots, exports: exports.map((entry) => entry.name) },
        externalDeps: imports.filter((entry) => !entry.startsWith('.')),
        complexity,
      });
    },
  );

  const callersTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.callers',
    'List reverse call-graph edges into a symbol.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const [symbolResult, edgesResult] = await Promise.all([findSymbol(ctx, input.symbol, input.scope), listEdges(ctx, input.scope)]);
      if (!symbolResult.ok) return symbolResult;
      if (!edgesResult.ok) return edgesResult;
      const target = symbolResult.value;
      if (!target) return err('NOT_FOUND', `No symbol found for ${input.symbol}`);
      const callers = edgesResult.value.filter((edge) => (edge.to === target.uid || edge.to === target.name) && precisionRank(edge.precision) >= precisionRank('import_scoped'));
      return ok({ symbol: target, callers });
    },
  );

  const calleesTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.callees',
    'List forward call-graph edges out of a symbol.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const [symbolResult, edgesResult] = await Promise.all([findSymbol(ctx, input.symbol, input.scope), listEdges(ctx, input.scope)]);
      if (!symbolResult.ok) return symbolResult;
      if (!edgesResult.ok) return edgesResult;
      const target = symbolResult.value;
      if (!target) return err('NOT_FOUND', `No symbol found for ${input.symbol}`);
      const callees = edgesResult.value.filter((edge) => edge.from === target.uid || edge.from === target.name);
      return ok({ symbol: target, local: callees.filter((edge) => !edge.to.includes('/')), external: callees.filter((edge) => edge.to.includes('/')) });
    },
  );

  const importsTool = createReadTool<{ path: string; depth?: number }, Readonly<Record<string, unknown>>>(
    'code.imports',
    'Walk a file import graph to a bounded depth and flag cycles.',
    { type: 'object', required: ['path'], properties: { path: { type: 'string' }, depth: { type: 'number' } } },
    async (input, ctx) => {
      const workspace = requireWorkspace(ctx);
      if (!workspace.ok) return workspace;
      const depth = Math.max(1, input.depth ?? 3);
      const tree: Array<{ path: string; depth: number; imports: readonly string[] }> = [];
      const cycles: string[] = [];
      const visit = async (path: string, currentDepth: number, seen: Set<string>): Promise<void> => {
        const imports = await workspace.value.getImports(path);
        if (!imports.ok) return;
        tree.push({ path, depth: currentDepth, imports: imports.value });
        if (currentDepth >= depth) return;
        for (const child of imports.value.filter((entry) => entry.startsWith('.'))) {
          if (seen.has(child)) {
            cycles.push(`${path} -> ${child}`);
            continue;
          }
          seen.add(child);
          await visit(child, currentDepth + 1, seen);
          seen.delete(child);
        }
      };
      await visit(input.path, 0, new Set([input.path]));
      return ok({ tree, cycles: [...new Set(cycles)] });
    },
  );

  const exportsTool = createReadTool<{ path: string }, Readonly<Record<string, unknown>>>(
    'code.exports',
    'Return the public export surface of a module.',
    { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    async (input, ctx) => {
      const symbols = await listSymbols(ctx, input.path);
      if (symbols.ok && symbols.value.length > 0) {
        return ok({ exports: symbols.value.filter((symbol) => symbol.path === input.path && symbol.exported) });
      }
      const content = await readContent(ctx, input.path);
      if (!content.ok) return content;
      return ok({ exports: parseExportsFromContent(content.value) });
    },
  );

  const dependenciesTool = createReadTool<{ scope?: string }, Readonly<Record<string, unknown>>>(
    'code.dependencies',
    'Inspect external dependencies with version and license hints.',
    { type: 'object', properties: { scope: { type: 'string' } } },
    async (input, ctx) => {
      const workspace = requireWorkspace(ctx);
      if (!workspace.ok) return workspace;
      const deps = await workspace.value.getDependencies(input.scope);
      if (!deps.ok) return deps;
      const grouped = deps.value.reduce<Record<string, PackageDependency[]>>((acc, dep) => {
        const bucket = dep.direct ? 'direct' : 'transitive';
        acc[bucket] = [...(acc[bucket] ?? []), dep];
        return acc;
      }, {});
      return ok({ grouped });
    },
  );

  const referencesTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.references',
    'Find references to a symbol across the project.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const workspace = requireWorkspace(ctx);
      if (!workspace.ok) return workspace;
      const refs = await workspace.value.findText(input.symbol, { scope: input.scope, limit: 100 });
      return refs.ok ? ok({ references: refs.value }) : refs;
    },
  );

  const definitionTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.definition',
    'Jump to the highest-confidence definition of a symbol.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const workspace = requireWorkspace(ctx);
      if (!workspace.ok) return workspace;
      if (workspace.value.resolveDefinition) {
        const resolved = await workspace.value.resolveDefinition(input.symbol, input.scope);
        if (resolved.ok && resolved.value) {
          return ok({ definition: resolved.value });
        }
      }
      const symbol = await findSymbol(ctx, input.symbol, input.scope);
      return symbol.ok ? (symbol.value ? ok({ definition: symbol.value }) : err('NOT_FOUND', `No definition found for ${input.symbol}`)) : symbol;
    },
  );

  const hoverTool = createReadTool<{ symbol: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.hover',
    'Return type, docs, container, and export info for a symbol.',
    { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const symbol = await findSymbol(ctx, input.symbol, input.scope);
      if (!symbol.ok) return symbol;
      if (!symbol.value) return err('NOT_FOUND', `No symbol found for ${input.symbol}`);
      return ok({
        kind: symbol.value.kind,
        signature: symbol.value.signature,
        docComment: symbol.value.docComment,
        container: symbol.value.container,
        exported: symbol.value.exported,
        path: symbol.value.path,
      });
    },
  );

  const complexityTool = createReadTool<{ path?: string; symbol?: string; scope?: string }, Readonly<Record<string, unknown>>>(
    'code.complexity',
    'Estimate cyclomatic and cognitive complexity for a file or symbol.',
    { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      if (!input.path && !input.symbol) {
        return err('INVALID_INPUT', 'Provide either path or symbol');
      }
      let path = input.path;
      if (!path && input.symbol) {
        const symbol = await findSymbol(ctx, input.symbol, input.scope);
        if (!symbol.ok) return symbol;
        path = symbol.value?.path;
      }
      if (!path) return err('NOT_FOUND', 'Unable to resolve target path');
      const content = await readContent(ctx, path);
      if (!content.ok) return content;
      const complexity = complexityOf(content.value);
      return ok({ path, ...complexity, risk: clamp(complexity.cyclomatic / 20) });
    },
  );

  const deadCodeTool = createReadTool<{ scope?: string }, Readonly<Record<string, unknown>>>(
    'code.dead_code',
    'Find likely-unused exports by subtracting imported symbols from exported symbols.',
    { type: 'object', properties: { scope: { type: 'string' } } },
    async (input, ctx) => {
      const [symbolsResult, edgesResult] = await Promise.all([listSymbols(ctx, input.scope), listEdges(ctx, input.scope)]);
      if (!symbolsResult.ok) return symbolsResult;
      if (!edgesResult.ok) return edgesResult;
      const exported = symbolsResult.value.filter((symbol) => symbol.exported);
      const referenced = new Set(edgesResult.value.map((edge) => edge.to));
      const unused = exported
        .filter((symbol) => !referenced.has(symbol.uid) && !referenced.has(symbol.name))
        .map((symbol) => ({ ...symbol, confidence: 1 - Math.min(1, (symbol.referencesCount ?? 0) / 3) }));
      const dynamicImportDetected = edgesResult.value.some((edge) => edge.kind === 'imports' && edge.precision === 'lexical');
      return ok({ unused, confidence: dynamicImportDetected ? 'medium' : 'high' });
    },
  );

  return [
    reachTool,
    mapTool,
    traceTool,
    symbolsTool,
    understandTool,
    callersTool,
    calleesTool,
    importsTool,
    exportsTool,
    dependenciesTool,
    referencesTool,
    definitionTool,
    hoverTool,
    complexityTool,
    deadCodeTool,
  ] as ForgeTool<object, unknown>[];
}

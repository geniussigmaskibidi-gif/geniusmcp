// @ts-nocheck
import {
  buildForgeTool,
  err,
  ok,
  type CallGraphEdge,
  type ConflictReport,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
  type ImportSlice,
  type PolicyDecision,
  type StylePreferences,
} from '@forgemcp/core/tool-factory';

const TRACKED_UPSTREAM_KEY = 'forge:import:tracked-upstream';

interface ImportPlan {
  readonly primaryUid: string;
  readonly symbols: readonly string[];
  readonly files: readonly string[];
  readonly localDeps: readonly string[];
  readonly externalPackages: readonly string[];
  readonly licenseVerdict: PolicyDecision;
  readonly conflicts: ConflictReport;
  readonly styleSuggestions: Readonly<Record<string, unknown>>;
  readonly source?: {
    readonly repo?: string;
    readonly path?: string;
    readonly ref?: string;
  };
  readonly code?: string;
}

interface TrackedUpstreamEntry {
  readonly repo: string;
  readonly path: string;
  readonly ref?: string;
  readonly localPath?: string;
  readonly license?: string;
  readonly trackedAt: string;
}

function createReadTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool({
    name,
    description,
    category: 'import',
    inputSchema,
    tags: ['import', 'provenance'],
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute,
  });
}

function createWriteTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool({
    name,
    description,
    category: 'import',
    inputSchema,
    tags: ['import', 'provenance'],
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute,
  });
}

function parseRepoRef(repoRef: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoRef.split('/');
  return owner && repo ? { owner, repo } : null;
}

function parseImports(code: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+[^'"\n]+from\s+['"]([^'"]+)['"]/gu,
    /import\s+['"]([^'"]+)['"]/gu,
    /require\(['"]([^'"]+)['"]\)/gu,
  ];
  patterns.forEach((pattern) => {
    for (const match of code.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  });
  return [...imports];
}

function adaptStyle(code: string, style: StylePreferences): string {
  let next = code;
  if (style.quotes === 'single') {
    next = next.replace(/"([^"\n]*)"/gu, (_, group: string) => `'${group.replace(/'/gu, "\\'")}'`);
  }
  if (style.quotes === 'double') {
    next = next.replace(/'([^'\n]*)'/gu, (_, group: string) => `"${group.replace(/"/gu, '\\"')}"`);
  }
  if (!style.semicolons) {
    next = next.replace(/;(?=\s*(?:\n|$))/gu, '');
  }
  if (style.semicolons) {
    next = next.replace(/([^;\s{}])\n/gu, '$1;\n');
  }
  const indent = ' '.repeat(style.indent);
  next = next.replace(/^ {2,}/gmu, (spaces) => indent.repeat(Math.max(1, Math.round(spaces.length / 2))));
  return next;
}

function attributionComment(input: { repo: string; path: string; license?: string; sha?: string }): string {
  const lines = [
    '/**',
    ` * Imported from ${input.repo}/${input.path}`,
    ` * SPDX-License-Identifier: ${input.license ?? 'UNKNOWN'}`,
    input.sha ? ` * Provenance-SHA: ${input.sha}` : ' * Provenance-SHA: unavailable',
    ' */',
  ];
  return lines.join('\n');
}

function diffSummary(localCode: string, upstreamCode: string): Readonly<Record<string, unknown>> {
  const localLines = localCode.split('\n');
  const upstreamLines = upstreamCode.split('\n');
  let changed = 0;
  const examples: string[] = [];
  const max = Math.max(localLines.length, upstreamLines.length);
  for (let index = 0; index < max; index += 1) {
    if ((localLines[index] ?? '') !== (upstreamLines[index] ?? '')) {
      changed += 1;
      if (examples.length < 5) {
        examples.push(`L${index + 1}: ${upstreamLines[index] ?? ''} -> ${localLines[index] ?? ''}`);
      }
    }
  }
  return { changedLines: changed, localLines: localLines.length, upstreamLines: upstreamLines.length, examples };
}

async function detectStyle(ctx: ForgeToolContext, scope?: string): Promise<StylePreferences> {
  const workspace = ctx.services.workspace;
  if (!workspace?.detectStyle) {
    return { quotes: 'single', semicolons: true, indent: 2 };
  }
  const result = await workspace.detectStyle(scope);
  return result.ok ? result.value : { quotes: 'single', semicolons: true, indent: 2 };
}

async function buildPlan(
  input: { primaryUid: string; symbols?: string[]; edges?: CallGraphEdge[]; workspaceSymbols?: string[]; policyMode?: string; license?: string | null; source?: { repo?: string; path?: string; ref?: string }; code?: string },
  ctx: ForgeToolContext,
): Promise<ForgeResult<ImportPlan>> {
  const resolver = ctx.services.sliceResolver;
  if (!resolver) return err('SERVICE_UNAVAILABLE', 'Slice resolver is required for import planning');
  const sliceResult = await resolver.resolveSliceClosure(input.primaryUid, input.symbols ?? [], input.edges ?? []);
  if (!sliceResult.ok) return sliceResult;
  const slice = sliceResult.value;
  if (!slice) return err('NOT_FOUND', `No import slice found for ${input.primaryUid}`);
  const conflicts = ctx.services.conflictDetector
    ? await ctx.services.conflictDetector.detectConflicts(slice.symbols, input.workspaceSymbols ?? [])
    : ok<ConflictReport>({ hasConflicts: false, conflicts: [] });
  if (!conflicts.ok) return conflicts;
  const verdict = ctx.services.policyEngine
    ? await ctx.services.policyEngine.evaluatePolicy(input.policyMode ?? 'default', input.license, {
        externalPackages: slice.externalPackages.length,
        files: slice.files.length,
      })
    : { verdict: 'allow' as const };
  const style = await detectStyle(ctx);
  return ok({
    primaryUid: input.primaryUid,
    symbols: slice.symbols,
    files: slice.files,
    localDeps: slice.localDeps,
    externalPackages: slice.externalPackages,
    licenseVerdict: verdict,
    conflicts: conflicts.value,
    styleSuggestions: { ...style },
    source: input.source,
    code: input.code ?? slice.code,
  });
}

export function createImportTools(): ForgeTool<object, unknown>[] {
  const extractTool = createWriteTool<{ plan: ImportPlan; prependAttribution?: boolean; scope?: string }, Readonly<Record<string, unknown>>>(
    'import.extract',
    'Extract code for an import plan, adapt style, and emit attribution.',
    { type: 'object', required: ['plan'], properties: { plan: { type: 'object' }, prependAttribution: { type: 'boolean' }, scope: { type: 'string' } } },
    async (input, ctx) => {
      const plan = input.plan;
      if (plan.licenseVerdict.verdict === 'deny') {
        return err('PERMISSION_DENIED', plan.licenseVerdict.reason ?? 'Import blocked by policy');
      }
      let code = plan.code ?? '';
      if (!code && plan.source?.repo && plan.source.path && ctx.services.gitHubGateway) {
        const parsed = parseRepoRef(plan.source.repo);
        if (!parsed) return err('INVALID_INPUT', 'Plan source repo must be owner/name');
        const content = await ctx.services.gitHubGateway.getFileContent(parsed.owner, parsed.repo, plan.source.path, plan.source.ref);
        if (!content.ok) return content;
        code = content.value;
      }
      const style = await detectStyle(ctx, input.scope);
      const adapted = adaptStyle(code, style);
      const attribution = plan.source?.repo && plan.source.path
        ? attributionComment({ repo: plan.source.repo, path: plan.source.path, license: String(plan.licenseVerdict.metadata?.license ?? 'UNKNOWN'), sha: undefined })
        : '';
      return ok({
        code: input.prependAttribution === false || !attribution ? adapted : `${attribution}\n${adapted}`,
        attribution,
        style,
        symbols: plan.symbols,
      });
    },
  );

  const planTool = createReadTool<
    { primaryUid: string; symbols?: string[]; edges?: CallGraphEdge[]; workspaceSymbols?: string[]; policyMode?: string; license?: string | null; source?: { repo?: string; path?: string; ref?: string }; code?: string },
    Readonly<Record<string, unknown>>
  >(
    'import.plan',
    'Resolve a provenance-aware import plan with dependencies, policy, and conflict analysis.',
    {
      type: 'object',
      required: ['primaryUid'],
      properties: { primaryUid: { type: 'string' }, policyMode: { type: 'string' }, license: { type: 'string' } },
    },
    async (input, ctx) => {
      const plan = await buildPlan(input, ctx);
      return plan.ok ? ok({ plan: plan.value }) : plan;
    },
  );

  const validateTool = createReadTool<{ plan: ImportPlan }, Readonly<Record<string, unknown>>>(
    'import.validate',
    'Validate that an import plan is internally consistent and dependency-complete.',
    { type: 'object', required: ['plan'], properties: { plan: { type: 'object' } } },
    async (input) => {
      const issues: string[] = [];
      if (input.plan.symbols.length === 0) issues.push('no_symbols');
      if (input.plan.files.length === 0) issues.push('no_files');
      if (input.plan.licenseVerdict.verdict === 'deny') issues.push('license_denied');
      if (input.plan.conflicts.hasConflicts) issues.push('symbol_conflicts');
      return ok({ valid: issues.length === 0, issues });
    },
  );

  const adaptStyleTool = createReadTool<{ code: string; scope?: string; style?: StylePreferences }, Readonly<Record<string, unknown>>>(
    'import.adapt_style',
    'Adapt imported code to match local quotes, semicolons, and indentation.',
    { type: 'object', required: ['code'], properties: { code: { type: 'string' }, scope: { type: 'string' }, style: { type: 'object' } } },
    async (input, ctx) => {
      const style = input.style ?? (await detectStyle(ctx, input.scope));
      return ok({ style, code: adaptStyle(input.code, style) });
    },
  );

  const checkLicenseTool = createReadTool<{ mode: string; license?: string | null; signals?: Record<string, unknown> }, Readonly<Record<string, unknown>>>(
    'import.check_license',
    'Evaluate import policy against license and context signals.',
    { type: 'object', required: ['mode'], properties: { mode: { type: 'string' }, license: { type: 'string' }, signals: { type: 'object' } } },
    async (input, ctx) => {
      const decision = ctx.services.policyEngine
        ? await ctx.services.policyEngine.evaluatePolicy(input.mode, input.license, input.signals ?? {})
        : { verdict: 'allow' as const };
      return ok({ decision });
    },
  );

  const resolveDepsTool = createReadTool<{ code?: string; symbols?: string[]; edges?: CallGraphEdge[] }, Readonly<Record<string, unknown>>>(
    'import.resolve_deps',
    'Resolve local and external dependencies required by an import slice.',
    { type: 'object', properties: { code: { type: 'string' }, symbols: { type: 'array' }, edges: { type: 'array' } } },
    async (input) => {
      const imports = input.code ? parseImports(input.code) : [];
      const localDeps = imports.filter((entry) => entry.startsWith('.'));
      const externalPackages = imports.filter((entry) => !entry.startsWith('.'));
      return ok({ localDeps, externalPackages, symbols: input.symbols ?? [], edgeCount: input.edges?.length ?? 0 });
    },
  );

  const detectConflictsTool = createReadTool<{ candidates: string[]; workspaceSymbols: string[] }, Readonly<Record<string, unknown>>>(
    'import.detect_conflicts',
    'Detect naming conflicts between imported symbols and the local workspace.',
    { type: 'object', required: ['candidates', 'workspaceSymbols'], properties: { candidates: { type: 'array', items: { type: 'string' } }, workspaceSymbols: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      if (!ctx.services.conflictDetector) {
        const conflicts = input.candidates.filter((candidate) => input.workspaceSymbols.includes(candidate)).map((symbol) => ({ symbol, reason: 'name collision', severity: 'medium' as const }));
        return ok({ hasConflicts: conflicts.length > 0, conflicts });
      }
      const result = await ctx.services.conflictDetector.detectConflicts(input.candidates, input.workspaceSymbols);
      return result.ok ? ok({ hasConflicts: result.value.hasConflicts, conflicts: result.value.conflicts }) : result;
    },
  );

  const generateAttributionTool = createReadTool<{ repo: string; path: string; license?: string; sha?: string }, Readonly<Record<string, unknown>>>(
    'import.generate_attribution',
    'Generate an attribution comment with provenance metadata.',
    { type: 'object', required: ['repo', 'path'], properties: { repo: { type: 'string' }, path: { type: 'string' }, license: { type: 'string' }, sha: { type: 'string' } } },
    async (input) => ok({ attribution: attributionComment(input) }),
  );

  const trackUpstreamTool = createWriteTool<{ repo: string; path: string; ref?: string; localPath?: string; license?: string }, Readonly<Record<string, unknown>>>(
    'import.track_upstream',
    'Track an imported upstream file for later drift detection.',
    { type: 'object', required: ['repo', 'path'], properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' }, localPath: { type: 'string' }, license: { type: 'string' } } },
    async (input, ctx) => {
      const state = (await ctx.state.getJson<Record<string, TrackedUpstreamEntry>>(TRACKED_UPSTREAM_KEY)) ?? {};
      const key = `${input.repo}:${input.path}`;
      state[key] = { ...input, trackedAt: new Date().toISOString() };
      await ctx.state.setJson(TRACKED_UPSTREAM_KEY, state);
      return ok({ key, entry: state[key] });
    },
  );

  const diffUpstreamTool = createReadTool<{ repo: string; path: string; ref?: string; localCode: string }, Readonly<Record<string, unknown>>>(
    'import.diff_upstream',
    'Diff local imported code against current upstream content.',
    { type: 'object', required: ['repo', 'path', 'localCode'], properties: { repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' }, localCode: { type: 'string' } } },
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      const parsed = parseRepoRef(input.repo);
      if (!gateway || !parsed) return err('INVALID_INPUT', 'Provide repo as owner/name');
      const upstream = await gateway.getFileContent(parsed.owner, parsed.repo, input.path, input.ref);
      if (!upstream.ok) return upstream;
      return ok({ diff: diffSummary(input.localCode, upstream.value) });
    },
  );

  return [
    extractTool,
    planTool,
    validateTool,
    adaptStyleTool,
    checkLicenseTool,
    resolveDepsTool,
    detectConflictsTool,
    generateAttributionTool,
    trackUpstreamTool,
    diffUpstreamTool,
  ] as ForgeTool<object, unknown>[];
}

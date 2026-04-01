// @ts-nocheck
import {
  buildForgeTool,
  clamp,
  err,
  mean,
  normalizeWhitespace,
  nowIso,
  ok,
  tokenize,
  type CodeSearchHit,
  type ForgePreset,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
  type QualityBreakdown,
  type RepoOverview,
  type SourceScatterQuery,
  type WinnowingFingerprint,
} from '@forgemcp/core/tool-factory';
import { compileDiscoveryQueries, type DiscoveryQueryInput, type QueryMode } from '@forgemcp/data-sources';
import { upsertEvidenceNodes } from './evidence-tools.js';

interface RankedCandidate {
  readonly hit: CodeSearchHit;
  readonly repo?: RepoOverview;
  readonly fingerprint?: WinnowingFingerprint;
  readonly contentHash?: string;
  readonly simhash?: bigint;
  readonly breakdown: QualityBreakdown;
  readonly score: number;
  readonly category: string;
  readonly archetypeName: string;
  readonly tradeoffs: readonly string[];
  readonly why: readonly string[];
}

interface ArchetypeCluster {
  readonly name: string;
  readonly category: string;
  readonly score: number;
  readonly tradeoffs: readonly string[];
  readonly examples: readonly RankedCandidate[];
}

const PRESET_MMR_LAMBDA: Record<ForgePreset, number> = {
  balanced: 0.72,
  battle_tested: 0.78,
  teaching_quality: 0.68,
  import_ready: 0.74,
};

function createReadTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool({
    name,
    description,
    category: 'discovery',
    inputSchema,
    tags: ['discovery', 'genius'],
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    interruptBehavior: () => 'cancel',
    execute,
  });
}

function candidateText(hit: CodeSearchHit): string {
  return normalizeWhitespace(`${hit.path} ${hit.snippet ?? ''} ${hit.content ?? ''}`);
}

function lexicalScore(query: string, hit: CodeSearchHit): number {
  const queryTokens = new Set(tokenize(query));
  const hitTokens = new Set(tokenize(candidateText(hit)));
  if (queryTokens.size === 0 || hitTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  queryTokens.forEach((token) => {
    if (hitTokens.has(token)) {
      overlap += 1;
    }
  });
  return overlap / Math.max(1, queryTokens.size);
}

function structuralScore(hit: CodeSearchHit): number {
  const path = hit.path.toLowerCase();
  let score = 0.25;
  if (/src\//u.test(path)) score += 0.15;
  if (/test|spec|__tests__/u.test(path)) score += 0.1;
  if (/readme|changelog/u.test(path)) score -= 0.05;
  if (/index|main|app|server/u.test(path)) score += 0.1;
  if ((hit.content ?? hit.snippet ?? '').length > 150) score += 0.15;
  if (hit.language) score += 0.1;
  return clamp(score);
}

function semanticScore(query: string, hit: CodeSearchHit): number {
  const normalizedQuery = query.toLowerCase();
  const text = candidateText(hit).toLowerCase();
  if (text.includes(normalizedQuery)) {
    return 0.95;
  }
  const bigrams = normalizedQuery.split(' ').filter((part) => part.length > 2);
  if (bigrams.some((part) => text.includes(part))) {
    return 0.7;
  }
  return lexicalScore(query, hit);
}

function recencyScore(dateString?: string): number {
  if (!dateString) {
    return 0.5;
  }
  const ageDays = Math.max(0, (Date.now() - Date.parse(dateString)) / (1000 * 60 * 60 * 24));
  if (ageDays <= 30) return 0.95;
  if (ageDays <= 90) return 0.8;
  if (ageDays <= 365) return 0.65;
  if (ageDays <= 730) return 0.5;
  return 0.35;
}

function durabilityScore(repo?: RepoOverview): number {
  if (!repo) {
    return 0.45;
  }
  const stars = repo.stars ?? 0;
  const starBoost = clamp(Math.log10(1 + stars) / 5);
  const testsBoost = repo.hasTests ? 0.12 : 0;
  const ciBoost = repo.ci ? 0.08 : 0;
  const forkPenalty = (repo.forks ?? 0) > 0 ? 0.04 : 0;
  return clamp(0.35 + starBoost + testsBoost + ciBoost + forkPenalty);
}

function vitalityScore(repo?: RepoOverview): number {
  if (!repo) {
    return 0.5;
  }
  let score = 0.35 + recencyScore(repo.pushedAt) * 0.45;
  if (repo.archived) {
    score = Math.min(score, 0.2);
  }
  return clamp(score);
}

function importabilityScore(repo?: RepoOverview): number {
  if (!repo) {
    return 0.45;
  }
  if (!repo.license) {
    return 0.2;
  }
  return clamp(0.6 + (repo.topics?.includes('library') ? 0.1 : 0) + (repo.primaryLanguage ? 0.05 : 0));
}

function evidenceConfidenceScore(hit: CodeSearchHit): number {
  if (!hit.content && hit.snippet) {
    return 0.6;
  }
  return clamp(hit.content ? 0.8 : 0.65);
}

function fallbackBreakdown(query: string, hit: CodeSearchHit, repo?: RepoOverview): QualityBreakdown {
  const lexical = lexicalScore(query, hit);
  const structural = structuralScore(hit);
  const semantic = semanticScore(query, hit);
  const retrieval = 0.5 * lexical + 0.35 * structural + 0.15 * semantic;
  let breakdown: QualityBreakdown = {
    queryFit: lexical,
    durability: durabilityScore(repo),
    vitality: vitalityScore(repo),
    importability: importabilityScore(repo),
    codeQuality: structural,
    evidenceConfidence: evidenceConfidenceScore(hit),
    retrieval,
    teachability: structural,
    penalties: 0,
  };
  if (!hit.content && hit.snippet) {
    breakdown = { ...breakdown, evidenceConfidence: Math.min(breakdown.evidenceConfidence, 0.6) };
  }
  if (repo?.archived) {
    breakdown = { ...breakdown, vitality: Math.min(breakdown.vitality, 0.2) };
  }
  if (!repo?.license) {
    breakdown = { ...breakdown, importability: Math.min(breakdown.importability, 0.2) };
  }
  return breakdown;
}

function fallbackComposite(breakdown: QualityBreakdown, preset: ForgePreset): number {
  const lambda = PRESET_MMR_LAMBDA[preset];
  const retrieval = breakdown.retrieval ?? 0;
  return clamp(
    lambda * retrieval +
      0.18 * breakdown.durability +
      0.15 * breakdown.vitality +
      0.12 * breakdown.importability +
      0.1 * breakdown.codeQuality +
      0.15 * breakdown.evidenceConfidence -
      0.12 * (breakdown.penalties ?? 0),
  );
}

async function maybeFingerprint(text: string, ctx: ForgeToolContext): Promise<{ fingerprint?: WinnowingFingerprint; contentHash?: string; simhash?: bigint }> {
  const result: { fingerprint?: WinnowingFingerprint; contentHash?: string; simhash?: bigint } = {};
  if (ctx.services.winnowing) {
    const fingerprint = await ctx.services.winnowing.computeFingerprint(text);
    if (fingerprint.ok) {
      result.fingerprint = fingerprint.value;
    }
    const hash = await ctx.services.winnowing.contentHash(text);
    if (hash.ok) {
      result.contentHash = hash.value;
    }
  }
  if (ctx.services.simHash) {
    const simhash = await ctx.services.simHash.simhash64(text);
    if (simhash.ok) {
      result.simhash = simhash.value;
    }
  }
  return result;
}

async function repoOverviewForHit(hit: CodeSearchHit, ctx: ForgeToolContext): Promise<RepoOverview | undefined> {
  if (!ctx.services.gitHubGateway || !hit.owner || !hit.repo) {
    return undefined;
  }
  const overview = await ctx.services.gitHubGateway.getRepoOverview(hit.owner, hit.repo);
  return overview.ok ? overview.value : undefined;
}

async function classifyCandidate(hit: CodeSearchHit, query: string, ctx: ForgeToolContext): Promise<{ category: string; name: string; tradeoffs: readonly string[] }> {
  const classifier = ctx.services.archetypeClassifier;
  const inferredCategory = /test|spec/u.test(hit.path)
    ? 'test_pattern'
    : /config|env|yaml|json/u.test(hit.path)
      ? 'configuration'
      : /class/u.test(candidateText(hit))
        ? 'class'
        : 'function_family';
  if (!classifier) {
    return {
      category: inferredCategory,
      name: `${query} :: ${inferredCategory}`,
      tradeoffs: inferredCategory === 'configuration' ? ['portable', 'may need environment adaptation'] : ['battle-tested', 'adapt to local conventions'],
    };
  }
  const classified = await classifier.classifySymbol({ path: hit.path, snippet: hit.snippet, language: hit.language });
  const category = classified.ok ? classified.value.category : inferredCategory;
  const name = await classifier.archetypeName(category, query);
  const tradeoffs = await classifier.archetypeTradeoffs(category);
  return {
    category,
    name: name.ok ? name.value : `${query} :: ${category}`,
    tradeoffs: tradeoffs.ok ? tradeoffs.value : [],
  };
}

async function scoreHit(hit: CodeSearchHit, query: string, preset: ForgePreset, ctx: ForgeToolContext): Promise<RankedCandidate> {
  const repo = await repoOverviewForHit(hit, ctx);
  let breakdown = fallbackBreakdown(query, hit, repo);
  let why: readonly string[] = [];
  if (ctx.services.qualityScorer) {
    const computed = await ctx.services.qualityScorer.computeScore({
      queryFit: breakdown.queryFit,
      durability: breakdown.durability,
      vitality: breakdown.vitality,
      importability: breakdown.importability,
      codeQuality: breakdown.codeQuality,
      evidenceConfidence: breakdown.evidenceConfidence,
      snippet_only: !hit.content,
      archived: repo?.archived ?? false,
      license_unknown: !repo?.license,
    });
    if (computed.ok) {
      breakdown = computed.value.breakdown;
      why = computed.value.why;
    }
    const capped = await ctx.services.qualityScorer.applyHardCaps(breakdown, {
      snippet_only: !hit.content,
      archived: repo?.archived ?? false,
      license_unknown: !repo?.license,
    });
    if (capped.ok) {
      breakdown = capped.value;
    }
  }
  const composed = ctx.services.qualityScorer ? await ctx.services.qualityScorer.compositeScore(breakdown, preset) : ok(fallbackComposite(breakdown, preset));
  const score = composed.ok ? composed.value : fallbackComposite(breakdown, preset);
  const classification = await classifyCandidate(hit, query, ctx);
  const fp = await maybeFingerprint(hit.content ?? hit.snippet ?? hit.path, ctx);
  return {
    hit,
    repo,
    breakdown,
    score,
    category: classification.category,
    archetypeName: classification.name,
    tradeoffs: classification.tradeoffs,
    why,
    ...fp,
  };
}

function similarityBetween(a: RankedCandidate, b: RankedCandidate): number {
  if (a.contentHash && b.contentHash && a.contentHash === b.contentHash) {
    return 1;
  }
  if (a.hit.owner && a.hit.repo && b.hit.owner && b.hit.repo && a.hit.owner === b.hit.owner && a.hit.repo === b.hit.repo) {
    return 0.65;
  }
  const aTokens = new Set(tokenize(`${a.hit.path} ${a.archetypeName}`));
  const bTokens = new Set(tokenize(`${b.hit.path} ${b.archetypeName}`));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const denominator = Math.max(1, Math.max(aTokens.size, bTokens.size));
  return shared / denominator;
}

function dedupeCandidates(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  const byExact = new Map<string, RankedCandidate>();
  candidates.forEach((candidate) => {
    const key = candidate.contentHash ?? `${candidate.hit.source}:${candidate.hit.owner ?? 'local'}:${candidate.hit.repo ?? ''}:${candidate.hit.path}:${candidate.hit.startLine ?? 0}`;
    const existing = byExact.get(key);
    if (!existing || candidate.score > existing.score) {
      byExact.set(key, candidate);
    }
  });
  return [...byExact.values()];
}

function mmrDiversify(candidates: readonly RankedCandidate[], preset: ForgePreset, limit: number): RankedCandidate[] {
  const lambda = PRESET_MMR_LAMBDA[preset];
  const selected: RankedCandidate[] = [];
  const remaining = [...candidates].sort((a, b) => b.score - a.score);
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, index) => {
      const similarity = selected.length === 0 ? 0 : Math.max(...selected.map((chosen) => similarityBetween(candidate, chosen)));
      const score = lambda * candidate.score - (1 - lambda) * similarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    const picked = remaining.splice(bestIndex, 1)[0];
    if (picked) {
      selected.push(picked);
    }
  }
  return selected;
}

async function clusterArchetypes(candidates: readonly RankedCandidate[], query: string, ctx: ForgeToolContext): Promise<ArchetypeCluster[]> {
  if (candidates.length === 0) {
    return [];
  }
  const groups = new Map<string, RankedCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.archetypeName}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  if (ctx.services.winnowing) {
    const withFingerprints = candidates.filter((candidate): candidate is RankedCandidate & { fingerprint: WinnowingFingerprint } => Boolean(candidate.fingerprint));
    if (withFingerprints.length > 1) {
      const clustered = await ctx.services.winnowing.clusterByJaccard(withFingerprints, 0.6);
      if (clustered.ok) {
        clustered.value.forEach((cluster, index) => {
          const head = cluster[0];
          if (!head) {
            return;
          }
          groups.set(`${head.category}:${head.archetypeName}:${index}`, [...cluster]);
        });
      }
    }
  }

  const clusters: ArchetypeCluster[] = [];
  for (const cluster of groups.values()) {
    const sorted = [...cluster].sort((a, b) => b.score - a.score);
    const top = sorted[0];
    if (!top) {
      continue;
    }
    clusters.push({
      name: top.archetypeName || `${query} family`,
      category: top.category,
      score: mean(sorted.map((item) => item.score)),
      tradeoffs: top.tradeoffs,
      examples: sorted.slice(0, 4),
    });
  }
  return clusters.sort((a, b) => b.score - a.score);
}

async function runScatter(plan: ReturnType<typeof compileDiscoveryQueries>, ctx: ForgeToolContext, source: 'github' | 'all' = 'all'): Promise<ForgeResult<{ hits: readonly CodeSearchHit[]; coverage: Readonly<Record<string, unknown>> }>> {
  if (ctx.services.sourceOrchestrator) {
    const queries: SourceScatterQuery[] = plan.githubQueries.slice(0, 3).map((query) => ({ source: 'github', query }));
    const result = await ctx.services.sourceOrchestrator.scatter(queries, { timeoutMs: 3_000, maxResultsPerQuery: 10 });
    if (result.ok) {
      return ok({ hits: result.value.hits, coverage: { ...result.value.coverage, hints: plan.coverageHints } });
    }
  }

  if (!ctx.services.gitHubGateway) {
    return err('SERVICE_UNAVAILABLE', 'Neither source orchestrator nor GitHub gateway is available');
  }

  const settled = await Promise.allSettled(plan.githubQueries.slice(0, 3).map((query) => ctx.services.gitHubGateway!.searchCode(query)));
  const hits: CodeSearchHit[] = [];
  const errors: string[] = [];
  settled.forEach((entry) => {
    if (entry.status === 'fulfilled' && entry.value.ok) {
      hits.push(...entry.value.value);
      return;
    }
    if (entry.status === 'fulfilled') {
      errors.push(entry.value.ok ? 'unknown error' : entry.value.error.message);
      return;
    }
    errors.push(entry.reason instanceof Error ? entry.reason.message : String(entry.reason));
  });
  return ok({ hits, coverage: { attempted: plan.githubQueries.length, errors, source } });
}

async function runDiscoveryPipeline(
  input: DiscoveryQueryInput & { readonly preset?: ForgePreset; readonly limit?: number },
  ctx: ForgeToolContext,
): Promise<ForgeResult<Readonly<Record<string, unknown>>>> {
  const plan = compileDiscoveryQueries(input);
  const scatter = await runScatter(plan, ctx);
  if (!scatter.ok) {
    return scatter;
  }
  const scored = await Promise.all(scatter.value.hits.map((hit) => scoreHit(hit, plan.normalized, input.preset ?? 'balanced', ctx)));
  const deduped = dedupeCandidates(scored).sort((a, b) => b.score - a.score);
  const diversified = mmrDiversify(deduped, input.preset ?? 'balanced', input.limit ?? 10);
  const archetypes = await clusterArchetypes(diversified, plan.normalized, ctx);
  await upsertEvidenceNodes(
    ctx,
    archetypes.slice(0, input.limit ?? 10).map((cluster) => ({
      id: `archetype:${cluster.category}:${cluster.name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`,
      kind: 'archetype',
      title: cluster.name,
      summary: `${cluster.examples.length} examples for ${plan.normalized}`,
      tags: [cluster.category, input.language ?? 'unknown'],
      score: cluster.score,
      confidence: mean(cluster.examples.map((candidate) => candidate.breakdown.evidenceConfidence)),
      sources: cluster.examples.map((candidate) => `${candidate.hit.source}:${candidate.hit.owner ?? 'local'}/${candidate.hit.repo ?? ''}:${candidate.hit.path}`),
      metadata: { query: plan.normalized, coverage: scatter.value.coverage },
    })),
  );
  return ok({
    plan,
    coverage: scatter.value.coverage,
    archetypes: archetypes.slice(0, input.limit ?? 10).map((cluster) => ({
      name: cluster.name,
      category: cluster.category,
      score: cluster.score,
      tradeoffs: cluster.tradeoffs,
      examples: cluster.examples.map((candidate) => ({
        repo: candidate.repo?.fullName ?? `${candidate.hit.owner ?? 'local'}/${candidate.hit.repo ?? ''}`,
        path: candidate.hit.path,
        language: candidate.hit.language ?? candidate.repo?.primaryLanguage,
        score: candidate.score,
        breakdown: candidate.breakdown,
        why: candidate.why,
      })),
    })),
  });
}

function parseRepoRef(repoRef: string): { owner: string; repo: string } | null {
  const [owner, repo] = repoRef.split('/');
  return owner && repo ? { owner, repo } : null;
}

async function fetchRepoSignatureSummary(repoRef: string, ctx: ForgeToolContext): Promise<string[]> {
  const parsed = parseRepoRef(repoRef);
  if (!parsed || !ctx.services.gitHubGateway) {
    return [];
  }
  const tree = await ctx.services.gitHubGateway.getTree(parsed.owner, parsed.repo);
  if (!tree.ok) {
    return [];
  }
  const interesting = tree.value
    .filter((entry) => entry.type === 'blob')
    .filter((entry) => /src\/|lib\//u.test(entry.path))
    .slice(0, 6)
    .map((entry) => entry.path.split('/').pop() ?? entry.path);
  return interesting;
}

export function createDiscoveryTools(): ForgeTool<object, unknown>[] {
  const huntTool = createReadTool<{ query: string; language?: string; preset?: ForgePreset; limit?: number; deep?: boolean }, Readonly<Record<string, unknown>>>(
    'genius.hunt',
    'Find high-quality implementation archetypes across code sources with clustering, scoring, and diversification.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, preset: { type: 'string' }, limit: { type: 'number' }, deep: { type: 'boolean' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.query, language: input.language, mode: 'archetype', preset: input.preset, limit: input.limit }, ctx),
  );

  const findBestTool = createReadTool<{ query: string; language?: string; preset?: ForgePreset }, Readonly<Record<string, unknown>>>(
    'genius.find_best',
    'Run a budgeted GitHub-only pipeline to identify the single strongest implementation candidate.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, preset: { type: 'string' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const plan = compileDiscoveryQueries({ query: input.query, language: input.language, maxGitHubQueries: 3 });
      const repoResults = await Promise.all(plan.githubQueries.slice(0, 2).map((query) => ctx.services.gitHubGateway!.searchRepos(query)));
      const codeResults = await Promise.all(plan.githubQueries.slice(0, 3).map((query) => ctx.services.gitHubGateway!.searchCode(query)));
      const repos = repoResults.flatMap((result) => (result.ok ? result.value : []));
      const hits = codeResults.flatMap((result) => (result.ok ? result.value : [])).slice(0, 8);
      const overviews = await Promise.all(repos.slice(0, 4).map((repo) => ctx.services.gitHubGateway!.getRepoOverview(repo.owner, repo.repo)));
      const scored = await Promise.all(hits.slice(0, 6).map((hit) => scoreHit(hit, input.query, input.preset ?? 'battle_tested', ctx)));
      const best = scored.sort((a, b) => b.score - a.score)[0];
      if (!best) {
        return ok({ plan, apiCalls: 1 + plan.githubQueries.length, candidates: [] });
      }
      return ok({
        best: {
          repo: best.repo?.fullName ?? `${best.hit.owner ?? 'local'}/${best.hit.repo ?? ''}`,
          path: best.hit.path,
          score: best.score,
          breakdown: best.breakdown,
          why: best.why,
        },
        repoHydration: overviews.filter((result) => result.ok).map((result) => result.value),
        apiCalls: Math.min(15, 1 + repoResults.length + codeResults.length + overviews.length),
      });
    },
  );

  const explainTool = createReadTool<
    { queryFit: number; durability: number; vitality: number; importability: number; codeQuality: number; evidenceConfidence: number; archived?: boolean; snippetOnly?: boolean; licenseUnknown?: boolean; preset?: ForgePreset },
    Readonly<Record<string, unknown>>
  >(
    'genius.explain',
    'Decompose a scored result into its five-bucket quality breakdown and active hard caps.',
    { type: 'object', required: ['queryFit', 'durability', 'vitality', 'importability', 'codeQuality', 'evidenceConfidence'], properties: { queryFit: { type: 'number' } } },
    async (input, ctx) => {
      let breakdown: QualityBreakdown = {
        queryFit: clamp(input.queryFit),
        durability: clamp(input.durability),
        vitality: clamp(input.vitality),
        importability: clamp(input.importability),
        codeQuality: clamp(input.codeQuality),
        evidenceConfidence: clamp(input.evidenceConfidence),
      };
      const caps: string[] = [];
      if (input.snippetOnly) {
        breakdown = { ...breakdown, evidenceConfidence: Math.min(breakdown.evidenceConfidence, 0.6) };
        caps.push('snippet_only → evidenceConfidence ≤ 0.60');
      }
      if (input.archived) {
        breakdown = { ...breakdown, vitality: Math.min(breakdown.vitality, 0.2) };
        caps.push('archived → vitality ≤ 0.20');
      }
      if (input.licenseUnknown) {
        breakdown = { ...breakdown, importability: Math.min(breakdown.importability, 0.2) };
        caps.push('license_unknown → importability ≤ 0.20');
      }
      const score = ctx.services.qualityScorer ? await ctx.services.qualityScorer.compositeScore(breakdown, input.preset ?? 'balanced') : ok(fallbackComposite(breakdown, input.preset ?? 'balanced'));
      return ok({ breakdown, caps, score: score.ok ? score.value : fallbackComposite(breakdown, input.preset ?? 'balanced') });
    },
  );

  const compareTool = createReadTool<{ repos: string[]; query?: string }, Readonly<Record<string, unknown>>>(
    'genius.compare',
    'Compare implementation candidates side by side with repo and code signals.',
    { type: 'object', required: ['repos'], properties: { repos: { type: 'array', items: { type: 'string' } }, query: { type: 'string' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const rows = await Promise.all(
        input.repos.map(async (repoRef) => {
          const parsed = parseRepoRef(repoRef);
          if (!parsed) {
            return { repo: repoRef, error: 'invalid repo ref' };
          }
          const [overview, code] = await Promise.all([
            ctx.services.gitHubGateway!.getRepoOverview(parsed.owner, parsed.repo),
            input.query ? ctx.services.gitHubGateway!.searchCode(`${input.query} repo:${repoRef}`) : ok<readonly CodeSearchHit[]>([]),
          ]);
          const repo = overview.ok ? overview.value : undefined;
          return {
            repo: repoRef,
            stars: repo?.stars ?? 0,
            license: repo?.license ?? 'unknown',
            ci: repo?.ci ?? false,
            language: repo?.primaryLanguage,
            tests: repo?.hasTests ?? false,
            codeHits: code.ok ? code.value.length : 0,
          };
        }),
      );
      return ok({ rows });
    },
  );

  const trendingTool = createReadTool<{ query: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.trending',
    'Find implementations with rising star velocity using current repo state versus evidence snapshots.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const previous = (await ctx.state.getJson<Record<string, { stars: number; at: string }>>('forge:trending:snapshots')) ?? {};
      const repos = await ctx.services.gitHubGateway.searchRepos(`${input.query}${input.language ? ` language:${input.language}` : ''}`);
      if (!repos.ok) {
        return repos;
      }
      const current = { ...previous };
      const ranked = repos.value.slice(0, input.limit ?? 10).map((repo) => {
        const key = repo.fullName;
        const before = previous[key];
        current[key] = { stars: repo.stars ?? 0, at: nowIso(ctx) };
        const deltaStars = before ? (repo.stars ?? 0) - before.stars : 0;
        const deltaHours = before ? Math.max(1, (Date.parse(nowIso(ctx)) - Date.parse(before.at)) / (1000 * 60 * 60)) : 24;
        return { repo: repo.fullName, stars: repo.stars ?? 0, velocity: deltaStars / deltaHours, deltaStars, deltaHours };
      }).sort((a, b) => b.velocity - a.velocity);
      await ctx.state.setJson('forge:trending:snapshots', current);
      return ok({ repos: ranked });
    },
  );

  const alternativesTool = createReadTool<{ repo: string; query?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.alternatives',
    'Find alternative implementations of the same concept by signature and structure.',
    { type: 'object', required: ['repo'], properties: { repo: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const signatures = await fetchRepoSignatureSummary(input.repo, ctx);
      const query = input.query ?? (signatures.join(' ') || input.repo);
      const results = await runDiscoveryPipeline({ query, maxGitHubQueries: 3, limit: input.limit ?? 8 }, ctx);
      if (!results.ok) {
        return results;
      }
      return ok({ seedRepo: input.repo, signatures, alternatives: results.value.archetypes ?? [] });
    },
  );

  const similarTool = createReadTool<{ code: string; threshold?: number; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.similar_to',
    'Search memory and evidence for structurally similar code using winnowing and SimHash.',
    { type: 'object', required: ['code'], properties: { code: { type: 'string' }, threshold: { type: 'number' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const evidence = await ctx.state.getJson<Readonly<Record<string, unknown>>>('forge:evidence:graph');
      const memory = await ctx.services.memoryEngine?.recall(input.code);
      const target = await maybeFingerprint(input.code, ctx);
      const evidenceNodes = evidence && typeof evidence === 'object' && 'nodes' in evidence ? Object.values((evidence as { nodes: Record<string, { id: string; title: string; summary?: string }> }).nodes) : [];
      const similarEvidence = evidenceNodes
        .map((node) => ({ node, similarity: tokenize(`${node.title} ${node.summary ?? ''}`).filter((token) => tokenize(input.code).includes(token)).length / Math.max(1, tokenize(input.code).length) }))
        .filter((entry) => entry.similarity >= (input.threshold ?? 0.4))
        .slice(0, input.limit ?? 10);
      return ok({
        target,
        memoryMatches: memory?.ok ? memory.value.slice(0, input.limit ?? 10) : [],
        evidenceMatches: similarEvidence,
      });
    },
  );

  const byAuthorTool = createReadTool<{ username: string; query: string; language?: string }, Readonly<Record<string, unknown>>>(
    'genius.by_author',
    'Find code from a specific author or user namespace on GitHub.',
    { type: 'object', required: ['username', 'query'], properties: { username: { type: 'string' }, query: { type: 'string' }, language: { type: 'string' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const base = `${input.query}${input.language ? ` language:${input.language}` : ''}`;
      const attempts = [`${base} author:${input.username}`, `${base} user:${input.username}`];
      const settled = await Promise.all(attempts.map((query) => ctx.services.gitHubGateway!.searchCode(query)));
      const hits = settled.flatMap((result) => (result.ok ? result.value : []));
      return ok({ queries: attempts, hits });
    },
  );

  const byDependencyTool = createReadTool<{ package: string; language?: string }, Readonly<Record<string, unknown>>>(
    'genius.by_dependency',
    'Find repos that depend on a specific package using dependency graph or import patterns.',
    { type: 'object', required: ['package'], properties: { package: { type: 'string' }, language: { type: 'string' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const queries = [
        `import ${input.package}${input.language ? ` language:${input.language}` : ''}`,
        `from '${input.package}'${input.language ? ` language:${input.language}` : ''}`,
        `"${input.package}" path:package.json`,
      ];
      const results = await Promise.all(queries.map((query) => ctx.services.gitHubGateway!.searchCode(query)));
      return ok({ package: input.package, hits: results.flatMap((result) => (result.ok ? result.value : [])) });
    },
  );

  const architectureTool = createReadTool<{ stack: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.architecture_search',
    'Search for repos matching a desired architecture stack and file-tree footprint.',
    { type: 'object', required: ['stack'], properties: { stack: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      if (!ctx.services.gitHubGateway) {
        return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      }
      const repos = await ctx.services.gitHubGateway.searchRepos(`${input.stack}${input.language ? ` language:${input.language}` : ''}`);
      if (!repos.ok) {
        return repos;
      }
      const inspected = await Promise.all(
        repos.value.slice(0, input.limit ?? 8).map(async (repo) => {
          const tree = await ctx.services.gitHubGateway!.getTree(repo.owner, repo.repo);
          const paths = tree.ok ? tree.value.map((entry) => entry.path) : [];
          return {
            repo: repo.fullName,
            hasPrisma: paths.some((path) => path.includes('prisma/')),
            hasExpress: paths.some((path) => /express|server\.ts|app\.ts/u.test(path)),
            hasJwt: paths.some((path) => /jwt|auth/u.test(path)),
          };
        }),
      );
      return ok({ matches: inspected });
    },
  );

  const patternSearchTool = createReadTool<{ pattern: string; language?: string }, Readonly<Record<string, unknown>>>(
    'genius.pattern_search',
    'Search for AST-shape-adjacent patterns using evidence, memory, and code search heuristics.',
    { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, language: { type: 'string' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.pattern, language: input.language, mode: 'function', limit: 8 }, ctx),
  );

  const snippetSearchTool = createReadTool<{ query: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.snippet_search',
    'Run a fast scatter-and-dedup snippet search without archetype clustering.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const plan = compileDiscoveryQueries({ query: input.query, language: input.language, mode: 'snippet', maxGitHubQueries: 3 });
      const scatter = await runScatter(plan, ctx);
      if (!scatter.ok) {
        return scatter;
      }
      const scored = await Promise.all(scatter.value.hits.map((hit) => scoreHit(hit, input.query, 'balanced', ctx)));
      return ok({ hits: dedupeCandidates(scored).sort((a, b) => b.score - a.score).slice(0, input.limit ?? 10) });
    },
  );

  const functionSearchTool = createReadTool<{ signature: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.function_search',
    'Find functions matching a target signature or arity shape.',
    { type: 'object', required: ['signature'], properties: { signature: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.signature, language: input.language, mode: 'function', limit: input.limit ?? 8 }, ctx),
  );

  const classSearchTool = createReadTool<{ shape: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.class_search',
    'Find classes that implement a desired interface shape.',
    { type: 'object', required: ['shape'], properties: { shape: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.shape, language: input.language, mode: 'class', limit: input.limit ?? 8 }, ctx),
  );

  const testSearchTool = createReadTool<{ query: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.test_search',
    'Find test and spec patterns for a concept.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: `${input.query} test spec`, language: input.language, mode: 'test', limit: input.limit ?? 8 }, ctx),
  );

  const configSearchTool = createReadTool<{ query: string; language?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.config_search',
    'Find configuration and environment wiring patterns.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: `${input.query} config`, language: input.language, mode: 'config', limit: input.limit ?? 8 }, ctx),
  );

  const readmeSearchTool = createReadTool<{ query: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.readme_search',
    'Search README content across repositories.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.query, mode: 'readme', limit: input.limit ?? 8 }, ctx),
  );

  const changelogSearchTool = createReadTool<{ query: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.changelog_search',
    'Search changelogs for feature introductions and migrations.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => runDiscoveryPipeline({ query: input.query, mode: 'changelog', limit: input.limit ?? 8 }, ctx),
  );

  const issueSearchTool = createReadTool<{ query: string; repo?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.issue_search',
    'Search issues for implementation discussions and solutions.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway?.searchIssues) {
        return err('NOT_SUPPORTED', 'Issue search is not available on the configured GitHub gateway');
      }
      const query = `${input.query}${input.repo ? ` repo:${input.repo}` : ''}`;
      const result = await gateway.searchIssues(query);
      return result.ok ? ok({ issues: result.value.slice(0, input.limit ?? 10) }) : result;
    },
  );

  const prSearchTool = createReadTool<{ query: string; repo?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'genius.pr_search',
    'Search pull requests for implementation patterns and diff context.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const gateway = ctx.services.gitHubGateway;
      if (!gateway?.searchPullRequests) {
        return err('NOT_SUPPORTED', 'Pull request search is not available on the configured GitHub gateway');
      }
      const query = `${input.query}${input.repo ? ` repo:${input.repo}` : ''}`;
      const result = await gateway.searchPullRequests(query);
      return result.ok ? ok({ pullRequests: result.value.slice(0, input.limit ?? 10) }) : result;
    },
  );

  return [
    huntTool,
    findBestTool,
    explainTool,
    compareTool,
    trendingTool,
    alternativesTool,
    similarTool,
    byAuthorTool,
    byDependencyTool,
    architectureTool,
    patternSearchTool,
    snippetSearchTool,
    functionSearchTool,
    classSearchTool,
    testSearchTool,
    configSearchTool,
    readmeSearchTool,
    changelogSearchTool,
    issueSearchTool,
    prSearchTool,
  ] as ForgeTool<object, unknown>[];
}

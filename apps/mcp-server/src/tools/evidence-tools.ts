// @ts-nocheck
import {
  buildForgeTool,
  clamp,
  err,
  nowIso,
  ok,
  tokenize,
  type ForgePreset,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
  type QualityBreakdown,
} from '@forgemcp/core/tool-factory';

export const EVIDENCE_STATE_KEY = 'forge:evidence:graph';

export interface EvidenceOutcome {
  readonly type: 'imported' | 're_searched' | 'discarded' | 'recalled';
  readonly value: number;
  readonly at: string;
}

export interface EvidenceNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly score?: number;
  readonly confidence?: number;
  readonly sources: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly outcomes: readonly EvidenceOutcome[];
}

export interface EvidenceEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly weight: number;
  readonly createdAt: string;
}

export interface EvidenceCalibrationSnapshot {
  readonly at: string;
  readonly presetWeights: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

export interface EvidenceGraphState {
  readonly nodes: Readonly<Record<string, EvidenceNode>>;
  readonly edges: readonly EvidenceEdge[];
  readonly calibrations: readonly EvidenceCalibrationSnapshot[];
}

function defaultEvidenceState(): EvidenceGraphState {
  return {
    nodes: {},
    edges: [],
    calibrations: [],
  };
}

export async function loadEvidenceState(ctx: ForgeToolContext): Promise<EvidenceGraphState> {
  return (await ctx.state.getJson<EvidenceGraphState>(EVIDENCE_STATE_KEY)) ?? defaultEvidenceState();
}

export async function saveEvidenceState(ctx: ForgeToolContext, state: EvidenceGraphState): Promise<void> {
  await ctx.state.setJson(EVIDENCE_STATE_KEY, state);
}

function stableId(prefix: string, seed: string): string {
  const normalized = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return `${prefix}:${normalized}`;
}

function confidenceFromOutcomes(outcomes: readonly EvidenceOutcome[]): number {
  const recalled = outcomes.length;
  const successes = outcomes.filter((outcome) => outcome.type === 'imported' || outcome.type === 'recalled').length;
  return clamp((successes + 1) / (recalled + 2));
}

function textScore(query: string, node: EvidenceNode): number {
  const queryTokens = new Set(tokenize(query));
  const nodeTokens = new Set(tokenize(`${node.title} ${node.summary ?? ''} ${node.tags.join(' ')}`));
  if (queryTokens.size === 0 || nodeTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  queryTokens.forEach((token) => {
    if (nodeTokens.has(token)) {
      overlap += 1;
    }
  });
  return overlap / Math.max(1, queryTokens.size);
}

function neighbors(state: EvidenceGraphState, id: string): EvidenceNode[] {
  const ids = new Set<string>();
  state.edges.forEach((edge) => {
    if (edge.from === id) {
      ids.add(edge.to);
    }
    if (edge.to === id) {
      ids.add(edge.from);
    }
  });
  return [...ids]
    .map((nodeId) => state.nodes[nodeId])
    .filter((node): node is EvidenceNode => Boolean(node));
}

function summarizeNode(node: EvidenceNode, state: EvidenceGraphState): Readonly<Record<string, unknown>> {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    tags: node.tags,
    score: node.score ?? 0,
    confidence: node.confidence ?? confidenceFromOutcomes(node.outcomes),
    degree: neighbors(state, node.id).length,
    sources: node.sources,
    updatedAt: node.updatedAt,
  };
}

export async function upsertEvidenceNodes(
  ctx: ForgeToolContext,
  nodes: readonly Omit<EvidenceNode, 'createdAt' | 'updatedAt' | 'outcomes'>[],
): Promise<EvidenceGraphState> {
  const state = await loadEvidenceState(ctx);
  const now = nowIso(ctx);
  const mergedNodes: Record<string, EvidenceNode> = { ...state.nodes };

  nodes.forEach((node) => {
    const existing = mergedNodes[node.id];
    const outcomes = existing?.outcomes ?? [];
    mergedNodes[node.id] = {
      ...existing,
      ...node,
      tags: [...new Set([...(existing?.tags ?? []), ...node.tags])],
      sources: [...new Set([...(existing?.sources ?? []), ...node.sources])],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      outcomes,
      confidence: node.confidence ?? existing?.confidence ?? confidenceFromOutcomes(outcomes),
    };
  });

  const nextState: EvidenceGraphState = {
    ...state,
    nodes: mergedNodes,
  };
  await saveEvidenceState(ctx, nextState);
  return nextState;
}

async function addOutcome(
  ctx: ForgeToolContext,
  nodeIds: readonly string[],
  type: EvidenceOutcome['type'],
): Promise<EvidenceGraphState> {
  const state = await loadEvidenceState(ctx);
  const now = nowIso(ctx);
  const updated: Record<string, EvidenceNode> = { ...state.nodes };
  nodeIds.forEach((id) => {
    const current = updated[id];
    if (!current) {
      return;
    }
    const outcomes = [...current.outcomes, { type, value: type === 'imported' || type === 'recalled' ? 1 : 0, at: now }];
    updated[id] = {
      ...current,
      updatedAt: now,
      outcomes,
      confidence: confidenceFromOutcomes(outcomes),
    };
  });
  const next: EvidenceGraphState = { ...state, nodes: updated };
  await saveEvidenceState(ctx, next);
  return next;
}

function fallbackComposite(breakdown: QualityBreakdown, preset: ForgePreset): number {
  const presetLambda = {
    balanced: 0.72,
    battle_tested: 0.78,
    teaching_quality: 0.68,
    import_ready: 0.74,
  }[preset];
  const retrieval = breakdown.retrieval ?? (0.5 * breakdown.queryFit + 0.35 * breakdown.codeQuality + 0.15 * breakdown.evidenceConfidence);
  const penalties = breakdown.penalties ?? 0;
  return clamp(
    presetLambda * retrieval +
      0.18 * breakdown.durability +
      0.15 * breakdown.vitality +
      0.12 * breakdown.importability +
      0.1 * breakdown.evidenceConfidence -
      0.1 * penalties,
  );
}

function asciiGraph(state: EvidenceGraphState, rootId: string, depth: number): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, currentDepth: number, prefix: string): void => {
    const node = state.nodes[id];
    if (!node || seen.has(id) || currentDepth > depth) {
      return;
    }
    seen.add(id);
    lines.push(`${prefix}${node.title} [${node.kind}] (${(node.confidence ?? 0.5).toFixed(2)})`);
    const nextEdges = state.edges.filter((edge) => edge.from === id || edge.to === id);
    nextEdges.forEach((edge, index) => {
      const other = edge.from === id ? edge.to : edge.from;
      const branch = index === nextEdges.length - 1 ? '└─ ' : '├─ ';
      const childPrefix = `${prefix}${index === nextEdges.length - 1 ? '   ' : '│  '}`;
      const child = state.nodes[other];
      if (!child) {
        return;
      }
      lines.push(`${prefix}${branch}${edge.type} → ${child.title}`);
      walk(other, currentDepth + 1, childPrefix);
    });
  };
  walk(rootId, 0, '');
  return lines.join('\n');
}

function createReadTool<TInput extends object, TOutput>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<ForgeResult<TOutput>>,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool<TInput, TOutput>({
    name,
    description,
    category: 'evidence',
    inputSchema,
    tags: ['evidence', 'graph'],
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
  destructive = false,
): ForgeTool<TInput, TOutput> {
  return buildForgeTool<TInput, TOutput>({
    name,
    description,
    category: 'evidence',
    inputSchema,
    tags: ['evidence', 'graph'],
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => destructive,
    execute,
  });
}

export function createEvidenceTools(): ForgeTool<object, unknown>[] {
  const queryTool = createReadTool<{ query: string; kind?: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'evidence.query',
    'Query the evidence graph across repos, blobs, symbols, patterns, and archetypes.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      const matches = Object.values(state.nodes)
        .filter((node) => (input.kind ? node.kind === input.kind : true))
        .map((node) => ({ node, score: textScore(input.query, node) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10)
        .map((entry) => ({ ...summarizeNode(entry.node, state), relevance: entry.score }));
      return ok({ total: matches.length, matches });
    },
  );

  const addTool = createWriteTool<
    { kind: string; title: string; summary?: string; tags?: string[]; score?: number; confidence?: number; sources?: string[]; metadata?: Record<string, unknown> },
    Readonly<Record<string, unknown>>
  >(
    'evidence.add',
    'Add a node to the evidence graph.',
    { type: 'object', required: ['kind', 'title'], properties: { kind: { type: 'string' }, title: { type: 'string' } } },
    async (input, ctx) => {
      const id = stableId(input.kind, input.title);
      const state = await upsertEvidenceNodes(ctx, [
        {
          id,
          kind: input.kind,
          title: input.title,
          summary: input.summary,
          tags: input.tags ?? [],
          score: input.score,
          confidence: input.confidence,
          sources: input.sources ?? [],
          metadata: input.metadata,
        },
      ]);
      return ok({ id, node: state.nodes[id] });
    },
  );

  const linkTool = createWriteTool<{ from: string; to: string; type: string; weight?: number }, Readonly<Record<string, unknown>>>(
    'evidence.link',
    'Create a typed edge between evidence nodes.',
    { type: 'object', required: ['from', 'to', 'type'], properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' }, weight: { type: 'number' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      if (!state.nodes[input.from] || !state.nodes[input.to]) {
        return err('NOT_FOUND', 'Both evidence nodes must exist before linking them');
      }
      const edge: EvidenceEdge = {
        id: stableId('edge', `${input.from}:${input.type}:${input.to}`),
        from: input.from,
        to: input.to,
        type: input.type,
        weight: clamp(input.weight ?? 0.5),
        createdAt: nowIso(ctx),
      };
      const next: EvidenceGraphState = {
        ...state,
        edges: [...state.edges.filter((existing) => existing.id !== edge.id), edge],
      };
      await saveEvidenceState(ctx, next);
      return ok({ edge, degreeFrom: neighbors(next, input.from).length, degreeTo: neighbors(next, input.to).length });
    },
  );

  const scoreTool = createWriteTool<
    {
      nodeId: string;
      preset?: ForgePreset;
      queryFit?: number;
      durability?: number;
      vitality?: number;
      importability?: number;
      codeQuality?: number;
      evidenceConfidence?: number;
      penalties?: number;
    },
    Readonly<Record<string, unknown>>
  >(
    'evidence.score',
    'Compute or refresh an evidence score using the five-bucket quality model.',
    {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        preset: { type: 'string' },
      },
    },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      const node = state.nodes[input.nodeId];
      if (!node) {
        return err('NOT_FOUND', `No evidence node found for ${input.nodeId}`);
      }

      const initialBreakdown: QualityBreakdown = {
        queryFit: clamp(input.queryFit ?? 0.6),
        durability: clamp(input.durability ?? 0.6),
        vitality: clamp(input.vitality ?? 0.6),
        importability: clamp(input.importability ?? 0.6),
        codeQuality: clamp(input.codeQuality ?? 0.6),
        evidenceConfidence: clamp(input.evidenceConfidence ?? node.confidence ?? confidenceFromOutcomes(node.outcomes)),
        penalties: clamp(input.penalties ?? 0),
      };

      let breakdown = initialBreakdown;
      let score = fallbackComposite(initialBreakdown, input.preset ?? 'balanced');
      const scorer = ctx.services.qualityScorer;
      if (scorer) {
        const caps = await scorer.applyHardCaps(breakdown, {
          archived: node.metadata?.archived ?? false,
          snippet_only: node.metadata?.snippetOnly ?? false,
          license_unknown: !node.metadata?.license,
        });
        breakdown = caps.ok ? caps.value : breakdown;
        const composite = await scorer.compositeScore(breakdown, input.preset ?? 'balanced');
        score = composite.ok ? composite.value : score;
      }

      const updatedNode: EvidenceNode = {
        ...node,
        score,
        confidence: breakdown.evidenceConfidence,
        updatedAt: nowIso(ctx),
      };
      const next: EvidenceGraphState = { ...state, nodes: { ...state.nodes, [node.id]: updatedNode } };
      await saveEvidenceState(ctx, next);
      return ok({ node: summarizeNode(updatedNode, next), breakdown });
    },
  );

  const explainTool = createReadTool<{ nodeId: string }, Readonly<Record<string, unknown>>>(
    'evidence.explain',
    'Explain how an evidence node earned its current confidence and score.',
    { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      const node = state.nodes[input.nodeId];
      if (!node) {
        return err('NOT_FOUND', `No evidence node found for ${input.nodeId}`);
      }
      const degree = neighbors(state, node.id).length;
      const confidence = node.confidence ?? confidenceFromOutcomes(node.outcomes);
      const reasons = [
        `Bayesian confidence ${(confidence).toFixed(2)} from ${node.outcomes.length} recorded outcomes`,
        `${degree} graph connections reinforce or challenge the claim`,
        `${node.sources.length} upstream sources recorded`,
      ];
      return ok({ node: summarizeNode(node, state), reasons, outcomes: node.outcomes, neighbors: neighbors(state, node.id).map((entry) => summarizeNode(entry, state)) });
    },
  );

  const visualizeTool = createReadTool<{ rootId: string; depth?: number }, Readonly<Record<string, unknown>>>(
    'evidence.visualize',
    'Render an ASCII visualization of the local evidence graph.',
    { type: 'object', required: ['rootId'], properties: { rootId: { type: 'string' }, depth: { type: 'number' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      if (!state.nodes[input.rootId]) {
        return err('NOT_FOUND', `No evidence node found for ${input.rootId}`);
      }
      return ok({ graph: asciiGraph(state, input.rootId, Math.max(1, input.depth ?? 2)) });
    },
  );

  const exportTool = createReadTool<{ includeEdges?: boolean }, Readonly<Record<string, unknown>>>(
    'evidence.export',
    'Export the evidence graph as JSON-safe data.',
    { type: 'object', properties: { includeEdges: { type: 'boolean' } } },
    async (_input, ctx) => {
      const state = await loadEvidenceState(ctx);
      return ok({ nodes: Object.values(state.nodes), edges: state.edges, calibrations: state.calibrations });
    },
  );

  const mergeTool = createWriteTool<{ nodeIds: string[]; targetTitle?: string }, Readonly<Record<string, unknown>>>(
    'evidence.merge',
    'Merge overlapping evidence nodes into a stronger node.',
    { type: 'object', required: ['nodeIds'], properties: { nodeIds: { type: 'array', items: { type: 'string' } }, targetTitle: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      const nodes = input.nodeIds
        .map((id) => state.nodes[id])
        .filter((node): node is EvidenceNode => Boolean(node));
      if (nodes.length < 2) {
        return err('INVALID_INPUT', 'At least two evidence nodes are required to merge');
      }
      const primary = nodes[0];
      if (!primary) {
        return err('INTERNAL', 'Primary merge node missing after validation');
      }
      const targetId = stableId(primary.kind, input.targetTitle ?? primary.title);
      const mergedNode: EvidenceNode = {
        id: targetId,
        kind: primary.kind,
        title: input.targetTitle ?? primary.title,
        summary: nodes.map((node) => node.summary).filter((summary): summary is string => Boolean(summary)).join(' | '),
        tags: [...new Set(nodes.flatMap((node) => node.tags))],
        score: Math.max(...nodes.map((node) => node.score ?? 0)),
        confidence: Math.max(...nodes.map((node) => node.confidence ?? confidenceFromOutcomes(node.outcomes))),
        sources: [...new Set(nodes.flatMap((node) => node.sources))],
        createdAt: nowIso(ctx),
        updatedAt: nowIso(ctx),
        outcomes: nodes.flatMap((node) => node.outcomes),
        metadata: { mergedFrom: input.nodeIds },
      };
      const mergedState = await upsertEvidenceNodes(ctx, [mergedNode]);
      const nextEdges = mergedState.edges.map((edge) => ({
        ...edge,
        from: input.nodeIds.includes(edge.from) ? targetId : edge.from,
        to: input.nodeIds.includes(edge.to) ? targetId : edge.to,
      }));
      const nextNodes = { ...mergedState.nodes };
      input.nodeIds.forEach((id) => {
        if (id !== targetId) {
          delete nextNodes[id];
        }
      });
      const nextState: EvidenceGraphState = { ...mergedState, nodes: nextNodes, edges: nextEdges };
      await saveEvidenceState(ctx, nextState);
      return ok({ mergedInto: targetId, removed: input.nodeIds.filter((id) => id !== targetId), node: nextState.nodes[targetId] });
    },
  );

  const pruneTool = createWriteTool<{ olderThanDays?: number; minConfidence?: number; dryRun?: boolean }, Readonly<Record<string, unknown>>>(
    'evidence.prune',
    'Prune weak or stale evidence nodes from the graph.',
    { type: 'object', properties: { olderThanDays: { type: 'number' }, minConfidence: { type: 'number' }, dryRun: { type: 'boolean' } } },
    async (input, ctx) => {
      const state = await loadEvidenceState(ctx);
      const olderThanMs = (input.olderThanDays ?? 90) * 24 * 60 * 60 * 1000;
      const minConfidence = input.minConfidence ?? 0.25;
      const cutoff = Date.now() - olderThanMs;
      const prunable = Object.values(state.nodes).filter((node) => {
        const updatedAt = Date.parse(node.updatedAt);
        const confidence = node.confidence ?? confidenceFromOutcomes(node.outcomes);
        return updatedAt < cutoff && confidence < minConfidence;
      });
      if (input.dryRun) {
        return ok({ prunable: prunable.map((node) => summarizeNode(node, state)), count: prunable.length });
      }
      const nextNodes = { ...state.nodes };
      prunable.forEach((node) => {
        delete nextNodes[node.id];
      });
      const pruneIds = new Set(prunable.map((node) => node.id));
      const nextEdges = state.edges.filter((edge) => !pruneIds.has(edge.from) && !pruneIds.has(edge.to));
      const nextState: EvidenceGraphState = { ...state, nodes: nextNodes, edges: nextEdges };
      await saveEvidenceState(ctx, nextState);
      return ok({ pruned: prunable.length, removedIds: [...pruneIds] });
    },
    true,
  );

  const calibrateTool = createWriteTool<
    { importedIds?: string[]; reSearchedIds?: string[]; discardedIds?: string[] },
    Readonly<Record<string, unknown>>
  >(
    'evidence.calibrate',
    'Calibrate evidence scores against real outcomes and adjust global weighting hints.',
    { type: 'object', properties: { importedIds: { type: 'array', items: { type: 'string' } }, reSearchedIds: { type: 'array', items: { type: 'string' } }, discardedIds: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      await addOutcome(ctx, input.importedIds ?? [], 'imported');
      await addOutcome(ctx, input.reSearchedIds ?? [], 're_searched');
      const stateAfterResearch = await addOutcome(ctx, input.discardedIds ?? [], 'discarded');
      const scoredNodes = Object.values(stateAfterResearch.nodes).filter((node) => typeof node.score === 'number');
      const error = scoredNodes.length === 0
        ? 0
        : scoredNodes.reduce((sum, node) => {
            const actual = confidenceFromOutcomes(node.outcomes);
            return sum + (actual - (node.score ?? 0));
          }, 0) / scoredNodes.length;
      const latest = stateAfterResearch.calibrations[stateAfterResearch.calibrations.length - 1];
      const previousWeights = latest?.presetWeights ?? { evidenceWeight: 1 };
      const nextWeights = {
        ...previousWeights,
        evidenceWeight: clamp((typeof previousWeights.evidenceWeight === 'number' ? previousWeights.evidenceWeight : 1) + error * 0.1, 0.5, 1.5),
      };
      const snapshot: EvidenceCalibrationSnapshot = {
        at: nowIso(ctx),
        presetWeights: nextWeights,
        notes: [`mean_error=${error.toFixed(4)}`, `nodes=${scoredNodes.length}`],
      };
      const nextState: EvidenceGraphState = {
        ...stateAfterResearch,
        calibrations: [...stateAfterResearch.calibrations, snapshot],
      };
      await saveEvidenceState(ctx, nextState);
      return ok({ calibration: snapshot, nodesUpdated: scoredNodes.length });
    },
  );

  return [
    queryTool,
    addTool,
    linkTool,
    scoreTool,
    explainTool,
    visualizeTool,
    exportTool,
    mergeTool,
    pruneTool,
    calibrateTool,
  ] as ForgeTool<object, unknown>[];
}

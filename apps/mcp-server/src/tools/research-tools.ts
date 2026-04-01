// @ts-nocheck
import {
  buildForgeTool,
  clamp,
  err,
  nowIso,
  ok,
  tokenize,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
} from '@forgemcp/core/tool-factory';
import { upsertEvidenceNodes } from './evidence-tools.js';

const RESEARCH_STATE_KEY = 'forge:research:chains';

type ResearchStatus = 'open' | 'concluded';

interface ResearchStep {
  readonly id: string;
  readonly at: string;
  readonly queryType: string;
  readonly queryText: string;
  readonly resultSummary: string;
  readonly keyInsight: string;
  readonly decisionMade?: string;
  readonly sources: readonly string[];
}

interface ResearchChain {
  readonly id: string;
  readonly title: string;
  readonly question?: string;
  readonly hypothesis?: string;
  readonly status: ResearchStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly conclusion?: string;
  readonly decision?: string;
  readonly tags: readonly string[];
  readonly steps: readonly ResearchStep[];
}

interface ResearchState {
  readonly chains: Readonly<Record<string, ResearchChain>>;
}

function defaultState(): ResearchState {
  return { chains: {} };
}

async function loadState(ctx: ForgeToolContext): Promise<ResearchState> {
  return (await ctx.state.getJson<ResearchState>(RESEARCH_STATE_KEY)) ?? defaultState();
}

async function saveState(ctx: ForgeToolContext, state: ResearchState): Promise<void> {
  await ctx.state.setJson(RESEARCH_STATE_KEY, state);
}

function stableId(prefix: string, text: string): string {
  return `${prefix}:${text.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)}`;
}

function chainScore(query: string, chain: ResearchChain): number {
  const queryTokens = new Set(tokenize(query));
  const chainTokens = new Set(tokenize(`${chain.title} ${chain.question ?? ''} ${chain.hypothesis ?? ''} ${chain.tags.join(' ')} ${chain.steps.map((step) => `${step.queryText} ${step.keyInsight}`).join(' ')}`));
  if (queryTokens.size === 0 || chainTokens.size === 0) return 0;
  let overlap = 0;
  queryTokens.forEach((token) => {
    if (chainTokens.has(token)) overlap += 1;
  });
  return overlap / Math.max(1, queryTokens.size);
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
    category: 'research',
    inputSchema,
    tags: ['research', 'analysis'],
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
    category: 'research',
    inputSchema,
    tags: ['research', 'analysis'],
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute,
  });
}

export function createResearchTools(): ForgeTool<object, unknown>[] {
  const startChainTool = createWriteTool<{ title: string; question?: string; hypothesis?: string; tags?: string[] }, Readonly<Record<string, unknown>>>(
    'research.start_chain',
    'Start a persistent research chain that can survive across sessions.',
    { type: 'object', required: ['title'], properties: { title: { type: 'string' }, question: { type: 'string' }, hypothesis: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const id = stableId('research', input.title);
      const chain: ResearchChain = {
        id,
        title: input.title,
        question: input.question,
        hypothesis: input.hypothesis,
        status: 'open',
        createdAt: nowIso(ctx),
        updatedAt: nowIso(ctx),
        tags: input.tags ?? [],
        steps: [],
      };
      const next: ResearchState = { ...state, chains: { ...state.chains, [id]: chain } };
      await saveState(ctx, next);
      await upsertEvidenceNodes(ctx, [{ id: `research:${id}`, kind: 'research_chain', title: input.title, summary: input.question ?? input.hypothesis, tags: input.tags ?? [], sources: [], confidence: 0.55 }]);
      return ok({ chain });
    },
  );

  const addStepTool = createWriteTool<
    { chainId: string; queryType: string; queryText: string; resultSummary: string; keyInsight: string; decisionMade?: string; sources?: string[] },
    Readonly<Record<string, unknown>>
  >(
    'research.add_step',
    'Add a step to an existing research chain.',
    { type: 'object', required: ['chainId', 'queryType', 'queryText', 'resultSummary', 'keyInsight'], properties: { chainId: { type: 'string' }, queryType: { type: 'string' }, queryText: { type: 'string' }, resultSummary: { type: 'string' }, keyInsight: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const chain = state.chains[input.chainId];
      if (!chain) return err('NOT_FOUND', `No research chain found for ${input.chainId}`);
      const step: ResearchStep = {
        id: `${chain.id}:step:${chain.steps.length + 1}`,
        at: nowIso(ctx),
        queryType: input.queryType,
        queryText: input.queryText,
        resultSummary: input.resultSummary,
        keyInsight: input.keyInsight,
        decisionMade: input.decisionMade,
        sources: input.sources ?? [],
      };
      const nextChain: ResearchChain = { ...chain, updatedAt: step.at, steps: [...chain.steps, step] };
      const next: ResearchState = { ...state, chains: { ...state.chains, [chain.id]: nextChain } };
      await saveState(ctx, next);
      if (ctx.services.searchIndex) {
        await ctx.services.searchIndex.add({ id: step.id, title: chain.title, content: `${input.queryText}\n${input.resultSummary}\n${input.keyInsight}`, metadata: { chainId: chain.id, type: 'research_step' } });
      }
      return ok({ step, chain: nextChain });
    },
  );

  const concludeTool = createWriteTool<{ chainId: string; conclusion: string; decision?: string; tags?: string[] }, Readonly<Record<string, unknown>>>(
    'research.conclude',
    'Conclude a research chain with a final decision.',
    { type: 'object', required: ['chainId', 'conclusion'], properties: { chainId: { type: 'string' }, conclusion: { type: 'string' }, decision: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const chain = state.chains[input.chainId];
      if (!chain) return err('NOT_FOUND', `No research chain found for ${input.chainId}`);
      const nextChain: ResearchChain = {
        ...chain,
        status: 'concluded',
        updatedAt: nowIso(ctx),
        conclusion: input.conclusion,
        decision: input.decision,
        tags: [...new Set([...chain.tags, ...(input.tags ?? [])])],
      };
      const next: ResearchState = { ...state, chains: { ...state.chains, [chain.id]: nextChain } };
      await saveState(ctx, next);
      await upsertEvidenceNodes(ctx, [{ id: `research:${chain.id}`, kind: 'research_chain', title: chain.title, summary: input.conclusion, tags: nextChain.tags, sources: [], confidence: 0.7 }]);
      return ok({ chain: nextChain });
    },
  );

  const recallChainTool = createReadTool<{ query: string; limit?: number }, Readonly<Record<string, unknown>>>(
    'research.recall_chain',
    'Recall relevant research chains with keyword and semantic overlap.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const chains = Object.values(state.chains)
        .map((chain) => ({ chain, score: chainScore(input.query, chain) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10);
      return ok({ chains });
    },
  );

  const archaeologyTool = createReadTool<{ topic: string }, Readonly<Record<string, unknown>>>(
    'research.archaeology',
    'Reconstruct prior reasoning around a topic by walking historical chains.',
    { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const related = Object.values(state.chains)
        .filter((chain) => chainScore(input.topic, chain) > 0)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return ok({ topic: input.topic, chains: related, timeline: related.flatMap((chain) => chain.steps.map((step) => ({ chainId: chain.id, at: step.at, insight: step.keyInsight }))) });
    },
  );

  const deepCompareTool = createReadTool<{ options: Array<{ name: string; summary: string; scores?: Record<string, number> }> }, Readonly<Record<string, unknown>>>(
    'research.deep_compare',
    'Deeply compare solution options using weighted criteria.',
    { type: 'object', required: ['options'], properties: { options: { type: 'array' } } },
    async (input) => {
      const rows = input.options.map((option) => {
        const scores = option.scores ?? {};
        const values = Object.values(scores);
        const total = values.length === 0 ? 0.5 : values.reduce((sum, value) => sum + value, 0) / values.length;
        return { ...option, total: clamp(total) };
      }).sort((a, b) => b.total - a.total);
      return ok({ rows });
    },
  );

  const timelineTool = createReadTool<{ chainId: string }, Readonly<Record<string, unknown>>>(
    'research.timeline',
    'View a chronological timeline of a research chain.',
    { type: 'object', required: ['chainId'], properties: { chainId: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const chain = state.chains[input.chainId];
      if (!chain) return err('NOT_FOUND', `No research chain found for ${input.chainId}`);
      return ok({ chainId: chain.id, events: chain.steps.map((step) => ({ at: step.at, summary: step.resultSummary, insight: step.keyInsight, decision: step.decisionMade })) });
    },
  );

  const impactAnalysisTool = createReadTool<{ subject: string; areas?: string[] }, Readonly<Record<string, unknown>>>(
    'research.impact_analysis',
    'Estimate the impact of a decision across architecture, developer experience, and operations.',
    { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, areas: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const related = Object.values(state.chains).filter((chain) => chainScore(input.subject, chain) > 0.2);
      const areas = input.areas ?? ['architecture', 'dx', 'ops', 'risk'];
      const impact = areas.map((area) => ({
        area,
        score: clamp(0.45 + related.length * 0.05 + (area === 'risk' ? 0.1 : 0)),
        rationale: `${related.length} related research chains mention ${input.subject}`,
      }));
      return ok({ subject: input.subject, impact });
    },
  );

  const riskAssessmentTool = createReadTool<{ subject: string; likelihood?: number; impact?: number; notes?: string[] }, Readonly<Record<string, unknown>>>(
    'research.risk_assessment',
    'Build a simple risk assessment matrix for a proposed decision.',
    { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, likelihood: { type: 'number' }, impact: { type: 'number' }, notes: { type: 'array', items: { type: 'string' } } } },
    async (input) => {
      const likelihood = clamp(input.likelihood ?? 0.5);
      const impact = clamp(input.impact ?? 0.5);
      const risk = clamp(likelihood * impact);
      const level = risk >= 0.66 ? 'high' : risk >= 0.33 ? 'medium' : 'low';
      return ok({ subject: input.subject, likelihood, impact, risk, level, notes: input.notes ?? [] });
    },
  );

  const decisionMatrixTool = createReadTool<{ options: Array<{ name: string; criteria: Record<string, number> }> }, Readonly<Record<string, unknown>>>(
    'research.decision_matrix',
    'Generate a decision matrix from weighted criteria scores.',
    { type: 'object', required: ['options'], properties: { options: { type: 'array' } } },
    async (input) => {
      const criteria = [...new Set(input.options.flatMap((option) => Object.keys(option.criteria)))];
      const rows = input.options.map((option) => {
        const total = criteria.reduce((sum, criterion) => sum + (option.criteria[criterion] ?? 0), 0) / Math.max(1, criteria.length);
        return { name: option.name, criteria: option.criteria, total: clamp(total) };
      }).sort((a, b) => b.total - a.total);
      return ok({ criteria, rows });
    },
  );

  return [
    startChainTool,
    addStepTool,
    concludeTool,
    recallChainTool,
    archaeologyTool,
    deepCompareTool,
    timelineTool,
    impactAnalysisTool,
    riskAssessmentTool,
    decisionMatrixTool,
  ] as ForgeTool<object, unknown>[];
}

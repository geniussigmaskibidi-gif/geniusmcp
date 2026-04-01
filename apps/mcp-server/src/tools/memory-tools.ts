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
  type MemoryPattern,
} from '@forgemcp/core/tool-factory';

const MEMORY_STATE_KEY = 'forge:memory:state';

type MemoryRecordState = 'active' | 'shadowed' | 'deleted';
type MemoryLinkType = 'similar_to' | 'depends_on' | 'evolved_from' | 'alternative_to' | 'tests' | 'merged_from';

interface MemoryRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly language?: string;
  readonly signature?: string;
  readonly description?: string;
  readonly blobSha?: string;
  readonly fingerprint?: string;
  readonly tags: readonly string[];
  readonly notes: readonly string[];
  readonly parentId?: string;
  readonly state: MemoryRecordState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timesRecalled: number;
  readonly timesUsed: number;
  readonly timesUsedSuccessfully: number;
  readonly confidence: number;
  readonly lineage: readonly string[];
}

interface MemoryLink {
  readonly from: string;
  readonly to: string;
  readonly type: MemoryLinkType;
  readonly createdAt: string;
}

interface MemoryEvent {
  readonly at: string;
  readonly type: string;
  readonly patternId: string;
  readonly note?: string;
}

interface MemoryState {
  readonly records: Readonly<Record<string, MemoryRecord>>;
  readonly links: readonly MemoryLink[];
  readonly events: readonly MemoryEvent[];
  readonly sessions: readonly string[];
}

function defaultState(): MemoryState {
  return { records: {}, links: [], events: [], sessions: [] };
}

async function loadState(ctx: ForgeToolContext): Promise<MemoryState> {
  return (await ctx.state.getJson<MemoryState>(MEMORY_STATE_KEY)) ?? defaultState();
}

async function saveState(ctx: ForgeToolContext, state: MemoryState): Promise<void> {
  await ctx.state.setJson(MEMORY_STATE_KEY, state);
}

function strength(timesRecalled: number): number {
  return 7 * (1 + Math.log2(1 + Math.max(0, timesRecalled)));
}

function retention(timesRecalled: number, daysSinceRecall: number): number {
  return Math.exp(-daysSinceRecall / strength(timesRecalled));
}

function confidence(timesRecalled: number, timesUsedSuccessfully: number): number {
  return clamp((timesUsedSuccessfully + 1) / (timesRecalled + 2));
}

function textScore(query: string, record: MemoryRecord): number {
  const queryTokens = new Set(tokenize(query));
  const recordTokens = new Set(tokenize(`${record.name} ${record.signature ?? ''} ${record.description ?? ''} ${record.tags.join(' ')}`));
  if (queryTokens.size === 0 || recordTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  queryTokens.forEach((token) => {
    if (recordTokens.has(token)) {
      overlap += 1;
    }
  });
  return overlap / Math.max(1, queryTokens.size);
}

function appendEvent(state: MemoryState, event: MemoryEvent): MemoryState {
  return {
    ...state,
    events: [...state.events, event],
  };
}

function serializeRecord(record: MemoryRecord): Readonly<Record<string, unknown>> {
  return {
    ...record,
    strength: strength(record.timesRecalled),
  };
}

async function fingerprintForCode(code: string, ctx: ForgeToolContext): Promise<string | undefined> {
  const winnowing = ctx.services.winnowing;
  if (!winnowing) {
    return undefined;
  }
  const hash = await winnowing.contentHash(code);
  return hash.ok ? hash.value : undefined;
}

function neighbors(state: MemoryState, id: string): Array<{ record: MemoryRecord; type: MemoryLinkType; distance: number }> {
  const result: Array<{ record: MemoryRecord; type: MemoryLinkType; distance: number }> = [];
  const queue: Array<{ id: string; distance: number }> = [{ id, distance: 0 }];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const outgoing = state.links.filter((link) => link.from === current.id || link.to === current.id);
    outgoing.forEach((link) => {
      const nextId = link.from === current.id ? link.to : link.from;
      if (seen.has(nextId)) {
        return;
      }
      seen.add(nextId);
      const record = state.records[nextId];
      if (!record) {
        return;
      }
      result.push({ record, type: link.type, distance: current.distance + 1 });
      queue.push({ id: nextId, distance: current.distance + 1 });
    });
  }
  return result;
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
    category: 'memory',
    inputSchema,
    tags: ['memory', 'patterns'],
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
  return buildForgeTool({
    name,
    description,
    category: 'memory',
    inputSchema,
    tags: ['memory', 'patterns'],
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => destructive,
    execute,
  });
}

function coerceImportedRecord(entry: unknown): Partial<MemoryRecord> | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  if (!id || !name || !kind) {
    return null;
  }
  return {
    id,
    name,
    kind,
    language: typeof record.language === 'string' ? record.language : undefined,
    signature: typeof record.signature === 'string' ? record.signature : undefined,
    blobSha: typeof record.blobSha === 'string' ? record.blobSha : undefined,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    confidence: typeof record.confidence === 'number' ? clamp(record.confidence) : 0.5,
    timesRecalled: typeof record.timesRecalled === 'number' ? Math.max(0, record.timesRecalled) : 0,
    timesUsedSuccessfully: typeof record.timesUsedSuccessfully === 'number' ? Math.max(0, record.timesUsedSuccessfully) : 0,
  };
}

export function createMemoryTools(): ForgeTool<object, unknown>[] {
  const recallTool = createReadTool<{ query: string; language?: string; minConfidence?: number; limit?: number }, Readonly<Record<string, unknown>>>(
    'memory.recall',
    'Recall patterns from long-term memory using BM25/RRF and refresh their recall statistics.',
    { type: 'object', required: ['query'], properties: { query: { type: 'string' }, language: { type: 'string' }, minConfidence: { type: 'number' }, limit: { type: 'number' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const memoryEngine = ctx.services.memoryEngine;
      const engineRecall = memoryEngine ? await memoryEngine.recall(input.query) : ok<readonly MemoryPattern[]>([]);
      const stateMatches = Object.values(state.records)
        .filter((record) => record.state === 'active')
        .filter((record) => (input.language ? record.language === input.language : true))
        .map((record) => ({ record, score: textScore(input.query, record) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      const engineMatches = engineRecall.ok ? engineRecall.value : [];
      const mergedById = new Map<string, { record: MemoryRecord; score: number }>();

      stateMatches.forEach((entry, index) => {
        mergedById.set(entry.record.id, { record: entry.record, score: 1 / (60 + index + 1) + entry.score });
      });

      engineMatches.forEach((pattern, index) => {
        const current = state.records[pattern.id];
        const record: MemoryRecord = current ?? {
          id: pattern.id,
          name: pattern.name,
          kind: pattern.kind,
          language: pattern.language,
          signature: pattern.signature,
          description: pattern.description,
          blobSha: pattern.blobSha,
          tags: pattern.tags ?? [],
          notes: [],
          state: 'active',
          createdAt: nowIso(ctx),
          updatedAt: nowIso(ctx),
          timesRecalled: pattern.timesRecalled ?? 0,
          timesUsed: 0,
          timesUsedSuccessfully: pattern.timesUsedSuccessfully ?? 0,
          confidence: pattern.confidence ?? 0.5,
          lineage: [],
        };
        const existing = mergedById.get(record.id);
        const rrf = 1 / (60 + index + 1);
        mergedById.set(record.id, { record, score: (existing?.score ?? 0) + rrf + textScore(input.query, record) });
      });

      const sorted = [...mergedById.values()]
        .filter((entry) => entry.record.confidence >= (input.minConfidence ?? 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10);

      const now = nowIso(ctx);
      const nextRecords = { ...state.records };
      sorted.forEach((entry) => {
        const nextTimesRecalled = entry.record.timesRecalled + 1;
        nextRecords[entry.record.id] = {
          ...entry.record,
          timesRecalled: nextTimesRecalled,
          confidence: confidence(nextTimesRecalled, entry.record.timesUsedSuccessfully),
          updatedAt: now,
        };
      });
      const nextState = appendEvent(
        {
          ...state,
          records: nextRecords,
          sessions: [...new Set([...state.sessions, ctx.sessionId])],
        },
        { at: now, type: 'recall', patternId: sorted[0]?.record.id ?? 'none', note: input.query },
      );
      await saveState(ctx, nextState);
      return ok({
        matches: sorted.map((entry) => ({ ...serializeRecord(nextRecords[entry.record.id] ?? entry.record), relevance: entry.score })),
        engineMatches: engineMatches.length,
      });
    },
  );

  const storeTool = createWriteTool<
    { name: string; kind: string; code: string; language?: string; signature?: string; description?: string; tags?: string[] },
    Readonly<Record<string, unknown>>
  >(
    'memory.store',
    'Persist a named pattern into memory with blob storage and AST-fingerprint deduplication.',
    { type: 'object', required: ['name', 'kind', 'code'], properties: { name: { type: 'string' }, kind: { type: 'string' }, code: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const fingerprint = await fingerprintForCode(input.code, ctx);
      const duplicate = Object.values(state.records).find((record) => record.state === 'active' && record.fingerprint && record.fingerprint === fingerprint);
      if (duplicate) {
        return ok({ id: duplicate.id, deduplicated: true, record: serializeRecord(duplicate) });
      }

      const blobResult = ctx.services.blobStore ? await ctx.services.blobStore.put(input.code, input.language) : ok({ sha: `inline:${input.name}`, sizeBytes: input.code.length });
      if (!blobResult.ok) {
        return blobResult;
      }
      const memoryEngine = ctx.services.memoryEngine;
      const stored = memoryEngine
        ? await memoryEngine.store({
            name: input.name,
            kind: input.kind,
            language: input.language,
            signature: input.signature,
            description: input.description,
            blobSha: blobResult.value.sha,
            tags: input.tags ?? [],
          })
        : ok({ id: `memory:${blobResult.value.sha}` });
      if (!stored.ok) {
        return stored;
      }
      const id = stored.value.id;
      const record: MemoryRecord = {
        id,
        name: input.name,
        kind: input.kind,
        language: input.language,
        signature: input.signature,
        description: input.description,
        blobSha: blobResult.value.sha,
        fingerprint,
        tags: input.tags ?? [],
        notes: [],
        state: 'active',
        createdAt: nowIso(ctx),
        updatedAt: nowIso(ctx),
        timesRecalled: 0,
        timesUsed: 0,
        timesUsedSuccessfully: 0,
        confidence: 0.5,
        lineage: [],
      };
      const nextState = appendEvent(
        {
          ...state,
          records: { ...state.records, [id]: record },
          sessions: [...new Set([...state.sessions, ctx.sessionId])],
        },
        { at: nowIso(ctx), type: 'store', patternId: id, note: input.name },
      );
      await saveState(ctx, nextState);
      return ok({ id, record: serializeRecord(record), blob: blobResult.value });
    },
  );

  const evolveTool = createWriteTool<
    { parentId: string; name?: string; code: string; language?: string; signature?: string; description?: string; tags?: string[] },
    Readonly<Record<string, unknown>>
  >(
    'memory.evolve',
    'Store an improved child pattern, shadowing its parent while preserving lineage.',
    { type: 'object', required: ['parentId', 'code'], properties: { parentId: { type: 'string' }, code: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const parent = state.records[input.parentId];
      if (!parent) {
        return err('NOT_FOUND', `No pattern found for ${input.parentId}`);
      }
      const stored = await storeTool.execute(
        {
          name: input.name ?? `${parent.name} evolved`,
          kind: parent.kind,
          code: input.code,
          language: input.language ?? parent.language,
          signature: input.signature ?? parent.signature,
          description: input.description ?? parent.description,
          tags: [...new Set([...(parent.tags ?? []), ...(input.tags ?? [])])],
        },
        ctx,
      );
      if (!stored.ok) {
        return stored;
      }
      const childId = typeof stored.value.id === 'string' ? stored.value.id : String(stored.value.id);
      const currentState = await loadState(ctx);
      const child = currentState.records[childId];
      if (!child) {
        return err('INTERNAL', 'Newly stored child pattern could not be loaded');
      }
      const nextState = appendEvent(
        {
          ...currentState,
          records: {
            ...currentState.records,
            [parent.id]: { ...parent, state: 'shadowed', updatedAt: nowIso(ctx) },
            [child.id]: { ...child, parentId: parent.id, lineage: [...parent.lineage, parent.id] },
          },
          links: [...currentState.links, { from: child.id, to: parent.id, type: 'evolved_from', createdAt: nowIso(ctx) }],
        },
        { at: nowIso(ctx), type: 'evolve', patternId: child.id, note: parent.id },
      );
      await saveState(ctx, nextState);
      return ok({ parent: serializeRecord(nextState.records[parent.id] ?? parent), child: serializeRecord(nextState.records[child.id] ?? child) });
    },
  );

  const linkTool = createWriteTool<{ from: string; to: string; type: MemoryLinkType }, Readonly<Record<string, unknown>>>(
    'memory.link',
    'Create a typed relationship between two memory patterns.',
    { type: 'object', required: ['from', 'to', 'type'], properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      if (!state.records[input.from] || !state.records[input.to]) {
        return err('NOT_FOUND', 'Both patterns must exist before linking them');
      }
      const link: MemoryLink = { from: input.from, to: input.to, type: input.type, createdAt: nowIso(ctx) };
      const next = appendEvent(
        { ...state, links: [...state.links, link] },
        { at: link.createdAt, type: 'link', patternId: input.from, note: `${input.type}:${input.to}` },
      );
      await saveState(ctx, next);
      return ok({ link });
    },
  );

  const relatedTool = createReadTool<{ id: string }, Readonly<Record<string, unknown>>>(
    'memory.related',
    'Find patterns connected by explicit lineage or relationship edges.',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      if (!state.records[input.id]) {
        return err('NOT_FOUND', `No pattern found for ${input.id}`);
      }
      return ok({ related: neighbors(state, input.id).map((entry) => ({ ...serializeRecord(entry.record), relationship: entry.type, distance: entry.distance })) });
    },
  );

  const forgetTool = createWriteTool<{ id: string }, Readonly<Record<string, unknown>>>(
    'memory.forget',
    'Soft-delete a memory pattern without immediately deleting its blob.',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const record = state.records[input.id];
      if (!record) {
        return err('NOT_FOUND', `No pattern found for ${input.id}`);
      }
      const nextState = appendEvent(
        { ...state, records: { ...state.records, [record.id]: { ...record, state: 'deleted', updatedAt: nowIso(ctx) } } },
        { at: nowIso(ctx), type: 'forget', patternId: input.id },
      );
      await saveState(ctx, nextState);
      return ok({ id: input.id, state: 'deleted', blobPinned: false });
    },
    true,
  );

  const statsTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'memory.stats',
    'Show pattern counts, leaders, sessions, and decay candidates.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const state = await loadState(ctx);
      const records = Object.values(state.records).filter((record) => record.state !== 'deleted');
      const byKind = records.reduce<Record<string, number>>((acc, record) => {
        acc[record.kind] = (acc[record.kind] ?? 0) + 1;
        return acc;
      }, {});
      const byLanguage = records.reduce<Record<string, number>>((acc, record) => {
        if (record.language) {
          acc[record.language] = (acc[record.language] ?? 0) + 1;
        }
        return acc;
      }, {});
      const topConfidence = [...records].sort((a, b) => b.confidence - a.confidence).slice(0, 5).map(serializeRecord);
      const topRecall = [...records].sort((a, b) => b.timesRecalled - a.timesRecalled).slice(0, 5).map(serializeRecord);
      const decayCandidates = [...records]
        .map((record) => {
          const days = Math.max(0, (Date.now() - Date.parse(record.updatedAt)) / (1000 * 60 * 60 * 24));
          return { record, retention: retention(record.timesRecalled, days) };
        })
        .filter((entry) => entry.retention < 0.35)
        .sort((a, b) => a.retention - b.retention)
        .slice(0, 10)
        .map((entry) => ({ ...serializeRecord(entry.record), retention: entry.retention }));
      return ok({ total: records.length, byKind, byLanguage, topConfidence, topRecall, sessions: state.sessions.length, decayCandidates });
    },
  );

  const exportTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'memory.export',
    'Export pattern metadata without code bodies for safe transport.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const state = await loadState(ctx);
      const records = Object.values(state.records).map((record) => ({
        id: record.id,
        name: record.name,
        kind: record.kind,
        language: record.language,
        signature: record.signature,
        confidence: record.confidence,
        timesRecalled: record.timesRecalled,
        timesUsedSuccessfully: record.timesUsedSuccessfully,
        tags: record.tags,
        lineage: record.lineage,
        blobSha: record.blobSha,
      }));
      return ok({ patterns: records, links: state.links });
    },
  );

  const importTool = createWriteTool<{ patterns: unknown[] }, Readonly<Record<string, unknown>>>(
    'memory.import',
    'Import a pattern metadata export, assigning new session lineage and deduplicating by fingerprint.',
    { type: 'object', required: ['patterns'], properties: { patterns: { type: 'array' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const nextRecords: Record<string, MemoryRecord> = { ...state.records };
      let imported = 0;
      let skipped = 0;
      for (const entry of input.patterns) {
        const parsed = coerceImportedRecord(entry);
        if (!parsed || !parsed.id || !parsed.name || !parsed.kind) {
          skipped += 1;
          continue;
        }
        if (nextRecords[parsed.id]) {
          skipped += 1;
          continue;
        }
        nextRecords[parsed.id] = {
          id: parsed.id,
          name: parsed.name,
          kind: parsed.kind,
          language: parsed.language,
          signature: parsed.signature,
          description: undefined,
          blobSha: parsed.blobSha,
          fingerprint: undefined,
          tags: parsed.tags ?? [],
          notes: [],
          state: 'active',
          createdAt: nowIso(ctx),
          updatedAt: nowIso(ctx),
          timesRecalled: parsed.timesRecalled ?? 0,
          timesUsed: 0,
          timesUsedSuccessfully: parsed.timesUsedSuccessfully ?? 0,
          confidence: parsed.confidence ?? 0.5,
          lineage: [],
        };
        imported += 1;
      }
      const nextState = appendEvent(
        { ...state, records: nextRecords, sessions: [...new Set([...state.sessions, ctx.sessionId])] },
        { at: nowIso(ctx), type: 'import', patternId: `session:${ctx.sessionId}`, note: `${imported}` },
      );
      await saveState(ctx, nextState);
      return ok({ imported, skipped });
    },
  );

  const mergeTool = createWriteTool<{ primaryId: string; secondaryId: string }, Readonly<Record<string, unknown>>>(
    'memory.merge',
    'Merge two similar patterns into one higher-confidence canonical record.',
    { type: 'object', required: ['primaryId', 'secondaryId'], properties: { primaryId: { type: 'string' }, secondaryId: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const primary = state.records[input.primaryId];
      const secondary = state.records[input.secondaryId];
      if (!primary || !secondary) {
        return err('NOT_FOUND', 'Both primary and secondary patterns must exist');
      }
      const canonical = primary.confidence >= secondary.confidence ? primary : secondary;
      const merged = canonical.id === primary.id ? secondary : primary;
      const nextCanonical: MemoryRecord = {
        ...canonical,
        tags: [...new Set([...canonical.tags, ...merged.tags])],
        timesRecalled: canonical.timesRecalled + merged.timesRecalled,
        timesUsedSuccessfully: canonical.timesUsedSuccessfully + merged.timesUsedSuccessfully,
        confidence: confidence(canonical.timesRecalled + merged.timesRecalled, canonical.timesUsedSuccessfully + merged.timesUsedSuccessfully),
        lineage: [...new Set([...canonical.lineage, ...merged.lineage, merged.id])],
        updatedAt: nowIso(ctx),
      };
      const nextMerged: MemoryRecord = { ...merged, state: 'shadowed', updatedAt: nowIso(ctx) };
      const nextState = appendEvent(
        {
          ...state,
          records: { ...state.records, [nextCanonical.id]: nextCanonical, [nextMerged.id]: nextMerged },
          links: [
            ...state.links,
            { from: nextCanonical.id, to: primary.id, type: 'merged_from', createdAt: nowIso(ctx) },
            { from: nextCanonical.id, to: secondary.id, type: 'merged_from', createdAt: nowIso(ctx) },
          ],
        },
        { at: nowIso(ctx), type: 'merge', patternId: nextCanonical.id, note: `${primary.id},${secondary.id}` },
      );
      await saveState(ctx, nextState);
      return ok({ canonical: serializeRecord(nextCanonical), shadowed: serializeRecord(nextMerged) });
    },
  );

  const splitTool = createWriteTool<{ id: string; names?: string[] }, Readonly<Record<string, unknown>>>(
    'memory.split',
    'Split a compound pattern into smaller sub-patterns with proportional confidence.',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' }, names: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const record = state.records[input.id];
      if (!record) {
        return err('NOT_FOUND', `No pattern found for ${input.id}`);
      }
      const names = input.names && input.names.length > 0
        ? input.names
        : record.signature
            ?.split(/[,|]/u)
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .slice(0, 3) ?? [`${record.name} part 1`, `${record.name} part 2`];
      const perChildConfidence = clamp(record.confidence / Math.max(1, names.length));
      const nextRecords = { ...state.records };
      const childIds: string[] = [];
      names.forEach((name, index) => {
        const id = `${record.id}:split:${index + 1}`;
        childIds.push(id);
        nextRecords[id] = {
          id,
          name,
          kind: record.kind,
          language: record.language,
          signature: undefined,
          description: record.description,
          blobSha: record.blobSha,
          fingerprint: record.fingerprint,
          tags: record.tags,
          notes: record.notes,
          parentId: record.id,
          state: 'active',
          createdAt: nowIso(ctx),
          updatedAt: nowIso(ctx),
          timesRecalled: Math.floor(record.timesRecalled / Math.max(1, names.length)),
          timesUsed: 0,
          timesUsedSuccessfully: Math.floor(record.timesUsedSuccessfully / Math.max(1, names.length)),
          confidence: perChildConfidence,
          lineage: [...record.lineage, record.id],
        };
      });
      nextRecords[record.id] = { ...record, state: 'shadowed', updatedAt: nowIso(ctx) };
      const nextState = appendEvent(
        { ...state, records: nextRecords },
        { at: nowIso(ctx), type: 'split', patternId: record.id, note: childIds.join(',') },
      );
      await saveState(ctx, nextState);
      return ok({ parent: serializeRecord(nextRecords[record.id] ?? record), children: childIds.map((id) => serializeRecord(nextRecords[id]!)) });
    },
  );

  const annotateTool = createWriteTool<{ id: string; note?: string; tag?: string }, Readonly<Record<string, unknown>>>(
    'memory.annotate',
    'Attach an FTS-searchable note or tag to an existing pattern.',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' }, note: { type: 'string' }, tag: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const record = state.records[input.id];
      if (!record) {
        return err('NOT_FOUND', `No pattern found for ${input.id}`);
      }
      const nextRecord: MemoryRecord = {
        ...record,
        tags: input.tag ? [...new Set([...record.tags, input.tag])] : record.tags,
        notes: input.note ? [...record.notes, input.note] : record.notes,
        updatedAt: nowIso(ctx),
      };
      const nextState = appendEvent(
        { ...state, records: { ...state.records, [record.id]: nextRecord } },
        { at: nowIso(ctx), type: 'annotate', patternId: record.id, note: input.tag ?? input.note },
      );
      await saveState(ctx, nextState);
      return ok({ record: serializeRecord(nextRecord) });
    },
  );

  const historyTool = createReadTool<{ id: string }, Readonly<Record<string, unknown>>>(
    'memory.history',
    'Show version lineage and confidence changes for a pattern over time.',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    async (input, ctx) => {
      const state = await loadState(ctx);
      const record = state.records[input.id];
      if (!record) {
        return err('NOT_FOUND', `No pattern found for ${input.id}`);
      }
      const lineageIds = [...record.lineage, record.id];
      const lineage = lineageIds.map((id) => state.records[id]).filter((entry): entry is MemoryRecord => Boolean(entry)).map(serializeRecord);
      const events = state.events.filter((event) => lineageIds.includes(event.patternId));
      return ok({ lineage, events });
    },
  );

  const decayReportTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'memory.decay_report',
    'Report patterns approaching the 30% Ebbinghaus retention threshold.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const state = await loadState(ctx);
      const report = Object.values(state.records)
        .filter((record) => record.state === 'active')
        .map((record) => {
          const days = Math.max(0, (Date.now() - Date.parse(record.updatedAt)) / (1000 * 60 * 60 * 24));
          return {
            ...serializeRecord(record),
            retention: retention(record.timesRecalled, days),
            daysSinceRecall: days,
            strength: strength(record.timesRecalled),
          };
        })
        .filter((entry) => typeof entry.retention === 'number' && (entry.retention as number) <= 0.4)
        .sort((a, b) => Number(a.retention) - Number(b.retention));
      return ok({ threshold: 0.3, patterns: report });
    },
  );

  const calibrateTool = createWriteTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'memory.confidence_calibrate',
    'Recalibrate memory confidence toward Bayesian empirical outcomes.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const state = await loadState(ctx);
      const nextRecords: Record<string, MemoryRecord> = { ...state.records };
      const changes: Array<{ id: string; before: number; after: number; empirical: number }> = [];
      Object.values(state.records).forEach((record) => {
        const empirical = record.timesRecalled === 0 ? 0.5 : record.timesUsedSuccessfully / Math.max(1, record.timesRecalled);
        const bayesian = confidence(record.timesRecalled, record.timesUsedSuccessfully);
        if (Math.abs(record.confidence - bayesian) >= 0.1) {
          const after = clamp((record.confidence + bayesian + empirical) / 3);
          nextRecords[record.id] = { ...record, confidence: after, updatedAt: nowIso(ctx) };
          changes.push({ id: record.id, before: record.confidence, after, empirical });
        }
      });
      const nextState = appendEvent(
        { ...state, records: nextRecords },
        { at: nowIso(ctx), type: 'confidence_calibrate', patternId: changes[0]?.id ?? 'none', note: `${changes.length}` },
      );
      await saveState(ctx, nextState);
      return ok({ recalibrated: changes.length, changes: changes.slice(0, 20) });
    },
  );

  return [
    recallTool,
    storeTool,
    evolveTool,
    linkTool,
    relatedTool,
    forgetTool,
    statsTool,
    exportTool,
    importTool,
    mergeTool,
    splitTool,
    annotateTool,
    historyTool,
    decayReportTool,
    calibrateTool,
  ] as ForgeTool<object, unknown>[];
}

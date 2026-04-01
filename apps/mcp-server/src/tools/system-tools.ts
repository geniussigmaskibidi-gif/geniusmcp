// @ts-nocheck
import {
  buildForgeTool,
  err,
  ok,
  percentile,
  type ForgeResult,
  type ForgeTool,
  type ForgeToolContext,
  type MetricSnapshot,
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
    category: 'system',
    inputSchema,
    tags: ['system', 'diagnostics'],
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
    category: 'system',
    inputSchema,
    tags: ['system', 'diagnostics'],
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => destructive,
    execute,
  });
}

export function createSystemTools(): ForgeTool<object, unknown>[] {
  const healthTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.health',
    'Run registered health probes.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      if (!ctx.services.healthRegistry) return err('SERVICE_UNAVAILABLE', 'Health registry is required');
      const result = await ctx.services.healthRegistry.check();
      return result.ok ? ok({ health: result.value }) : result;
    },
  );

  const statsTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.stats',
    'Show aggregate runtime statistics across blobs, memory, search, jobs, and metrics.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const [disk, memory, indexCount, queue, metrics] = await Promise.all([
        ctx.services.blobStore?.diskUsage() ?? ok({ bytes: 0, blobs: 0 }),
        ctx.services.memoryEngine?.stats() ?? ok({}),
        ctx.services.searchIndex?.count() ?? ok(0),
        ctx.services.jobQueue?.stats() ?? ok({}),
        Promise.resolve(ctx.services.metrics?.snapshot() ?? []),
      ]);
      return ok({
        blobs: disk.ok ? disk.value : { bytes: 0, blobs: 0 },
        memory: memory.ok ? memory.value : {},
        searchIndexCount: indexCount.ok ? indexCount.value : 0,
        queue: queue.ok ? queue.value : {},
        metrics: metrics as readonly MetricSnapshot[],
      });
    },
  );

  const configTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.config',
    'Return a safe snapshot of current server configuration.',
    { type: 'object', properties: {} },
    async (_input, ctx) => ok({ config: ctx.config ?? {} }),
  );

  const gcTool = createWriteTool<{ dryRun?: boolean }, Readonly<Record<string, unknown>>>(
    'system.gc',
    'Run blob garbage collection with mark and sweep.',
    { type: 'object', properties: { dryRun: { type: 'boolean' } } },
    async (input, ctx) => {
      if (!ctx.services.blobGc) return err('SERVICE_UNAVAILABLE', 'Blob GC is required');
      const marked = await ctx.services.blobGc.markOrphans();
      if (!marked.ok) return marked;
      const swept = await ctx.services.blobGc.sweep(input.dryRun);
      return swept.ok ? ok({ marked: marked.value, report: swept.value }) : swept;
    },
    true,
  );

  const scrubTool = createWriteTool<{ rate?: number }, Readonly<Record<string, unknown>>>(
    'system.scrub',
    'Scrub a sample of blobs for integrity issues.',
    { type: 'object', properties: { rate: { type: 'number' } } },
    async (input, ctx) => {
      if (!ctx.services.blobGc) return err('SERVICE_UNAVAILABLE', 'Blob GC is required');
      const report = await ctx.services.blobGc.scrubSample(input.rate ?? 0.05);
      return report.ok ? ok({ report: report.value }) : report;
    },
    true,
  );

  const doctorTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.doctor',
    'Run a comprehensive diagnostic sweep over health, auth, index, and rate limits.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const checks: Array<{ name: string; ok: boolean; details?: string }> = [];
      if (ctx.services.healthRegistry) {
        const health = await ctx.services.healthRegistry.check();
        checks.push({ name: 'healthRegistry', ok: health.ok && health.value.ok, details: health.ok ? `${health.value.probes.length} probes` : health.error.message });
      }
      if (ctx.services.gitHubGateway) {
        const rate = await ctx.services.gitHubGateway.getRateLimit();
        checks.push({ name: 'githubAuth', ok: rate.ok, details: rate.ok ? 'rate-limit ok' : rate.error.message });
      }
      if (ctx.services.searchIndex) {
        const count = await ctx.services.searchIndex.count();
        checks.push({ name: 'searchIndex', ok: count.ok, details: count.ok ? `${count.value} docs` : count.error.message });
      }
      if (ctx.services.memoryEngine) {
        const stats = await ctx.services.memoryEngine.stats();
        checks.push({ name: 'memoryEngine', ok: stats.ok, details: stats.ok ? 'stats ok' : stats.error.message });
      }
      return ok({ ok: checks.every((check) => check.ok), checks });
    },
  );

  const benchmarkTool = createReadTool<{ queries?: string[] }, Readonly<Record<string, unknown>>>(
    'system.benchmark',
    'Run five benchmark queries and report p50/p95 latency.',
    { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const queries = input.queries ?? ['retry with exponential backoff', 'rate limiter', 'token bucket', 'circuit breaker', 'batching'];
      if (!ctx.services.searchIndex) return err('SERVICE_UNAVAILABLE', 'Search index is required');
      const latencies: number[] = [];
      const rows: Array<{ query: string; latencyMs: number; hits: number }> = [];
      for (const query of queries.slice(0, 5)) {
        const started = Date.now();
        const result = await ctx.services.searchIndex.searchHybrid(query, 10);
        const latencyMs = Date.now() - started;
        latencies.push(latencyMs);
        rows.push({ query, latencyMs, hits: result.ok ? result.value.length : 0 });
      }
      return ok({ rows, p50: percentile(latencies, 50), p95: percentile(latencies, 95) });
    },
  );

  const rateLimitsTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.rate_limits',
    'Fetch current GitHub rate-limit budgets.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      if (!ctx.services.gitHubGateway) return err('SERVICE_UNAVAILABLE', 'GitHub gateway is required');
      const result = await ctx.services.gitHubGateway.getRateLimit();
      return result.ok ? ok({ rateLimits: result.value }) : result;
    },
  );

  const cacheStatsTool = createReadTool<Record<string, never>, Readonly<Record<string, unknown>>>(
    'system.cache_stats',
    'Report cache-related metric snapshots.',
    { type: 'object', properties: {} },
    async (_input, ctx) => {
      const metrics = (await Promise.resolve(ctx.services.metrics?.snapshot() ?? [])) as readonly MetricSnapshot[];
      const cacheMetrics = metrics.filter((metric) => metric.name.includes('cache'));
      return ok({ metrics: cacheMetrics, total: cacheMetrics.length });
    },
  );

  const indexStatsTool = createReadTool<{ sampleQueries?: string[] }, Readonly<Record<string, unknown>>>(
    'system.index_stats',
    'Report index counts and query-planner estimates.',
    { type: 'object', properties: { sampleQueries: { type: 'array', items: { type: 'string' } } } },
    async (input, ctx) => {
      const count = ctx.services.searchIndex ? await ctx.services.searchIndex.count() : ok(0);
      const planner = ctx.services.queryPlanner;
      const samples = await Promise.all((input.sampleQueries ?? ['retry with exponential backoff', 'jwt auth']).map(async (query) => {
        const plan = planner ? await planner.planQuery(query) : ok({ queryClass: 'unknown', lanes: [], estimatedCostMs: 0 });
        return plan.ok ? { query, ...plan.value } : { query, error: plan.error.message };
      }));
      return ok({ documentCount: count.ok ? count.value : 0, samples });
    },
  );

  return [
    healthTool,
    statsTool,
    configTool,
    gcTool,
    scrubTool,
    doctorTool,
    benchmarkTool,
    rateLimitsTool,
    cacheStatsTool,
    indexStatsTool,
  ] as ForgeTool<object, unknown>[];
}

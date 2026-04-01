// This file is the single import point for all 8 tool category files.
// It re-exports existing types + provides missing utilities and interfaces.

// ─────────────────────────────────────────────────────────────
// Re-export existing types from the codebase
// ─────────────────────────────────────────────────────────────

export type { ForgeResult, ForgeError, ForgeErrorCode, ForgeWarning } from "./types.js";
export { ok, err } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Utility functions (used by all tool files)
// ─────────────────────────────────────────────────────────────

/** Clamp a number to [min, max]. Default [0, 1]. Used in scoring. */
export function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/** Arithmetic mean. Returns 0 for empty array. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Percentile (0-100) of sorted numeric array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!;
}

/** Normalize whitespace: collapse runs, trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Tokenize text into lowercase word tokens (>1 char). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9_]/g, " ").split(/\s+/).filter(t => t.length > 1);
}

/** Deduplicate preserving order. */
export function unique<T>(items: T[], key?: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const k = key ? key(item) : String(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Current time as ISO string. Accepts optional context for testability. */
export function nowIso(_ctx?: unknown): string {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────
// Domain types (consumed by tool implementations)
// ─────────────────────────────────────────────────────────────

export type ForgePreset = "balanced" | "battle_tested" | "teaching_quality" | "import_ready";

export interface CodeSearchHit {
  readonly source: string;
  readonly queryVariant?: string;
  readonly owner?: string;
  readonly repo: string;
  readonly path: string;
  readonly snippet?: string;
  readonly content?: string;
  readonly lineStart?: number | null;
  readonly startLine?: number | null;
  readonly url?: string | null;
  readonly language?: string | null;
  readonly discoveredAt?: string;
  readonly [key: string]: unknown;
}

export interface RepoOverview {
  readonly fullName?: string;
  readonly stars?: number;
  readonly forks?: number;
  readonly language?: string | null;
  readonly primaryLanguage?: string | null;
  readonly license?: string | null;
  readonly topics?: string[];
  readonly archived?: boolean;
  readonly pushedAt?: string;
  readonly hasTests?: boolean;
  readonly ci?: boolean;
  readonly openIssues?: number;
  readonly defaultBranch?: string;
  // GPT tool compat:
  readonly owner?: string;
  readonly repo?: string;
  readonly name?: string;
  readonly description?: string;
  readonly languageStats?: Record<string, number>;
  readonly [key: string]: unknown;
}

export interface QualityBreakdown {
  queryFit: number;
  durability: number;
  vitality: number;
  importability: number;
  codeQuality: number;
  evidenceConfidence: number;
  retrieval?: number;
  teachability?: number;
  penalties?: number;
}

export interface WinnowingFingerprint {
  readonly hashes: number[];
  readonly kgramSize: number;
  readonly windowSize: number;
  readonly normalizedLength: number;
}

export interface SourceScatterQuery {
  readonly source: string;
  readonly queryText: string;
  readonly parameters: Record<string, unknown>;
  readonly estimatedCost: number;
  readonly purpose: string;
}

export interface ScatterCoverage {
  readonly sourcesAttempted: string[];
  readonly sourcesSucceeded: string[];
  readonly sourcesFailed: Array<{ source: string; reason: string }>;
  readonly blindSpots: string[];
  readonly evidenceConfidence: number;
  readonly totalHits: number;
  readonly uniqueRepos: number;
}

export interface ScatterResult {
  readonly hits: CodeSearchHit[];
  readonly coverage: ScatterCoverage;
}

export interface SymbolRecord {
  readonly name: string;
  readonly kind: string;
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature?: string | null;
  readonly docComment?: string | null;
  readonly code?: string;
  readonly astFingerprint?: string;
  readonly imports?: string[];
  // GPT tool compat:
  readonly uid?: string;
  readonly path?: string;
  readonly container?: string;
  readonly externalDeps?: string[];
  readonly referencesCount?: number;
  readonly [key: string]: unknown;
}

export interface CallGraphEdge {
  readonly sourceId: number;
  readonly targetId: number | null;
  readonly targetName: string;
  readonly edgeKind: string;
  readonly confidence?: string;
  // GPT tool compat:
  readonly from?: string;
  readonly to?: string;
  readonly kind?: string;
  readonly precision?: "exact" | "typed" | "import_scoped" | "lexical" | string;
  readonly [key: string]: unknown;
}

export interface MemoryPattern {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
  readonly language?: string | null;
  readonly code?: string | null;
  readonly signature?: string | null;
  readonly description?: string | null;
  readonly confidence: number;
  readonly timesRecalled: number;
  readonly timesUsedSuccessfully: number;
  readonly lastRecalledAt?: string | null;
  readonly sourceType?: string;
  readonly sourceRepo?: string | null;
  readonly sourcePath?: string | null;
  readonly tags?: string[];
}

export interface ImportSlice {
  readonly primarySymbol: SymbolRecord;
  readonly localDependencies: SymbolRecord[];
  readonly externalImports: string[];
  readonly totalLines: number;
  readonly selfContained: boolean;
  // GPT tool compat:
  readonly symbols?: SymbolRecord[];
  readonly files?: string[];
  readonly code?: string;
  readonly localDeps?: SymbolRecord[];
  readonly externalPackages?: string[];
  readonly [key: string]: unknown;
}

export interface ConflictReport {
  readonly conflicts: Array<{
    severity: string;
    kind: string;
    symbolName: string;
    suggestion: string;
  }>;
  readonly hasBlockingConflicts: boolean;
  readonly hasConflicts?: boolean;
  readonly [key: string]: unknown;
}

export interface PolicyDecision {
  readonly verdict: string;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface StylePreferences {
  readonly indentation: "tabs" | "spaces";
  readonly indentWidth: number;
  readonly quoteStyle: "single" | "double";
  readonly semicolons: boolean;
  readonly quotes?: "single" | "double";
  readonly indent?: string;
  readonly [key: string]: unknown;
}

export interface PackageDependency {
  readonly name: string;
  readonly version?: string;
  readonly type: "direct" | "dev" | "peer" | "optional";
  readonly direct?: boolean;
  readonly [key: string]: unknown;
}

export interface MetricSnapshot {
  readonly name: string;
  readonly type: string;
  readonly value: number;
  readonly labels: Record<string, string>;
  readonly timestamp: number;
}

// ─────────────────────────────────────────────────────────────
// Service interfaces (injected into ForgeToolContext.services)
// ─────────────────────────────────────────────────────────────

// Shorthand for Promise<ForgeResult<T>>
type FR<T> = Promise<import("./types.js").ForgeResult<T>>;

export interface GitHubGateway {
  searchRepos(query: string, opts?: { sort?: string; limit?: number }): FR<RepoOverview[]>;
  searchCode(query: string, opts?: { limit?: number }): FR<CodeSearchHit[]>;
  getRepoOverview(owner: string, repo: string): FR<RepoOverview>;
  getFileContent(owner: string, repo: string, path: string, ref?: string): FR<{ content: string; path: string }>;
  getTree?(owner: string, repo: string, ref?: string): FR<Array<{ path: string; type: string }>>;
  getRateLimit(): FR<Record<string, unknown>>;
  // GPT tool compat — optional extended methods:
  searchIssues?(query: string): FR<unknown>;
  searchPullRequests?(query: string): FR<unknown>;
  getRepoLanguages?(owner: string, repo: string): FR<Record<string, number>>;
  getRepoContributors?(owner: string, repo: string): FR<unknown>;
  getRepoReleases?(owner: string, repo: string): FR<unknown>;
  getRepoIssues?(owner: string, repo: string, query?: string): FR<unknown>;
  getRepoPulls?(owner: string, repo: string, query?: string): FR<unknown>;
  getRepoActions?(owner: string, repo: string): FR<unknown>;
  getDependencyGraph?(owner: string, repo: string): FR<unknown>;
  getSecurityAdvisories?(query: string): FR<unknown>;
  getTrendingRepos?(language?: string, since?: string): FR<unknown>;
  compareRepos?(repos: string[]): FR<unknown>;
}

export interface SourceOrchestrator {
  scatter(queries: SourceScatterQuery[], opts?: { timeoutMs?: number }): FR<ScatterResult>;
}

export interface WorkspaceGateway {
  readFile(path: string): FR<string>;
  listFiles(glob?: string): FR<string[]>;
  getSymbols(path: string): FR<SymbolRecord[]>;
  getCallGraph(path: string): FR<CallGraphEdge[]>;
  getImports(path: string): FR<string[]>;
  getDependencies(): FR<PackageDependency[]>;
  // GPT tool compat:
  findText?(query: string, opts?: { glob?: string }): FR<Array<{ path: string; line: number; text: string }>>;
  glob?(pattern: string): FR<string[]>;
  listSymbols?(scope?: string): FR<SymbolRecord[]>;
  resolveDefinition?(symbol: string): FR<{ path: string; line: number } | null>;
  getSymbol?(name: string): FR<SymbolRecord | null>;
  getWorkspaceSymbols?(): FR<SymbolRecord[]>;
  findReferences?(symbol: string): FR<Array<{ path: string; line: number }>>;
}

export interface ForgeServices {
  readonly gitHubGateway?: GitHubGateway;
  readonly sourceOrchestrator?: SourceOrchestrator;
  readonly workspaceGateway?: WorkspaceGateway;
  readonly qualityScorer?: {
    computeScore(signals: Record<string, unknown>): FR<{ breakdown: QualityBreakdown; why: string[] }>;
    compositeScore(breakdown: QualityBreakdown, preset: ForgePreset): FR<number>;
    applyHardCaps(breakdown: QualityBreakdown, flags: Record<string, boolean>): FR<QualityBreakdown>;
  };
  readonly winnowing?: {
    computeFingerprint(text: string): FR<WinnowingFingerprint>;
    contentHash(text: string): FR<string>;
    jaccardSimilarity(a: WinnowingFingerprint, b: WinnowingFingerprint): number;
    clusterByJaccard?(items: Array<Record<string, unknown>>, threshold: number): FR<Array<Array<Record<string, unknown>>>>;
  };
  readonly simHash?: {
    simhash64(text: string): FR<bigint>;
    hammingDistance(a: bigint, b: bigint): number;
  };
  readonly memoryEngine?: {
    store(opts: Record<string, unknown>): FR<number>;
    recall(query: string, opts?: Record<string, unknown>): FR<{ patterns: MemoryPattern[]; total: number }>;
    markSuccess(id: number): FR<void>;
    runDecay(): FR<number>;
    stats(): FR<Record<string, unknown>>;
  };
  readonly archetypeClassifier?: {
    classifySymbol(input: Record<string, unknown>): FR<{ category: string }>;
    archetypeName(category: string, query: string): FR<string>;
    archetypeTradeoffs(category: string): FR<string[]>;
  };
  readonly policyEngine?: {
    evaluatePolicy(mode: string, license: string | null | undefined, signals: Record<string, unknown>): Promise<PolicyDecision>;
  };
  readonly sliceResolver?: {
    resolveSliceClosure(uid: string, symbols: SymbolRecord[], edges: CallGraphEdge[], maxDepth?: number): FR<ImportSlice | null>;
  };
  readonly conflictDetector?: {
    detectConflicts(candidates: Array<{ name: string; kind: string; sourceRepo: string }>, workspace: SymbolRecord[]): FR<ConflictReport>;
  };
  readonly healthRegistry?: { check(): FR<Record<string, unknown>> };
  readonly blobGc?: {
    markOrphans(): FR<number>;
    sweep(dryRun?: boolean): FR<Record<string, unknown>>;
    scrubSample(rate: number): FR<Record<string, unknown>>;
  };
  readonly metrics?: { snapshot(): MetricSnapshot[] };
  readonly searchIndex?: {
    searchHybrid(query: string, limit?: number): FR<Array<{ filePath: string; symbolName: string; relevanceScore: number }>>;
    count(): number;
    add?(doc: Record<string, unknown>): FR<unknown>;
  };
  readonly blobStore?: {
    put(content: string, lang?: string): FR<{ sha: string; sizeBytes: number }>;
    get(sha: string): FR<unknown>;
    diskUsage(): { totalBytes: number; blobCount: number; utilization: number };
  };
  readonly workspace?: WorkspaceGateway;
  readonly queryPlanner?: { planQuery(query: string): FR<Record<string, unknown>> };
  readonly jobQueue?: { stats(): FR<Record<string, unknown>> };
  readonly researchChains?: {
    startChain(topic: string): FR<number>;
    addStep(chainId: number, step: Record<string, unknown>): FR<number>;
    conclude(chainId: number, synthesis: string): FR<void>;
    recallChain(query: string): FR<Array<Record<string, unknown>>>;
  };
  readonly evidenceGraph?: {
    query(opts: Record<string, unknown>): FR<Array<Record<string, unknown>>>;
    upsert(node: Record<string, unknown>): FR<string>;
    link(fromId: string, toId: string, kind: string): FR<void>;
    prune(opts: Record<string, unknown>): FR<number>;
  };
}

// ─────────────────────────────────────────────────────────────
// State store
// ─────────────────────────────────────────────────────────────

export interface ForgeStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): boolean;
  has(key: string): boolean;
  // GPT tool compat: typed JSON getters/setters
  getJson<T>(key: string): T | undefined;
  setJson<T>(key: string, value: T): void;
}

export class InMemoryStateStore implements ForgeStateStore {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.store.get(key) as T | undefined; }
  set<T>(key: string, value: T): void { this.store.set(key, value); }
  delete(key: string): boolean { return this.store.delete(key); }
  has(key: string): boolean { return this.store.has(key); }
  getJson<T>(key: string): T | undefined { return this.store.get(key) as T | undefined; }
  setJson<T>(key: string, value: T): void { this.store.set(key, value); }
}

// ─────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────

export interface LoggerLike {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export function createConsoleLogger(prefix: string): LoggerLike {
  return {
    info: (...args) => process.stderr.write(`[${prefix}] INFO: ${args.join(" ")}\n`),
    warn: (...args) => process.stderr.write(`[${prefix}] WARN: ${args.join(" ")}\n`),
    error: (...args) => process.stderr.write(`[${prefix}] ERROR: ${args.join(" ")}\n`),
    debug: (...args) => process.stderr.write(`[${prefix}] DEBUG: ${args.join(" ")}\n`),
  };
}

// ─────────────────────────────────────────────────────────────
// Tool context (passed to every tool's execute())
// ─────────────────────────────────────────────────────────────

export interface ForgeToolContext {
  readonly services: ForgeServices;
  readonly state: ForgeStateStore;
  readonly logger: LoggerLike;
  readonly sessionId: string;
  readonly userId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  readonly abortSignal?: AbortSignal;
  readonly permissionContext?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// ForgeTool interface + buildForgeTool factory
// ─────────────────────────────────────────────────────────────

export interface ForgeTool<TInput extends object = object, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  readonly aliases?: readonly string[];
  isEnabled(ctx: ForgeToolContext): boolean | Promise<boolean>;
  isReadOnly(input?: TInput): boolean;
  isConcurrencySafe(input?: TInput): boolean;
  isDestructive?(input?: TInput): boolean;
  interruptBehavior?(): "cancel" | "block";
  checkPermissions(input: TInput, ctx: ForgeToolContext): Promise<{
    behavior: "allow" | "deny" | "ask";
    updatedInput: TInput;
    reason?: string;
  }>;
  execute(input: TInput, ctx: ForgeToolContext): Promise<import("./types.js").ForgeResult<TOutput>>;
}

export interface ForgeToolDef<TInput extends object = object, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  readonly aliases?: readonly string[];
  isEnabled?: (ctx: ForgeToolContext) => boolean | Promise<boolean>;
  isReadOnly?: (input?: TInput) => boolean;
  isConcurrencySafe?: (input?: TInput) => boolean;
  isDestructive?: (input?: TInput) => boolean;
  interruptBehavior?: () => "cancel" | "block";
  checkPermissions?: (input: TInput, ctx: ForgeToolContext) => Promise<{
    behavior: "allow" | "deny" | "ask";
    updatedInput: TInput;
    reason?: string;
  }>;
  execute: (input: TInput, ctx: ForgeToolContext) => Promise<import("./types.js").ForgeResult<TOutput>>;
}

/** Claude-Code-level tool factory. Spreads defaults, then definition. */
export function buildForgeTool<TInput extends object, TOutput>(
  def: ForgeToolDef<TInput, TOutput>,
): ForgeTool<TInput, TOutput> {
  return {
    name: def.name,
    description: def.description,
    category: def.category,
    inputSchema: def.inputSchema,
    tags: def.tags,
    aliases: def.aliases,
    isEnabled: def.isEnabled ?? (() => true),
    isReadOnly: def.isReadOnly ?? (() => false),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    isDestructive: def.isDestructive ?? (() => false),
    interruptBehavior: def.interruptBehavior,
    checkPermissions: def.checkPermissions ?? (async (input) => ({
      behavior: "allow" as const,
      updatedInput: input,
    })),
    execute: def.execute,
  };
}

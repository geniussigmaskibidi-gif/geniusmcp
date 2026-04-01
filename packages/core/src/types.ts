// These types encode architectural decisions from extensive research.
// Each interface maps to a real-world concept, not an implementation detail.

// ─────────────────────────────────────────────────────────────
// ForgeResult<T> — explicit result types, never ambient throws
// Build spec Section 2: "All service boundaries return explicit results"
// ─────────────────────────────────────────────────────────────

export type ForgeResult<T> =
  | {
      ok: true;
      value: T;
      stale?: boolean;            // data served from stale cache
      gaps?: string[];            // missing signals/data
      cursor?: string | null;     // keyset pagination cursor
      cost?: { ms?: number; githubPoints?: number; bytes?: number };
      warnings?: ForgeWarning[];
    }
  | { ok: false; error: ForgeError };

export interface ForgeWarning {
  readonly code: string;
  readonly message: string;
}

export type ForgeErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "AUTH_REQUIRED"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "CAPACITY"
  | "CORRUPT"
  | "UNSUPPORTED"
  | "POLICY_BLOCKED"
  | "TRANSIENT_UPSTREAM"
  | "PLUGIN_FAULT"
  | "STALE"
  | "INTERNAL"
  // v1.0 build spec additions:
  | "INDEX_NOT_READY"      // index behind workspace watermark
  | "PARSER_UNAVAILABLE"   // no grammar/indexer for language
  | "PARSER_TIMEOUT"       // worker deadline exceeded
  | "BLOB_MISSING"         // file missing on disk or DB
  | "BLOB_TOO_LARGE"       // exceeds size budget
  | "QUEUE_OVERFLOW"       // hook/job queue saturated
  | "LICENSE_BLOCKED"      // SPDX policy prevents import
  | "BUDGET_EXCEEDED"      // rate/compute/disk budget hit
  // Extended tool error codes:
  | "SERVICE_UNAVAILABLE"  // required service not configured
  | "INVALID_INPUT"        // input validation failed
  | "NOT_SUPPORTED"        // operation not supported by current config
  | "PERMISSION_DENIED";   // permission check denied

export type ForgeErrorScope = "user" | "workspace" | "repo" | "system" | "upstream";

export interface ForgeError {
  readonly code: ForgeErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly retryAfterMs?: number;       // v1.0: when to retry
  readonly suggestedAction?: string;    // v1.0: actionable recovery hint
  readonly scope?: ForgeErrorScope;
  readonly details?: Record<string, unknown>;
}

/** Helper to create success result. */
export function ok<T>(value: T, meta?: {
  stale?: boolean; gaps?: string[]; cursor?: string | null;
  cost?: { ms?: number; githubPoints?: number; bytes?: number };
  warnings?: ForgeWarning[];
}): ForgeResult<T> {
  return { ok: true, value, ...meta };
}

/** Helper to create error result. */
export function err<T>(
  code: ForgeErrorCode,
  message: string,
  opts?: { recoverable?: boolean; retryAfterMs?: number; suggestedAction?: string; details?: Record<string, unknown> },
): ForgeResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: opts?.recoverable ?? false,
      retryAfterMs: opts?.retryAfterMs,
      suggestedAction: opts?.suggestedAction,
      details: opts?.details,
    },
  };
}

/** Keyset-paginated page. Build spec: never return "all results". */
export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor?: string;
  readonly totalEstimate?: number;
  readonly partial?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Pattern State Machine — build spec Section 6
// candidate → active → reinforced → stale → superseded → archived → deleted
// ─────────────────────────────────────────────────────────────

// draft → active → shadowed → decaying → archived → deleted
// Each transition has guards and actions (see build spec)
export type PatternState =
  | "draft"          // just captured, dedup pending
  | "active"         // searchable, injectable
  | "shadowed"       // newer version exists in same lineage
  | "decaying"       // low confidence, reduced injection priority
  | "archived"       // body may be stubbed, metadata retained
  | "deleted";       // soft-deleted, pending GC

// ─────────────────────────────────────────────────────────────
// SymbolIR — unified normalized format from all parsers
// Build spec Section 3: "All parsers emit the same IR"
// ─────────────────────────────────────────────────────────────

export type SemanticSource = "scip" | "tree-sitter" | "regex";

export interface SymbolIR {
  readonly symbolUid: string;
  readonly scipSymbol?: string;
  readonly repoRefId?: string;
  readonly fileId?: string;
  readonly blobSha: string;
  readonly language: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly fqName?: string;
  readonly container?: string;
  readonly visibility: "public" | "protected" | "private" | "package" | "unknown";
  readonly exported: boolean;
  readonly generated: boolean;
  readonly range: { startByte: number; endByte: number; startLine: number; endLine: number };
  readonly signature?: string;
  readonly docComment?: string;
  readonly receiverType?: string;
  readonly paramsJson?: string;
  readonly returnsJson?: string;
  readonly decoratorsJson?: string;
  readonly importsJson?: string;
  readonly astFingerprint128: string;
  readonly syntaxFeaturesJson?: string;
  readonly semanticSource: SemanticSource;
  readonly confidence: number;  // 0-1
}

// ─────────────────────────────────────────────────────────────
// Blob-Centric Core: everything keyed by content hash
// ─────────────────────────────────────────────────────────────

/** Content-addressed blob. Same content in 10 forks = stored once. */
export interface Blob {
  readonly sha: string;           // SHA-256 of raw content
  readonly language: string | null;
  readonly sizeBytes: number;
}

/** Maps a repo+commit+path to a blob SHA. The join between "where" and "what". */
export interface FileRef {
  readonly repo: string;          // "owner/repo"
  readonly commitSha: string;     // pinned to exact commit, not branch
  readonly path: string;
  readonly blobSha: string;
  readonly language: string | null;
}

/**
 * Derivation record: proof that analyzer X version Y already processed blob Z.
 * If (blobSha, analyzer, version) exists → skip recompute. Immutable derivation.
 */
export interface DerivationRecord {
  readonly blobSha: string;
  readonly analyzer: AnalyzerKind;
  readonly analyzerVersion: string;
  readonly producedAt: number;     // epoch ms
}

export type AnalyzerKind = "symbols" | "structure" | "chunks" | "quality" | "fingerprint";

// ─────────────────────────────────────────────────────────────
// Symbols: extracted from AST, the unit of code intelligence
// ─────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function" | "class" | "method" | "interface"
  | "type" | "const" | "variable" | "enum";

/** A symbol extracted from code via tree-sitter / ast-grep. */
export interface SymbolRecord {
  readonly blobSha: string;
  readonly language: string;
  readonly kind: SymbolKind;
  readonly name: string;
  readonly signature: string | null;  // "(opts: Options) => Promise<Result>"
  readonly exported: boolean;
  readonly startLine: number;
  readonly endLine: number;
  readonly docComment: string | null;
  readonly astFingerprint: string | null;  // normalized AST hash for clone dedup
}

/** Dependency edge: symbol A references symbol B or external package P. */
export interface DepEdge {
  readonly sourceSymbolId: number;
  readonly targetSymbolId: number | null;  // null = external
  readonly externalPackage: string | null; // "lodash", "@octokit/rest"
  readonly edgeKind: "calls" | "imports" | "extends" | "implements" | "references";
}

// ─────────────────────────────────────────────────────────────
// Chunks: the indexable unit for lexical code search
// ─────────────────────────────────────────────────────────────

export type ChunkKind = "symbol_body" | "line_window" | "import_block" | "comment_block";

/** A chunk of code for trigram indexing. NOT a whole file. */
export interface CodeChunk {
  readonly blobSha: string;
  readonly symbolId: number | null;  // null = line-window chunk
  readonly kind: ChunkKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;             // the actual code text
}

// ─────────────────────────────────────────────────────────────
// Patterns: what the memory stores and recalls
// ─────────────────────────────────────────────────────────────

export type PatternKind =
  | "function" | "class" | "module" | "pattern"
  | "solution" | "insight" | "snippet" | "interface";

export type PatternSource =
  | "file_read" | "code_write" | "github_import"
  | "github_search" | "manual" | "hook_capture";

/** A code pattern in persistent memory. The core entity. */
export interface Pattern {
  readonly id: number;
  readonly name: string;
  readonly kind: PatternKind;
  readonly language: string | null;
  readonly code: string | null;
  readonly signature: string | null;
  readonly description: string | null;

  // Provenance
  readonly sourceType: PatternSource;
  readonly sourceRepo: string | null;
  readonly sourceRef: string | null;
  readonly sourcePath: string | null;
  readonly sourceCommitSha: string | null;
  readonly sourceLicenseSpdx: string | null;
  readonly sourceSessionId: string | null;

  // Quality (evolves over time)
  readonly qualityScore: number;       // 0-1
  readonly timesRecalled: number;
  readonly timesUsedSuccessfully: number;
  readonly confidence: number;         // 0-1, Bayesian smoothed

  // Evolution
  readonly parentId: number | null;
  readonly version: number;
  readonly astFingerprint: string | null;

  // Timestamps
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRecalledAt: string | null;
}

export type PatternLinkRelation =
  | "depends_on" | "alternative_to" | "evolved_from"
  | "inspired_by" | "used_with" | "conflicts_with";

// ─────────────────────────────────────────────────────────────
// Repo Memory: dossiers, resume cards, anchors
// ─────────────────────────────────────────────────────────────

export type HeatTier = "cold" | "warm" | "hot";

/** Repo dossier: everything we know about a repo, persisted across sessions. */
export interface RepoDossier {
  readonly id: number;
  readonly fullName: string;        // "owner/repo"
  readonly description: string | null;
  readonly stars: number;
  readonly forks: number;
  readonly language: string | null;
  readonly topics: string[];
  readonly licenseSpdx: string | null;
  readonly defaultBranch: string;
  readonly pushedAt: string | null;
  readonly archived: boolean;
  readonly heat: HeatTier;
  readonly pinned: boolean;
  readonly healthJson: string | null;
  readonly userTags: string[];
  readonly userNotes: string | null;
  readonly indexedAt: string | null;
  readonly refreshedAt: string;
  readonly etag: string | null;
}

/** Semantic anchor: a commit-pinned location in code that was viewed/focused. */
export interface Anchor {
  readonly repoId: number;
  readonly commitSha: string;
  readonly path: string;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly symbol: string | null;
  readonly snippetHash: string | null;
  readonly astFingerprint: string | null;
  readonly queryIntent: string | null;
  readonly tags: string[];
  readonly interactionScore: number;  // depth: pin(6) > focus(4) > open(2) > view(1)
  readonly viewedAt: string;
}

/** Resume card: quick-return metadata for a recently viewed repo. */
export interface ResumeCard {
  readonly repoId: number;
  readonly repoFullName: string;
  readonly refName: string | null;
  readonly lastPath: string | null;
  readonly lastSymbol: string | null;
  readonly interactionScore: number;
  readonly lastTouchedAt: string;
}

// ─────────────────────────────────────────────────────────────
// Sessions & Research Chains
// ─────────────────────────────────────────────────────────────

export interface Session {
  readonly id: string;
  readonly projectPath: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly summary: string | null;
  readonly patternsCaptured: number;
  readonly patternsRecalled: number;
}

export type ResearchChainStatus = "active" | "completed" | "abandoned";

export interface ResearchChain {
  readonly id: number;
  readonly title: string;
  readonly intent: string;
  readonly status: ResearchChainStatus;
  readonly conclusion: string | null;
  readonly modelUsed: string | null;
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ResearchStepType =
  | "web_search" | "github_search" | "code_analysis"
  | "model_query" | "file_read" | "comparison"
  | "synthesis" | "decision";

export interface ResearchStep {
  readonly id: number;
  readonly chainId: number;
  readonly stepOrder: number;
  readonly queryType: ResearchStepType;
  readonly queryText: string;
  readonly resultSummary: string;
  readonly resultFull: string | null;
  readonly sources: string | null;       // JSON: [{ url, title }]
  readonly keyInsight: string | null;
  readonly decisionMade: string | null;
  readonly createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// Import / Provenance
// ─────────────────────────────────────────────────────────────

export type ImportMode =
  | "reference_only"           // docs/comments only
  | "generate_inspired_by"    // synthesize based on pattern (default)
  | "patch_from_reference"    // apply patch from source
  | "vendor_with_attribution" // inline with credit block
  | "snippet_transplant";     // exact code + deps resolved

export interface ImportSpec {
  readonly sourceRepo: string;
  readonly sourceCommitSha: string;
  readonly sourcePath: string;
  readonly sourceSymbol: string | null;
  readonly licenseSpdx: string | null;
  readonly code: string;
  readonly dependencyClosure: Array<{ pkg: string; version: string }>;
  readonly localDepsInlined: Array<{ originalPath: string; code: string }>;
  readonly adaptations: string[];
  readonly installCommand: string;
  readonly provenanceHash: string;
  readonly attributionComment: string;
  readonly mode: ImportMode;
  readonly securityAppendix: {
    advisories: string[];
    depReviewPassed: boolean;
  };
}

export type LicenseVerdict = "allowed" | "blocked" | "review";

export interface LicensePolicy {
  readonly blocked: ReadonlySet<string>;    // e.g. {'GPL-3.0', 'AGPL-3.0'}
  readonly preferred: ReadonlySet<string>;  // e.g. {'MIT', 'Apache-2.0', 'BSD-3-Clause'}
  readonly requireAttribution: boolean;
}

// ─────────────────────────────────────────────────────────────
// Ranking: Durability × Vitality, not one fake "best"
// ─────────────────────────────────────────────────────────────

export type RankingPreset =
  | "battle_tested"       // max durability + test presence
  | "modern_active"       // max vitality + recent releases
  | "minimal_dependency"  // max importability + small slice
  | "teaching_quality";   // max relevance + docs + examples

export interface ScoreBreakdown {
  readonly relevance: number;       // BM25F + structural + semantic
  readonly durability: number;      // symbol age, low-risk churn, tests, graph authority
  readonly vitality: number;        // active maintenance, dep freshness, releases
  readonly authority: number;       // local PageRank + package dependents
  readonly importability: number;   // small dep surface, clear slice, license OK
  readonly penalties: number;       // complexity, huge fanout, advisories
}

export interface RankedCandidate {
  readonly repo: string;
  readonly commitSha: string;
  readonly path: string;
  readonly symbol: string | null;
  readonly language: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
  readonly why: string[];           // human-readable explanation of each signal
  readonly gaps: string[];          // what couldn't be verified
  readonly algorithmFamily: string | null;
  readonly snippet: string;
  readonly importPlan: {
    localSymbols: string[];
    externalPackages: string[];
    estimatedAdaptationCost: "low" | "medium" | "high";
  };
}

// ─────────────────────────────────────────────────────────────
// MCP Skill System
// ─────────────────────────────────────────────────────────────

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnlyHint?: boolean;
  readonly dangerous?: boolean;
}

export interface ResourceSpec {
  readonly uriTemplate: string;
  readonly description: string;
  readonly mimeType?: string;
}

export interface PromptSpec {
  readonly name: string;
  readonly description: string;
  readonly arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface SkillModule {
  readonly id: string;
  tools(): ToolSpec[];
  resources(): ResourceSpec[];
  prompts(): PromptSpec[];
  warmup?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Plugin API: community extensibility
// ─────────────────────────────────────────────────────────────

export interface GeniusPlugin {
  readonly name: string;
  readonly version: string;
  supports(language: string): boolean;
  derive?(blobSha: string, content: string, language: string): Promise<SymbolRecord[]>;
  contributeRankingFeatures?(candidate: RankedCandidate): Partial<ScoreBreakdown>;
  detectAlgorithmFamily?(symbols: SymbolRecord[]): string | null;
  explain?(candidate: RankedCandidate): string[];
}

// ─────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────

export type GitHubBucket = "core" | "search" | "code_search" | "graphql";

export interface BucketState {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;          // epoch ms
  readonly minuteCeiling: number;    // secondary limit: points per minute
  minuteUsed: number;
  minuteWindowStart: number;
  retryAfterUntil: number;           // epoch ms, 0 = not throttled
}

// ─────────────────────────────────────────────────────────────
// API Cache
// ─────────────────────────────────────────────────────────────

export interface CacheEntry {
  readonly key: string;               // SHA-256(authScope + endpoint + params)
  readonly authScope: string;         // "public" | "pat:user" | "app:123"
  readonly value: string;
  readonly etag: string | null;
  readonly expiresAt: number;         // epoch ms
}

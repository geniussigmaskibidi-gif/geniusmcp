// Sources: grep.app MCP (free, 1M+ repos), GitHub Code Search (200M repos),
// searchcode.com (75B lines, repo-scoped hydration)

// ─────────────────────────────────────────────────────────────
// Source Hit: raw result from an external search engine
// ─────────────────────────────────────────────────────────────

export type DataSource = "grep_app" | "github_code" | "searchcode" | "local_memory";

export interface SourceHit {
  readonly source: DataSource;
  readonly queryVariant: string;   // which compiled query produced this
  readonly repo: string;           // "owner/repo"
  readonly path: string;
  readonly snippet: string;        // matched code with context
  readonly lineStart: number | null;
  readonly url: string | null;     // direct link to code
  readonly language: string | null;
  readonly discoveredAt: string;   // ISO timestamp
}

// ─────────────────────────────────────────────────────────────
// Coverage Report: what was searched, what was missed
// ─────────────────────────────────────────────────────────────

export interface CoverageReport {
  readonly sourcesAttempted: DataSource[];
  readonly sourcesSucceeded: DataSource[];
  readonly sourcesFailed: Array<{ source: DataSource; reason: string }>;
  readonly blindSpots: BlindSpot[];       // typed enum, not free-form string
  readonly evidenceConfidence: number;    // 0-1, drops with more blind spots
  readonly totalHits: number;
  readonly uniqueRepos: number;
  readonly cachedHits: number;            // how many came from local cache
}

// ─────────────────────────────────────────────────────────────
// Hunt Request/Result: the main search interface
// ─────────────────────────────────────────────────────────────

export type RankingPreset = "battle_tested" | "modern_active" | "minimal_dependency" | "teaching_quality";

export interface HuntRequest {
  readonly query: string;
  readonly language?: string;
  readonly preset?: RankingPreset;
  readonly mode?: HuntMode;                // fast | balanced | deep (default: balanced)
  readonly maxArchetypes?: number;         // default 5
  readonly maxCandidatesPerArchetype?: number;  // default 3
  readonly skipSources?: DataSource[];
}

export interface HuntResult {
  readonly query: string;
  readonly language: string | null;
  readonly preset: RankingPreset;
  readonly archetypes: Archetype[];
  readonly totalCandidates: number;
  readonly uniqueBlobs: number;
  readonly coverage: CoverageReport;
  readonly searchDurationMs: number;
  readonly stage: "provisional" | "verified";
}

// ─────────────────────────────────────────────────────────────
// Archetype: a family of implementations with a best exemplar
// ─────────────────────────────────────────────────────────────

export type ArchetypeCategory =
  | "minimal_inline"         // <20 LOC, no deps
  | "configurable_utility"   // standalone, options object
  | "middleware_decorator"   // plugin/middleware pattern
  | "context_aware"          // cancellation, timeouts
  | "distributed_backed"     // Redis/DB/distributed coordination (RFC v2 addition)
  | "enterprise_heavy"       // full framework, many deps
  | "wrapper_adapter";       // thin wrapper around npm package

export type HuntMode = "fast" | "balanced" | "deep";

export type BlindSpot =
  | "snippet_only"
  | "default_branch_only"
  | "metadata_stale"
  | "license_unknown"
  | "dependency_closure_partial"
  | "source_timeout"
  | "source_budget_exhausted"
  | "tree_truncated"
  | "archival_status_unknown"
  | "unsupported_language_parser"
  | "hydration_incomplete";

export interface Archetype {
  readonly name: string;
  readonly description: string;
  readonly category: ArchetypeCategory;
  readonly exemplar: ScoredCandidate;
  readonly alternatives: ScoredCandidate[];
  readonly tradeoffs: string[];
  readonly clusterSize: number;           // how many implementations follow this pattern
}

// ─────────────────────────────────────────────────────────────
// Scored Candidate: a symbol slice with quality breakdown
// ─────────────────────────────────────────────────────────────

export interface ScoredCandidate {
  readonly repo: string;
  readonly path: string;
  readonly symbolName: string;
  readonly language: string;
  readonly snippet: string;               // extracted code
  readonly score: number;                 // composite 0-1
  readonly breakdown: ScoreBreakdown;
  readonly why: string[];                 // human-readable explanations
  readonly gaps: string[];                // what couldn't be measured
}

export interface ScoreBreakdown {
  readonly queryFit: number;              // 0-1: how well does this match the query?
  readonly durability: number;            // 0-1: will it survive?
  readonly vitality: number;              // 0-1: is it alive?
  readonly importability: number;         // 0-1: can I use it?
  readonly codeQuality: number;           // 0-1: is the code good?
  readonly evidenceConfidence: number;    // 0-1: how much do we trust these scores?
}

// ─────────────────────────────────────────────────────────────
// Budget: per-source rate tracking
// ─────────────────────────────────────────────────────────────

export interface BudgetSnapshot {
  readonly source: DataSource;
  readonly available: number;
  readonly waitTimeMs: number;
  readonly totalUsed: number;
  readonly totalErrors: number;
}

// ─────────────────────────────────────────────────────────────
// Compiled Query: source-specific query dialect
// ─────────────────────────────────────────────────────────────

export interface CompiledQuery {
  readonly source: DataSource;
  readonly queryText: string;
  readonly parameters: Record<string, unknown>;
  readonly estimatedCost: number;          // 1 = one API call worth
  readonly purpose: string;                // "discovery" | "symbol" | "synonym"
}

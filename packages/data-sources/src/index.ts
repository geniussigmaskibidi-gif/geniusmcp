export { createGrepAppClient } from "./grep-app-client.js";
export type { GrepAppClient } from "./grep-app-client.js";
export { createSearchCodeClient } from "./searchcode-client.js";
export type { SearchCodeClient, SearchCodeResult, SearchCodeMatch, RepoAnalysis, Finding } from "./searchcode-client.js";
export { createSourceOrchestrator } from "./source-orchestrator.js";
export type { SourceOrchestrator } from "./source-orchestrator.js";
export { compileHuntQueries } from "./query-compiler.js";
export type {
  SourceHit, DataSource, CompiledQuery, CoverageReport,
  HuntRequest, HuntResult, Archetype, ArchetypeCategory,
  ScoredCandidate, ScoreBreakdown, BudgetSnapshot, RankingPreset,
} from "./types.js";

export { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
export type { CircuitBreakerConfig, CircuitState } from "./circuit-breaker.js";
export { Bulkhead, BulkheadFullError } from "./bulkhead.js";
export type { BulkheadConfig } from "./bulkhead.js";
export { resilientSearch, decorrelatedJitter } from "./resilient-search.js";
export type { ResilientSearchResult, ResilientSearchSource, SearchConfidence, SourceStatus } from "./resilient-search.js";

export { SourceSelector } from "./source-selector.js";
export type { SourceSelectorConfig } from "./source-selector.js";

export { compileHuntQueries as compileDiscoveryQueries } from "./query-compiler.js";
export type { HuntRequest as DiscoveryQueryInput } from "./types.js";
export type QueryMode = "archetype" | "snippet" | "function" | "class" | "test" | "config";

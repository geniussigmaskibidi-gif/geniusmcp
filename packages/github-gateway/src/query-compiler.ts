// Research: GitHub search limits (256 chars, 5 boolean ops, 100 results, not exhaustive).
// Solution: expand concept into multiple narrow queries, shard by elite repos.
//
// This is the non-obvious critical component. Without it, genius.find_best
// returns noisy results because one broad query hits GitHub's caps.
// With it, we do "precision strikes on best repos" (Pro research term).

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface CompiledQueries {
  /** Repo discovery queries (find strong repos first). */
  readonly repoQueries: string[];
  /** Code search queries (find actual code in discovered repos). */
  readonly codeQueries: string[];
  /** Symbol-specific queries (function/class definitions). */
  readonly symbolQueries: string[];
  /** Explanation of what was compiled. */
  readonly explanation: string;
}

export interface CompileOptions {
  readonly concept: string;
  readonly language?: string;
  readonly minStars?: number;
  readonly frameworks?: string[];
  readonly excludeForks?: boolean;
  readonly excludeArchived?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Synonym expansion — maps common concepts to search variants
// ─────────────────────────────────────────────────────────────

const CONCEPT_SYNONYMS: Record<string, string[]> = {
  "rate limiter": ["rate limit", "throttle", "token bucket", "sliding window", "leaky bucket"],
  "retry": ["retry", "backoff", "exponential backoff", "retry with jitter"],
  "cache": ["cache", "memoize", "LRU", "TTL cache"],
  "auth": ["authentication", "JWT", "OAuth", "session", "token verification"],
  "middleware": ["middleware", "interceptor", "handler chain", "request pipeline"],
  "logger": ["logger", "logging", "structured log", "log formatter"],
  "queue": ["queue", "job queue", "task queue", "worker", "message queue"],
  "database": ["database", "ORM", "query builder", "connection pool", "migration"],
  "validator": ["validator", "validation", "schema validation", "input validation"],
  "parser": ["parser", "tokenizer", "lexer", "AST parser"],
  "error handling": ["error handler", "error boundary", "exception", "try catch wrapper"],
  "pagination": ["pagination", "cursor", "offset", "infinite scroll", "paginate"],
  "debounce": ["debounce", "throttle", "rate limit client"],
  "state machine": ["state machine", "FSM", "finite state", "statechart"],
  "dependency injection": ["dependency injection", "DI container", "IoC", "service locator"],
  "event emitter": ["event emitter", "pub sub", "observer", "event bus"],
  "circuit breaker": ["circuit breaker", "fallback", "resilience", "bulkhead"],
};

function expandConcept(concept: string): string[] {
  const lower = concept.toLowerCase();

  // Check for direct synonym match
  for (const [key, synonyms] of Object.entries(CONCEPT_SYNONYMS)) {
    if (lower.includes(key) || synonyms.some((s) => lower.includes(s))) {
      return [concept, ...synonyms.filter((s) => s !== concept)];
    }
  }

  // No synonyms found — split into words and create variations
  const words = concept.split(/\s+/).filter((w) => w.length > 2);
  if (words.length <= 1) return [concept];

  // Generate: "exact phrase", individual words, camelCase version
  const camel = words.map((w, i) =>
    i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  ).join("");

  return [concept, camel, ...words];
}

// ─────────────────────────────────────────────────────────────
// Query sharding — pack repo:owner/name into batches under char limit
// ─────────────────────────────────────────────────────────────

/**
 * Pack repo names into batched "repo:a OR repo:b OR repo:c" queries
 * that stay under GitHub's ~256 char query limit.
 */
export function packRepoBatches(
  repos: string[],
  baseQuery: string,
  maxChars: number = 230, // leave margin below 256
): string[] {
  if (repos.length === 0) return [baseQuery];

  const batches: string[] = [];
  let currentRepos: string[] = [];

  for (const repo of repos) {
    const repoClause = `repo:${repo}`;
    const tentative = [
      baseQuery,
      currentRepos.length > 0
        ? `(${[...currentRepos, repoClause].map((r) => r).join(" OR ")})`
        : repoClause,
    ].join(" ");

    if (tentative.length > maxChars && currentRepos.length > 0) {
      // Flush current batch
      batches.push(
        `${baseQuery} (${currentRepos.join(" OR ")})`,
      );
      currentRepos = [repoClause];
    } else {
      currentRepos.push(repoClause);
    }
  }

  // Flush remaining
  if (currentRepos.length > 0) {
    batches.push(`${baseQuery} (${currentRepos.join(" OR ")})`);
  }

  return batches;
}

// ─────────────────────────────────────────────────────────────
// Main compiler
// ─────────────────────────────────────────────────────────────

export function compileSearchQueries(opts: CompileOptions): CompiledQueries {
  const { concept, language, minStars = 50, excludeForks = true, excludeArchived = true } = opts;

  const expansions = expandConcept(concept);
  const langQ = language ? ` language:${language}` : "";
  const starsQ = minStars > 0 ? ` stars:>${minStars}` : "";

  // ── Repo discovery queries (find strong repos) ──
  const repoQueries: string[] = [];

  // Primary: exact concept
  repoQueries.push(`${concept}${langQ}${starsQ}`);

  // Secondary: star-bucketed for broader coverage
  if (minStars < 1000) {
    repoQueries.push(`${concept}${langQ} stars:>1000`);
  }
  if (minStars < 5000) {
    repoQueries.push(`${concept}${langQ} stars:>5000`);
  }

  // ── Code search queries (find actual implementations) ──
  const codeQueries: string[] = [];

  // Primary: exact concept phrase
  codeQueries.push(`"${concept}"${langQ}`);

  // Synonym expansions (top 3)
  for (const syn of expansions.slice(1, 4)) {
    codeQueries.push(`"${syn}"${langQ}`);
  }

  // Framework-scoped if provided
  if (opts.frameworks?.length) {
    for (const fw of opts.frameworks) {
      codeQueries.push(`${concept} ${fw}${langQ}`);
    }
  }

  // ── Symbol queries (find definitions) ──
  const symbolQueries: string[] = [];

  // Convert concept to likely symbol names
  const words = concept.split(/\s+/);
  if (words.length >= 2) {
    // camelCase: "rate limiter" → "rateLimiter"
    const camel = words.map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    ).join("");
    symbolQueries.push(`${camel}${langQ}`);

    // PascalCase: "rate limiter" → "RateLimiter"
    const pascal = words.map((w) =>
      w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    ).join("");
    symbolQueries.push(`${pascal}${langQ}`);

    // snake_case: "rate limiter" → "rate_limiter"
    const snake = words.map((w) => w.toLowerCase()).join("_");
    symbolQueries.push(`${snake}${langQ}`);
  }

  const explanation = [
    `Expanded "${concept}" into ${expansions.length} variants`,
    `Generated ${repoQueries.length} repo queries, ${codeQueries.length} code queries, ${symbolQueries.length} symbol queries`,
    language ? `Filtered to ${language}` : "No language filter",
    `Min stars: ${minStars}`,
  ].join(". ");

  return { repoQueries, codeQueries, symbolQueries, explanation };
}

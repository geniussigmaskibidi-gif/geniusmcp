
import type { CompiledQuery, DataSource, HuntRequest } from "./types.js";

const SYNONYMS: Record<string, string[]> = {
  "rate limiter": ["rate limit", "throttle", "token bucket", "sliding window", "leaky bucket"],
  "retry": ["retry", "backoff", "exponential backoff", "retry with jitter"],
  "cache": ["cache", "memoize", "LRU", "TTL cache"],
  "auth": ["authentication", "JWT", "OAuth", "session", "token verification"],
  "middleware": ["middleware", "interceptor", "handler chain", "request pipeline"],
  "logger": ["logger", "logging", "structured log"],
  "queue": ["queue", "job queue", "task queue", "worker", "message queue"],
  "database": ["database", "ORM", "query builder", "connection pool"],
  "validator": ["validator", "validation", "schema validation"],
  "parser": ["parser", "tokenizer", "lexer"],
  "error handling": ["error handler", "error boundary", "try catch wrapper"],
  "pagination": ["pagination", "cursor", "offset", "paginate"],
  "debounce": ["debounce", "throttle", "rate limit client"],
  "state machine": ["state machine", "FSM", "finite state"],
  "circuit breaker": ["circuit breaker", "fallback", "resilience", "bulkhead"],
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "using",
  "with",
]);

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniquePreserve(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const normalized = normalizeSpaces(item);
    if (!normalized) continue;

    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(normalized);
  }

  return out;
}

function expandConcept(concept: string): string[] {
  const lower = concept.toLowerCase();

  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    if (lower.includes(key) || synonyms.some((synonym) => lower.includes(synonym.toLowerCase()))) {
      return uniquePreserve([concept, ...synonyms]);
    }
  }

  return [normalizeSpaces(concept)];
}

function toNamingVariants(concept: string): string[] {
  const words = concept
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);

  if (words.length <= 1) return [];

  const camel = words
    .map((word, index) =>
      index === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");

  const pascal = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");

  const snake = words.map((word) => word.toLowerCase()).join("_");

  return uniquePreserve([camel, pascal, snake]);
}

function tokenizeForGitHub(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/["'`]+/g, " ")
    .replace(/[^a-z0-9_+\-\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function buildGitHubKeywordQuery(value: string): string {
  const tokens = tokenizeForGitHub(value).filter((token) => !STOP_WORDS.has(token));
  return uniquePreserve(tokens).join(" ");
}

function withLanguageQualifier(queryText: string, language?: string): string {
  const normalized = normalizeSpaces(queryText);
  if (!normalized) return "";
  return language ? `${normalized} language:${language}` : normalized;
}

function compileForGrepApp(req: HuntRequest): CompiledQuery[] {
  const queries: CompiledQuery[] = [];
  const expansions = expandConcept(req.query);

  const langParams = req.language ? { langFilter: req.language } : {};

  // "websocket server heartbeat reconnect" → ["websocket heartbeat", "websocket reconnect"]
  const words = normalizeSpaces(req.query)
    .split(/\s+/)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()) && w.length > 1);

  if (words.length <= 3) {
    // Short query: send as-is
    queries.push({
      source: "grep_app",
      queryText: normalizeSpaces(req.query),
      parameters: langParams,
      estimatedCost: 1,
      purpose: "discovery",
    });
  } else {
    const anchor = words[0]!;
    const pairs = words.slice(1, 4).map((w) => `${anchor} ${w}`);
    for (const pair of pairs) {
      queries.push({
        source: "grep_app",
        queryText: pair,
        parameters: langParams,
        estimatedCost: 1,
        purpose: "discovery",
      });
    }
  }

  // Synonym expansion (max 2)
  for (const synonym of expansions.slice(1, 3)) {
    queries.push({
      source: "grep_app",
      queryText: synonym,
      parameters: langParams,
      estimatedCost: 1,
      purpose: "synonym",
    });
  }

  // Naming variants (camelCase, PascalCase, snake_case)
  for (const variant of toNamingVariants(req.query).slice(0, 2)) {
    queries.push({
      source: "grep_app",
      queryText: variant,
      parameters: { ...langParams, wholeWords: true },
      estimatedCost: 1,
      purpose: "symbol",
    });
  }

  return queries;
}

function compileForGitHub(req: HuntRequest): CompiledQuery[] {
  const queries: CompiledQuery[] = [];
  const seen = new Set<string>();

  const pushQuery = (queryText: string, limit: number, purpose: string): void => {
    const normalized = withLanguageQualifier(queryText, req.language);
    if (!normalized) return;

    const key = normalized.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    queries.push({
      source: "github_code",
      queryText: normalized,
      parameters: { limit },
      estimatedCost: 1,
      purpose,
    });
  };

  const baseKeywords = buildGitHubKeywordQuery(req.query) || normalizeSpaces(req.query);
  const baseTokens = baseKeywords.split(/\s+/).filter((token) => token.length > 0);
  const expansions = expandConcept(req.query);
  const namingVariants = toNamingVariants(req.query);

  pushQuery(baseKeywords, 20, "discovery");

  const anchor = baseTokens[0] ?? "";
  const specificExpansion = expansions
    .slice(1)
    .map((expansion) => buildGitHubKeywordQuery(expansion))
    .find((expansion) => {
      const tokens = expansion.split(/\s+/).filter((token) => token.length > 0);
      return tokens.length > 1 && expansion.toLowerCase() !== baseKeywords.toLowerCase();
    });

  if (specificExpansion) {
    const focusedTerms = uniquePreserve([...specificExpansion.split(/\s+/), anchor]).join(" ");
    pushQuery(focusedTerms, 15, "synonym");
  } else {
    const alternateExpansion = expansions
      .slice(1)
      .map((expansion) => buildGitHubKeywordQuery(expansion))
      .find((expansion) => expansion && expansion.toLowerCase() !== baseKeywords.toLowerCase());

    if (alternateExpansion) {
      const focusedTerms = uniquePreserve([
        ...baseTokens.slice(0, 2),
        ...alternateExpansion.split(/\s+/),
      ]).join(" ");
      pushQuery(focusedTerms, 15, "synonym");
    }
  }

  const symbolVariant = namingVariants.find((variant) => {
    const lowered = variant.toLowerCase();
    return lowered.length > 0 && !baseTokens.some((token) => token.toLowerCase() === lowered);
  });

  if (symbolVariant) {
    pushQuery(symbolVariant, 10, "symbol");
  }

  return queries.slice(0, 3);
}

function compileForSearchcode(req: HuntRequest): CompiledQuery[] {
  return [
    {
      source: "searchcode",
      queryText: normalizeSpaces(req.query),
      parameters: {
        ...(req.language ? { language: req.language } : {}),
      },
      estimatedCost: 1,
      purpose: "discovery",
    },
  ];
}

export function compileHuntQueries(
  req: HuntRequest,
  availableSources: DataSource[] = ["grep_app", "github_code", "searchcode"],
): CompiledQuery[] {
  const queries: CompiledQuery[] = [];
  const skip = new Set(req.skipSources ?? []);

  if (availableSources.includes("grep_app") && !skip.has("grep_app")) {
    queries.push(...compileForGrepApp(req));
  }

  if (availableSources.includes("github_code") && !skip.has("github_code")) {
    queries.push(...compileForGitHub(req));
  }

  if (availableSources.includes("searchcode") && !skip.has("searchcode")) {
    queries.push(...compileForSearchcode(req));
  }

  return queries;
}


// Research: Sourcegraph query planning, Zoekt query dispatch, GitHub Blackbird query routing.
// Design: Classify query → select lanes → set weights for RRF fusion.
// Lanes: short_identifier, trigram_substring, metadata_bm25, regex_prefilter, path_lookup.

// ─────────────────────────────────────────────────────────────
// Query classification
// ─────────────────────────────────────────────────────────────

export type QueryClass =
  | "exact_symbol"       // known symbol: "useState", "createHash"
  | "short_token"        // <3 chars: "id", "fn", "db", "io"
  | "phrase"             // multi-word: "rate limiter", "retry backoff"
  | "substring"          // camelCase partial: "retryWith", "handleAuth"
  | "regex_like"         // pattern chars: "retry.*backoff"
  | "path"               // file path: "src/utils/", "*.test.ts"
  | "mixed";             // fallback

// ─────────────────────────────────────────────────────────────
// Lane plan: what to search and how to weight it
// ─────────────────────────────────────────────────────────────

export type SearchLane =
  | "short_identifier"   // exact B-tree lookup for <3 char tokens
  | "trigram"            // FTS5 trigram for substring/code search
  | "bm25"              // FTS5 porter/unicode for word-based search
  | "regex_verify"       // trigram prefilter → JS regex verify
  | "path";              // file path prefix lookup

export interface LanePlan {
  readonly lane: SearchLane;
  readonly query: string;
  readonly weight: number;    // for RRF fusion (higher = more influence)
  readonly limit: number;     // max results from this lane
}

export interface QueryPlan {
  readonly originalQuery: string;
  readonly queryClass: QueryClass;
  readonly lanes: readonly LanePlan[];
  readonly estimatedCostMs: number;
}

// ─────────────────────────────────────────────────────────────
// Classification heuristics
// ─────────────────────────────────────────────────────────────

/**
 * Classify a search query to determine the best search strategy.
 *
 * Rules (applied in order):
 *   1. Length ≤ 2 → short_token (trigram FTS can't match)
 *   2. Contains path separators or glob → path
 *   3. Contains regex metacharacters → regex_like
 *   4. Single identifier (no spaces) → exact_symbol or substring
 *   5. Multiple words → phrase
 *   6. Fallback → mixed
 */
export function classifyQuery(query: string): QueryClass {
  const q = query.trim();

  if (q.length <= 2 && /^[a-zA-Z_]\w*$/.test(q)) return "short_token";

  if (q.includes("/") || q.includes("\\") || /\*\.\w+/.test(q) || /\.\w+$/.test(q) && q.includes(".")) return "path";

  if (/[.*+?\[\]{}()\\|^$]/.test(q) && q.length > 2) return "regex_like";

  if (!/\s/.test(q)) {
    // CamelCase/snake_case substring (e.g., "retryWith", "handle_auth")
    if (q.length > 3 && (/[A-Z]/.test(q.slice(1)) || q.includes("_"))) return "substring";
    return "exact_symbol";
  }

  if (/\s/.test(q)) return "phrase";

  return "mixed";
}

// ─────────────────────────────────────────────────────────────
// Plan generation
// ─────────────────────────────────────────────────────────────

/**
 * Generate a query execution plan.
 *
 * Each query class maps to 1-3 search lanes with different weights.
 * The caller fuses results via RRF (Reciprocal Rank Fusion).
 */
export function planQuery(query: string): QueryPlan {
  const q = query.trim();
  const qclass = classifyQuery(q);
  const lanes: LanePlan[] = [];
  let estimatedCostMs = 0;

  switch (qclass) {
    case "short_token":
      lanes.push({ lane: "short_identifier", query: q, weight: 1.0, limit: 50 });
      lanes.push({ lane: "bm25", query: q, weight: 0.3, limit: 20 });
      estimatedCostMs = 5;
      break;

    case "exact_symbol":
      lanes.push({ lane: "bm25", query: q, weight: 1.0, limit: 50 });
      lanes.push({ lane: "trigram", query: q, weight: 0.7, limit: 30 });
      estimatedCostMs = 10;
      break;

    case "phrase":
      lanes.push({ lane: "bm25", query: q, weight: 1.0, limit: 60 });
      lanes.push({ lane: "trigram", query: q, weight: 0.8, limit: 60 });
      estimatedCostMs = 20;
      break;

    case "substring":
      lanes.push({ lane: "trigram", query: q, weight: 1.0, limit: 60 });
      lanes.push({ lane: "bm25", query: q, weight: 0.5, limit: 30 });
      estimatedCostMs = 15;
      break;

    case "regex_like": {
      const literals = extractLiterals(q);
      if (literals.length > 0) {
        lanes.push({ lane: "trigram", query: literals.join(" "), weight: 0.8, limit: 200 });
      }
      lanes.push({ lane: "regex_verify", query: q, weight: 1.0, limit: 50 });
      estimatedCostMs = 50;
      break;
    }

    case "path":
      lanes.push({ lane: "path", query: q, weight: 1.0, limit: 50 });
      estimatedCostMs = 3;
      break;

    default:
      lanes.push({ lane: "bm25", query: q, weight: 1.0, limit: 60 });
      lanes.push({ lane: "trigram", query: q, weight: 0.8, limit: 60 });
      estimatedCostMs = 20;
  }

  return { originalQuery: q, queryClass: qclass, lanes, estimatedCostMs };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Extract literal substrings (≥3 chars) from a regex-like query.
 * Used for trigram prefiltering before JS regex verification.
 */
export function extractLiterals(regex: string): string[] {
  return regex
    .replace(/[.*+?\[\]{}()\\|^$]/g, " ")
    .split(/\s+/)
    .filter(s => s.length >= 3);
}

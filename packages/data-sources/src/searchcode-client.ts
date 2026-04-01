// Endpoint: https://api.searchcode.com/api/v1/ (REST, POST, JSON)
// Role: HYDRATION layer, not primary discovery. Use AFTER finding repos via grep.app/GitHub.
// Tools: code_search, code_analyze, code_get_file, code_get_files, code_file_tree, code_get_findings
// Key constraint: ALL endpoints require `repository` (a git URL). This is repo-scoped, not cross-repo.

import type { SourceHit, CompiledQuery } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Client interface
// ─────────────────────────────────────────────────────────────

export interface SearchCodeClient {
  /** Search code within discovered repos. Requires repo URLs from prior discovery. */
  search(queries: CompiledQuery[]): Promise<SourceHit[]>;
  /** Search code within a specific repo. */
  searchInRepo(repoUrl: string, query: string, language?: string): Promise<SearchCodeResult[]>;
  /** Analyze a repo: language breakdown, complexity, tech stack. */
  analyzeRepo(repoUrl: string): Promise<RepoAnalysis | null>;
  /** Get a specific file from a repo. */
  getFile(repoUrl: string, path: string, opts?: { symbol?: string; lines?: string }): Promise<string | null>;
  /** Batch get files (up to 10, 5000 lines total). */
  getFiles(requests: Array<{ repoUrl: string; path: string }>): Promise<Map<string, string>>;
  /** Get code quality findings (security, performance). */
  getFindings(repoUrl: string, opts?: { severity?: "error" | "warning" | "info" }): Promise<Finding[]>;
  /** Ping. */
  ping(): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────
// Response types (matching actual searchcode API)
// ─────────────────────────────────────────────────────────────

export interface SearchCodeResult {
  readonly file: string;
  readonly language: string;
  readonly matchesInFile: number;
  readonly matches: SearchCodeMatch[];
}

export interface SearchCodeMatch {
  readonly line: number;
  readonly content: string;
  readonly contextBefore: string[];
  readonly contextAfter: string[];
}

export interface RepoAnalysis {
  readonly languages: Record<string, number>;
  readonly complexity: number;
  readonly fileCount: number;
  readonly techStack: string[];
  readonly hasTests: boolean;
}

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SEARCHCODE_API = "https://api.searchcode.com/api/v1";
const TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────

export function createSearchCodeClient(clientId: string = "forgemcp"): SearchCodeClient {

  /**
   * Call searchcode REST API endpoint.
   * All endpoints are POST with JSON body and ?client= query param.
   */
  async function callApi(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const url = `${SEARCHCODE_API}/${endpoint}?client=${encodeURIComponent(clientId)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 429) {
          process.stderr.write("searchcode rate limited\n");
        }
        return null;
      }

      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Parse searchcode code_search response into our standard format.
   *
   * Actual response shape:
   * {
   *   results: [{
   *     file: "src/retry.ts",
   *     language: "TypeScript",
   *     matches_in_file: 5,
   *     matches: [{ line: 80, content: "...", context_before: [...], context_after: [...] }]
   *   }]
   * }
   */
  function parseSearchResults(raw: unknown): SearchCodeResult[] {
    const data = raw as {
      results?: Array<{
        file?: string;
        language?: string;
        matches_in_file?: number;
        matches_shown?: number;
        matches?: Array<{
          line?: number;
          content?: string;
          context_before?: string[];
          context_after?: string[];
        }>;
      }>;
    } | null;

    if (!data?.results) return [];

    return data.results
      .filter((r): r is typeof r & { file: string } => !!r.file)
      .map(r => ({
        file: r.file!,
        language: r.language ?? "",
        matchesInFile: r.matches_in_file ?? 0,
        matches: (r.matches ?? []).map(m => ({
          line: m.line ?? 0,
          content: m.content ?? "",
          contextBefore: m.context_before ?? [],
          contextAfter: m.context_after ?? [],
        })),
      }));
  }

  return {
    async search(queries) {
      const hits: SourceHit[] = [];

      for (const q of queries) {
        if (q.source !== "searchcode") continue;

        // If the query has a repo parameter, use it for repo-scoped search.
        // Otherwise, searchcode cannot do cross-repo discovery — skip gracefully.
        const repoUrl = q.parameters["repoUrl"] as string | undefined;
        if (!repoUrl) {
          continue;
        }

        const result = await callApi("code_search", {
          repository: repoUrl,
          query: q.queryText,
        });

        const parsed = parseSearchResults(result);

        // Extract repo name from URL: https://github.com/owner/repo → owner/repo
        const repoName = repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");

        for (const fileResult of parsed) {
          // Build snippet from matched lines with context
          const snippet = fileResult.matches
            .slice(0, 5) // max 5 matches per file
            .map(m => [
              ...m.contextBefore.slice(-2),
              m.content,
              ...m.contextAfter.slice(0, 2),
            ].join("\n"))
            .join("\n---\n");

          const firstLine = fileResult.matches[0]?.line ?? null;

          hits.push({
            source: "searchcode",
            queryVariant: q.queryText,
            repo: repoName,
            path: fileResult.file,
            snippet,
            lineStart: firstLine,
            url: `https://github.com/${repoName}/blob/HEAD/${fileResult.file}`,
            language: fileResult.language || null,
            discoveredAt: new Date().toISOString(),
          });
        }
      }

      return hits;
    },

    async searchInRepo(repoUrl, query, language) {
      const result = await callApi("code_search", {
        repository: repoUrl,
        query,
        ...(language ? { language } : {}),
      });
      return parseSearchResults(result);
    },

    async analyzeRepo(repoUrl) {
      const result = await callApi("code_analyze", { repository: repoUrl }) as {
        languages?: Record<string, number>;
        complexity?: number;
        file_count?: number;
        tech_stack?: string[];
        has_tests?: boolean;
      } | null;

      if (!result) return null;
      return {
        languages: result.languages ?? {},
        complexity: result.complexity ?? 0,
        fileCount: result.file_count ?? 0,
        techStack: result.tech_stack ?? [],
        hasTests: result.has_tests ?? false,
      };
    },

    async getFile(repoUrl, path, opts) {
      const result = await callApi("code_get_file", {
        repository: repoUrl,
        path,
        ...(opts?.symbol ? { symbol_name: opts.symbol } : {}),
        ...(opts?.lines ? { lines: opts.lines } : {}),
      }) as { content?: string } | null;

      return result?.content ?? null;
    },

    async getFiles(requests) {
      const results = new Map<string, string>();

      for (let i = 0; i < requests.length; i += 10) {
        const batch = requests.slice(i, i + 10);
        const result = await callApi("code_get_files", {
          files: batch.map(r => ({ repository: r.repoUrl, path: r.path })),
        }) as { files?: Array<{ path: string; content: string }> } | null;

        if (result?.files) {
          for (const f of result.files) {
            results.set(f.path, f.content);
          }
        }
      }

      return results;
    },

    async getFindings(repoUrl, opts) {
      const result = await callApi("code_get_findings", {
        repository: repoUrl,
        ...(opts?.severity ? { severity: opts.severity } : {}),
      }) as { findings?: Finding[] } | null;

      return result?.findings ?? [];
    },

    async ping() {
      try {
        const r = await fetch(
          `${SEARCHCODE_API}/code_search?client=${clientId}`,
          { method: "OPTIONS", signal: AbortSignal.timeout(3000) }
        );
        return r.ok || r.status === 405;
      } catch {
        return false;
      }
    },
  };
}

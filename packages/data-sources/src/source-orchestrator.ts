
import type { SourceHit, DataSource, CompiledQuery, CoverageReport, BlindSpot } from "./types.js";
import type { GrepAppClient } from "./grep-app-client.js";
import type { SearchCodeClient } from "./searchcode-client.js";
import type { GitHubGateway } from "@forgemcp/github-gateway";

export interface SourceOrchestrator {
  scatter(queries: CompiledQuery[], opts?: { timeoutMs?: number }): Promise<{
    hits: SourceHit[];
    coverage: CoverageReport;
  }>;
}

type DiscoveryResult = {
  source: DataSource;
  hits: SourceHit[];
  timedOut?: boolean;
};

type GitHubQueryOutcome = {
  status: "ok" | "timeout" | "error";
  hits: SourceHit[];
};

export function createSourceOrchestrator(
  grepApp: GrepAppClient,
  searchCode: SearchCodeClient,
  github: GitHubGateway,
): SourceOrchestrator {
  return {
    async scatter(queries, opts = {}) {
      const timeout = opts.timeoutMs ?? 5000;
      const attempted: DataSource[] = [];
      const succeeded = new Set<DataSource>();
      const failed: Array<{ source: DataSource; reason: string }> = [];
      const timedOutSources = new Set<DataSource>();
      const allHits: SourceHit[] = [];

      const bySource = new Map<DataSource, CompiledQuery[]>();
      for (const query of queries) {
        const existing = bySource.get(query.source) ?? [];
        existing.push(query);
        bySource.set(query.source, existing);
      }

      const discoveryPromises: Array<Promise<DiscoveryResult>> = [];

      if (bySource.has("grep_app")) {
        attempted.push("grep_app");
        discoveryPromises.push(
          withTimeout(
            grepApp.search(bySource.get("grep_app")!)
              .then((hits): DiscoveryResult => ({ source: "grep_app", hits, timedOut: false }))
              .catch((error: unknown) => {
                logError("grep_app search failed", error);
                failed.push({ source: "grep_app", reason: formatError(error) });
                return { source: "grep_app" as DataSource, hits: [], timedOut: false } satisfies DiscoveryResult;
              }),
            timeout,
            { source: "grep_app" as DataSource, hits: [], timedOut: true },
          ),
        );
      }

      if (bySource.has("github_code")) {
        attempted.push("github_code");
        discoveryPromises.push(
          withTimeout(
            searchGitHub(github, bySource.get("github_code")!)
              .then((hits): DiscoveryResult => ({ source: "github_code", hits, timedOut: false }))
              .catch((error: unknown) => {
                logError("github_code search failed", error);
                failed.push({ source: "github_code", reason: formatError(error) });
                return { source: "github_code" as DataSource, hits: [], timedOut: false } satisfies DiscoveryResult;
              }),
            timeout,
            { source: "github_code" as DataSource, hits: [], timedOut: true },
          ),
        );
      }

      const discoveryResults = await Promise.allSettled(discoveryPromises);

      for (const result of discoveryResults) {
        if (result.status === "rejected") {
          logError("discovery promise rejected", result.reason);
          continue;
        }

        const { source, hits, timedOut } = result.value;
        if (timedOut) {
          timedOutSources.add(source);
        }

        if (hits.length > 0) {
          succeeded.add(source);
          allHits.push(...hits);
        } else if (!failed.some((entry) => entry.source === source)) {
          failed.push({ source, reason: timedOut ? "timeout" : "no results" });
        }
      }

      if (bySource.has("searchcode") && allHits.length > 0) {
        attempted.push("searchcode");
        const uniqueRepos = [...new Set(allHits.map((hit) => hit.repo))].slice(0, 3);
        const queryText = bySource.get("searchcode")?.[0]?.queryText ?? "";
        const language = typeof bySource.get("searchcode")?.[0]?.parameters["language"] === "string"
          ? String(bySource.get("searchcode")?.[0]?.parameters["language"])
          : undefined;

        if (queryText) {
          try {
            const hydrationPromises = uniqueRepos.map((repo) =>
              withTimeout(
                searchCode.searchInRepo(`https://github.com/${repo}`, queryText, language)
                  .then((results) => {
                    const hits: SourceHit[] = [];

                    for (const result of results) {
                      const snippet = result.matches
                        .slice(0, 3)
                        .map((match) =>
                          [...match.contextBefore.slice(-1), match.content, ...match.contextAfter.slice(0, 1)].join("\n"),
                        )
                        .join("\n---\n");

                      hits.push({
                        source: "searchcode",
                        queryVariant: queryText,
                        repo,
                        path: result.file,
                        snippet,
                        lineStart: result.matches[0]?.line ?? null,
                        url: `https://github.com/${repo}/blob/HEAD/${result.file}`,
                        language: result.language || null,
                        discoveredAt: new Date().toISOString(),
                      });
                    }

                    return { source: "searchcode" as DataSource, hits, timedOut: false } as DiscoveryResult;
                  })
                  .catch((error: unknown) => {
                    logError(`searchcode hydration failed for ${repo}`, error);
                    return { source: "searchcode" as DataSource, hits: [], timedOut: false } as DiscoveryResult;
                  }),
                Math.min(timeout, 5000),
                { source: "searchcode" as DataSource, hits: [], timedOut: true } as DiscoveryResult,
              ),
            );

            const hydrationResults = await Promise.allSettled(hydrationPromises);
            let hydratedCount = 0;

            for (const result of hydrationResults) {
              if (result.status === "rejected") {
                logError("searchcode hydration promise rejected", result.reason);
                continue;
              }

              if (result.value.timedOut) {
                timedOutSources.add("searchcode");
              }

              if (result.value.hits.length > 0) {
                allHits.push(...result.value.hits);
                hydratedCount += result.value.hits.length;
              }
            }

            if (hydratedCount > 0) {
              succeeded.add("searchcode");
            } else if (!failed.some((entry) => entry.source === "searchcode")) {
              failed.push({
                source: "searchcode",
                reason: timedOutSources.has("searchcode") ? "timeout" : "no hydration results",
              });
            }
          } catch (error: unknown) {
            logError("searchcode hydration error", error);
            if (!failed.some((entry) => entry.source === "searchcode")) {
              failed.push({ source: "searchcode", reason: formatError(error) });
            }
          }
        }
      }

      const seen = new Set<string>();
      const deduped = allHits.filter((hit) => {
        const key = `${hit.repo}:${hit.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const blindSpots = new Set<BlindSpot>();
      if (attempted.includes("github_code") && succeeded.has("github_code")) {
        blindSpots.add("default_branch_only");
        blindSpots.add("snippet_only");
      }
      if (!attempted.includes("github_code")) {
        blindSpots.add("source_budget_exhausted");
      }
      if (!succeeded.has("searchcode")) {
        blindSpots.add("hydration_incomplete");
      }
      if (timedOutSources.size > 0) {
        blindSpots.add("source_timeout");
      }

      const uniqueRepos = new Set(deduped.map((hit) => hit.repo)).size;
      const sourceSuccessRate = attempted.length > 0 ? succeeded.size / attempted.length : 0;
      const blindSpotPenalty = Math.min(blindSpots.size * 0.1, 0.4);
      const evidenceConfidence = Math.max(0.1, sourceSuccessRate - blindSpotPenalty);

      return {
        hits: deduped,
        coverage: {
          sourcesAttempted: attempted,
          sourcesSucceeded: [...succeeded],
          sourcesFailed: failed,
          blindSpots: [...blindSpots],
          evidenceConfidence,
          totalHits: allHits.length,
          uniqueRepos,
          cachedHits: 0,
        },
      };
    },
  };
}

async function searchGitHub(github: GitHubGateway, queries: CompiledQuery[]): Promise<SourceHit[]> {
  const jobs = queries.map((query) =>
    withTimeout(
      github.searchCode(query.queryText, {
        limit: coerceLimit(query.parameters["limit"], 15),
      })
        .then((results) => {
          const discoveredAt = new Date().toISOString();
          const hits: SourceHit[] = results.map((result) => ({
            source: "github_code",
            queryVariant: query.queryText,
            repo: result.repo,
            path: result.path,
            snippet: result.textMatch ?? "",
            lineStart: null,
            url: `https://github.com/${result.repo}/blob/HEAD/${result.path}`,
            language: null,
            discoveredAt,
          }));
          return { status: "ok" as const, hits };
        })
        .catch((error: unknown) => {
          logError(`github.searchCode failed for query "${query.queryText}"`, error);
          return { status: "error" as const, hits: [] };
        }),
      3000,
      { status: "timeout" as const, hits: [] } as GitHubQueryOutcome,
    ),
  );

  const settled = await Promise.allSettled(jobs);
  const hits: SourceHit[] = [];
  let hadFailure = false;

  for (const result of settled) {
    if (result.status === "rejected") {
      hadFailure = true;
      logError("github query promise rejected", result.reason);
      continue;
    }

    if (result.value.status === "timeout") {
      hadFailure = true;
      process.stderr.write("github.searchCode timed out after 3000ms\n");
      continue;
    }

    if (result.value.status === "error") {
      hadFailure = true;
      continue;
    }

    hits.push(...result.value.hits);
  }

  if (hits.length === 0 && hadFailure) {
    throw new Error("GitHub code search produced no results after query failures or timeouts");
  }

  return hits;
}

function coerceLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function logError(message: string, error: unknown): void {
  process.stderr.write(`${message}: ${formatError(error)}\n`);
}


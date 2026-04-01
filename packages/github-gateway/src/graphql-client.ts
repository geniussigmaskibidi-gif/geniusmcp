// Batch metadata hydration via GitHub GraphQL API.
// Uses aliases to fetch multiple repos in one call.
// Research: GitHub GraphQL point-based rate limits, aliases for fan-out.

import type { ForgeResult } from "@forgemcp/core";
import { ok, err } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RepoHealthSnapshot {
  readonly fullName: string;
  readonly stars: number;
  readonly forks: number;
  readonly openIssues: number;
  readonly archived: boolean;
  readonly lastPushed: string | null;
  readonly license: string | null;
  readonly defaultBranch: string;
  readonly topics: string[];
  readonly language: string | null;
  readonly releaseCount: number;
}

// ─────────────────────────────────────────────────────────────
// GraphQL query builder
// ─────────────────────────────────────────────────────────────

/**
 * Build an aliased GraphQL query for multiple repos.
 *
 * Uses aliases (repo0, repo1, ...) to batch up to 10 repos per call.
 * GitHub charges ~1 point per node, so 10 repos ≈ 10 points.
 */
export function buildBatchRepoQuery(repos: string[]): string {
  const fragments = repos.map((repo, i) => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) return "";
    return `  repo${i}: repository(owner: "${escapeGraphQL(owner)}", name: "${escapeGraphQL(name)}") {
    nameWithOwner
    stargazerCount
    forkCount
    issues(states: OPEN) { totalCount }
    isArchived
    pushedAt
    licenseInfo { spdxId }
    defaultBranchRef { name }
    repositoryTopics(first: 10) { nodes { topic { name } } }
    primaryLanguage { name }
    releases { totalCount }
  }`;
  }).filter(Boolean);

  return `query {\n${fragments.join("\n")}\n}`;
}

/**
 * Parse a batched GraphQL response into RepoHealthSnapshot[].
 */
export function parseBatchRepoResponse(
  data: Record<string, unknown>,
  repos: string[],
): RepoHealthSnapshot[] {
  const results: RepoHealthSnapshot[] = [];

  for (let i = 0; i < repos.length; i++) {
    const key = `repo${i}`;
    const repo = data[key] as Record<string, unknown> | null;
    if (!repo) continue;

    results.push({
      fullName: repo.nameWithOwner as string,
      stars: repo.stargazerCount as number,
      forks: repo.forkCount as number,
      openIssues: (repo.issues as { totalCount: number })?.totalCount ?? 0,
      archived: repo.isArchived as boolean,
      lastPushed: repo.pushedAt as string | null,
      license: (repo.licenseInfo as { spdxId: string } | null)?.spdxId ?? null,
      defaultBranch: (repo.defaultBranchRef as { name: string } | null)?.name ?? "main",
      topics: ((repo.repositoryTopics as { nodes: Array<{ topic: { name: string } }> })
        ?.nodes ?? []).map(n => n.topic.name),
      language: (repo.primaryLanguage as { name: string } | null)?.name ?? null,
      releaseCount: (repo.releases as { totalCount: number })?.totalCount ?? 0,
    });
  }

  return results;
}

/**
 * Execute a GraphQL query against the GitHub API.
 *
 * Uses fetch (Node 18+) with proper authorization and error handling.
 * Returns ForgeResult for consistent error boundary.
 */
export async function executeGraphQL(
  query: string,
  token: string,
  opts?: { timeoutMs?: number },
): Promise<ForgeResult<Record<string, unknown>>> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ForgeMCP/1.0",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      if (response.status === 401) {
        return err("AUTH_REQUIRED", "GitHub token is invalid or expired", { recoverable: false });
      }
      if (response.status === 403) {
        const retryAfter = response.headers.get("Retry-After");
        return err("RATE_LIMIT", "GitHub GraphQL rate limit exceeded", {
          recoverable: true,
          retryAfterMs: retryAfter ? parseInt(retryAfter) * 1000 : 60_000,
        });
      }
      return err("TRANSIENT_UPSTREAM",
        `GitHub GraphQL returned ${response.status}: ${response.statusText}`,
        { recoverable: true }
      );
    }

    const json = await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };

    if (json.errors) {
      return err("TRANSIENT_UPSTREAM",
        `GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`,
        { recoverable: true }
      );
    }

    if (!json.data) {
      return err("INTERNAL", "GraphQL response missing data field");
    }

    return ok(json.data);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return err("TIMEOUT", `GraphQL request timed out after ${timeoutMs}ms`, { recoverable: true });
    }
    return err("TRANSIENT_UPSTREAM",
      `GraphQL request failed: ${e instanceof Error ? e.message : String(e)}`,
      { recoverable: true }
    );
  }
}

/**
 * Batch hydrate repo metadata via GraphQL.
 *
 * Splits into batches of 10 (optimal for GitHub point budget).
 */
export async function batchHydrateRepos(
  repos: string[],
  token: string,
): Promise<ForgeResult<RepoHealthSnapshot[]>> {
  const BATCH_SIZE = 10;
  const allResults: RepoHealthSnapshot[] = [];

  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const query = buildBatchRepoQuery(batch);
    const result = await executeGraphQL(query, token);

    if (!result.ok) return result as ForgeResult<RepoHealthSnapshot[]>;

    const snapshots = parseBatchRepoResponse(result.value, batch);
    allResults.push(...snapshots);
  }

  return ok(allResults);
}

function escapeGraphQL(str: string): string {
  return str.replace(/["\\\n\r]/g, "");
}

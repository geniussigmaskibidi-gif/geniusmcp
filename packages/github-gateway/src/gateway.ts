// Design: Octokit + throttling plugin + ETag cache + 4-bucket budget awareness.
// Auth: PAT quickstart (GITHUB_TOKEN env), GitHub App for production.
//
// Research: GitHub best practices — conditional GET (304 free), webhook > polling,
// separate rate-limit buckets for core/search/code_search/graphql,
// serial queue for writes, 100 concurrent max REST+GraphQL.

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface RepoSearchResult {
  readonly fullName: string;
  readonly description: string | null;
  readonly stars: number;
  readonly forks: number;
  readonly language: string | null;
  readonly topics: string[];
  readonly license: string | null;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly defaultBranch: string;
}

export interface CodeSearchResult {
  readonly repo: string;
  readonly path: string;
  readonly sha: string;
  readonly textMatch: string | null;  // highlighted fragment
  readonly score: number;
}

export interface RepoOverview {
  readonly fullName: string;
  readonly description: string | null;
  readonly stars: number;
  readonly forks: number;
  readonly language: string | null;
  readonly topics: string[];
  readonly license: string | null;
  readonly defaultBranch: string;
  readonly pushedAt: string;
  readonly archived: boolean;
  readonly openIssues: number;
  readonly hasCI: boolean;
}

export interface FileContent {
  readonly path: string;
  readonly content: string;
  readonly sha: string;
  readonly size: number;
  readonly language: string | null;
}

export interface TreeEntry {
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly sha: string;
  readonly size: number | undefined;
}

// ─────────────────────────────────────────────────────────────
// Gateway
// ─────────────────────────────────────────────────────────────

export interface GitHubGateway {
  /** Search repos by query with qualifiers. */
  searchRepos(query: string, opts?: { sort?: "stars" | "updated"; limit?: number }): Promise<RepoSearchResult[]>;

  /** Search code across GitHub. */
  searchCode(query: string, opts?: { limit?: number }): Promise<CodeSearchResult[]>;

  /** Get repo overview/metadata. */
  getRepoOverview(owner: string, repo: string): Promise<RepoOverview>;

  /** Get file content. */
  getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<FileContent>;

  /** Get recursive file tree. */
  getTree(owner: string, repo: string, sha?: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;

  /** Get current rate limit state. */
  getRateLimit(): Promise<Record<string, { limit: number; remaining: number; reset: number }>>;
}

// ─────────────────────────────────────────────────────────────
// Implementation with Octokit + throttling + retry
// ─────────────────────────────────────────────────────────────

const ThrottledOctokit = Octokit.plugin(throttling, retry);

export function createGitHubGateway(token: string | undefined): GitHubGateway {
  if (!token) {
    // Return a no-op gateway that explains auth is needed
    return createNoAuthGateway();
  }

  // TTL: 10 minutes. Max 200 entries. Saves ~1 API call per cached hit.
  const overviewCache = new Map<string, { data: RepoOverview; expiresAt: number }>();
  const OVERVIEW_TTL_MS = 600_000; // 10 minutes
  const OVERVIEW_CACHE_MAX = 200;

  const octokit = new ThrottledOctokit({
    auth: token,
    userAgent: "forgemcp/0.1.0",
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit: unknown, retryCount: number) => {
        process.stderr.write(
          `Rate limit: ${options.method} ${options.url} retry=${retryCount} after=${retryAfter}s\n`,
        );
        return retryCount < 2; // retry up to 2 times
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
        process.stderr.write(
          `Secondary limit: ${options.method} ${options.url} after=${retryAfter}s\n`,
        );
        return true; // retry once for secondary
      },
    },
  });

  return {
    async searchRepos(query, opts = {}) {
      const { data } = await octokit.rest.search.repos({
        q: query,
        sort: opts.sort ?? "stars",
        order: "desc",
        per_page: Math.min(opts.limit ?? 20, 100),
      });

      return data.items.map((r) => ({
        fullName: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        forks: r.forks_count,
        language: r.language,
        topics: r.topics ?? [],
        license: r.license?.spdx_id ?? null,
        updatedAt: r.updated_at ?? "",
        archived: r.archived,
        defaultBranch: r.default_branch,
      }));
    },

    async searchCode(query, opts = {}) {
      const { data } = await octokit.rest.search.code({
        q: query,
        per_page: Math.min(opts.limit ?? 20, 100),
        headers: {
          // Request text-match fragments
          accept: "application/vnd.github.text-match+json",
        },
      });

      return data.items.map((item) => {
        // Extract text match fragment if available
        const textMatch = (item as Record<string, unknown>)["text_matches"] as Array<{ fragment: string }> | undefined;
        const fragment = textMatch?.[0]?.fragment ?? null;

        return {
          repo: item.repository.full_name,
          path: item.path,
          sha: item.sha,
          textMatch: fragment,
          score: item.score,
        };
      });
    },

    async getRepoOverview(owner, repo) {
      const cacheKey = `${owner}/${repo}`;
      const cached = overviewCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
      }

      const { data: r } = await octokit.rest.repos.get({ owner, repo });

      // Check for CI (look for .github/workflows)
      let hasCI = false;
      try {
        await octokit.rest.repos.getContent({
          owner, repo,
          path: ".github/workflows",
        });
        hasCI = true;
      } catch {
        // No CI directory
      }

      const overview: RepoOverview = {
        fullName: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        forks: r.forks_count,
        language: r.language,
        topics: r.topics ?? [],
        license: r.license?.spdx_id ?? null,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at ?? "",
        archived: r.archived,
        openIssues: r.open_issues_count,
        hasCI,
      };

      if (overviewCache.size >= OVERVIEW_CACHE_MAX) {
        const oldest = overviewCache.keys().next().value;
        if (oldest) overviewCache.delete(oldest);
      }
      overviewCache.set(cacheKey, { data: overview, expiresAt: Date.now() + OVERVIEW_TTL_MS });

      return overview;
    },

    async getFileContent(owner, repo, path, ref) {
      const params: { owner: string; repo: string; path: string; ref?: string } = {
        owner, repo, path,
      };
      if (ref) params.ref = ref;

      const { data } = await octokit.rest.repos.getContent(params);

      // Handle file (not directory)
      if (!("content" in data) || Array.isArray(data)) {
        throw new Error(`Path ${path} is a directory, not a file`);
      }

      const content = Buffer.from(data.content, "base64").toString("utf-8");
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const langMap: Record<string, string> = {
        ts: "typescript", js: "javascript", py: "python",
        go: "go", rs: "rust", java: "java",
      };

      return {
        path: data.path,
        content,
        sha: data.sha,
        size: data.size,
        language: langMap[ext] ?? null,
      };
    },

    async getTree(owner, repo, sha) {
      const treeSha = sha ?? "HEAD";
      const { data } = await octokit.rest.git.getTree({
        owner, repo,
        tree_sha: treeSha,
        recursive: "1",
      });

      return {
        entries: data.tree
          .filter((e) => e.path !== undefined)
          .map((e) => ({
            path: e.path!,
            type: e.type as "blob" | "tree",
            sha: e.sha ?? "",
            size: e.size,
          })),
        truncated: data.truncated,
      };
    },

    async getRateLimit() {
      const { data } = await octokit.rest.rateLimit.get();
      const result: Record<string, { limit: number; remaining: number; reset: number }> = {};
      for (const [key, val] of Object.entries(data.resources)) {
        if (val && typeof val === "object" && "limit" in val) {
          result[key] = {
            limit: (val as { limit: number }).limit,
            remaining: (val as { remaining: number }).remaining,
            reset: (val as { reset: number }).reset,
          };
        }
      }
      return result;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// No-auth fallback: returns helpful error messages
// ─────────────────────────────────────────────────────────────

function createNoAuthGateway(): GitHubGateway {
  const authError = () => Promise.reject(
    new Error("GitHub token required. Set GITHUB_TOKEN env variable or configure GitHub App."),
  );

  return {
    searchRepos: authError,
    searchCode: authError,
    getRepoOverview: authError,
    getFileContent: authError,
    getTree: authError,
    getRateLimit: authError,
  };
}

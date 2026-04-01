// THE KILLER PIPELINE: genius.find_best → genius.compare → import.extract
//
// genius.find_best is an 8-stage pipeline:
//   1. compile — concept → query expansion
//   2. scout — repo discovery (stars, topics)
//   3. search — code search across discovered repos
//   4. ingest — fetch candidate file contents
//   5. derive — extract symbols + compute fingerprints
//   6. cluster — deduplicate by AST fingerprint (approach families)
//   7. rank — Durability×Vitality scoring with breakdown
//   8. slice — return top results with explanations

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubGateway } from "@forgemcp/github-gateway";
import { compileSearchQueries } from "@forgemcp/github-gateway";
import { extractSymbols, computeAstFingerprint } from "@forgemcp/ast-intelligence";
import { extractWithProvenance } from "@forgemcp/importer";
import { selectTier } from "@forgemcp/core";
import { formatTieredResults } from "@forgemcp/core";
import type { TierableResult } from "@forgemcp/core";
import { toolJson, toolError, validateRepo } from "../tool-helpers.js";

export function registerGitHubSkill(server: McpServer, github: GitHubGateway): void {

  // ────────────────────────────────────────────────
  // Tool: github.search_repos
  // ────────────────────────────────────────────────

  server.tool(
    "github.search_repos",
    "Search GitHub repositories by query, language, stars, topics",
    {
      query: z.string().min(1),
      language: z.string().optional(),
      minStars: z.number().int().optional(),
      sort: z.enum(["stars", "updated"]).default("stars"),
      limit: z.number().int().min(1).max(30).default(10),
    },
    async ({ query, language, minStars, sort, limit }) => {
      let q = query;
      if (language) q += ` language:${language}`;
      if (minStars) q += ` stars:>${minStars}`;

      const repos = await github.searchRepos(q, { sort, limit });

      return toolJson({
        total: repos.length,
        repos: repos.map((r) => ({
          name: r.fullName,
          description: r.description,
          stars: r.stars,
          language: r.language,
          license: r.license,
          topics: r.topics.slice(0, 5),
          updated: r.updatedAt,
          archived: r.archived,
        })),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: github.search_code
  // ────────────────────────────────────────────────

  server.tool(
    "github.search_code",
    "Search code across GitHub. Returns file matches with text fragments.",
    {
      query: z.string().min(1),
      language: z.string().optional(),
      repo: z.string().optional().describe("Scope to specific repo (owner/name)"),
      limit: z.number().int().min(1).max(30).default(15),
    },
    async ({ query, language, repo, limit }) => {
      let q = query;
      if (language) q += ` language:${language}`;
      if (repo) q += ` repo:${repo}`;

      const results = await github.searchCode(q, { limit });

      return toolJson({
        total: results.length,
        results: results.map((r) => ({
          repo: r.repo,
          path: r.path,
          textMatch: r.textMatch?.slice(0, 300),
          score: r.score,
        })),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: github.repo_overview
  // ────────────────────────────────────────────────

  server.tool(
    "github.repo_overview",
    "Get comprehensive repo intelligence: stars, health, CI, topics, license",
    {
      repo: z.string().describe("owner/repo format"),
    },
    async ({ repo }) => {
      const parsed = validateRepo(repo);
      if ("isError" in parsed) return parsed;
      const { owner, name } = parsed;

      const overview = await github.getRepoOverview(owner, name);
      return toolJson(overview);
    },
  );

  // ────────────────────────────────────────────────
  // Tool: github.repo_file
  // ────────────────────────────────────────────────

  server.tool(
    "github.repo_file",
    "Get file content from a GitHub repo",
    {
      repo: z.string().describe("owner/repo"),
      path: z.string().describe("File path within repo"),
      ref: z.string().optional().describe("Branch, tag, or commit SHA"),
    },
    async ({ repo, path, ref }) => {
      const parsed = validateRepo(repo);
      if ("isError" in parsed) return parsed;
      const { owner, name } = parsed;

      const file = await github.getFileContent(owner, name, path, ref);
      // Cap content at 8000 chars to fit token budget
      const content = file.content.length > 8000
        ? file.content.slice(0, 8000) + "\n... (truncated)"
        : file.content;

      return toolJson({
        path: file.path,
        size: file.size,
        language: file.language,
        sha: file.sha,
        content,
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: github.repo_tree
  // ────────────────────────────────────────────────

  server.tool(
    "github.repo_tree",
    "Get file tree of a GitHub repo (recursive)",
    {
      repo: z.string().describe("owner/repo"),
      maxDepth: z.number().int().default(3),
    },
    async ({ repo, maxDepth }) => {
      const parsed = validateRepo(repo);
      if ("isError" in parsed) return parsed;
      const { owner, name } = parsed;

      const { entries, truncated } = await github.getTree(owner, name);

      // Filter by depth
      const filtered = entries
        .filter((e) => e.path.split("/").length <= maxDepth)
        .filter((e) => e.type === "blob") // only files
        .slice(0, 200); // cap to keep response reasonable

      return toolJson({
        repo,
        totalEntries: entries.length,
        shown: filtered.length,
        truncated,
        tree: filtered.map((e) => ({
          path: e.path,
          size: e.size,
        })),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: genius.find_best — THE FLAGSHIP
  // 8-stage pipeline for finding best implementations
  // ────────────────────────────────────────────────

  server.tool(
    "genius.find_best",
    "Find the best implementations of a concept across GitHub. " +
    "Returns ranked archetypes with explanations, not raw search results. " +
    "Example: genius.find_best('rate limiter', language: 'typescript')",
    {
      concept: z.string().min(2).describe("What to find (e.g. 'rate limiter', 'retry with backoff')"),
      language: z.string().optional().describe("Programming language filter"),
      minStars: z.number().int().default(50).describe("Minimum repo stars"),
      limit: z.number().int().min(1).max(10).default(5),
      preset: z.enum(["battle_tested", "modern_active", "minimal_dependency", "teaching_quality"])
        .default("battle_tested"),
    },
    async ({ concept, language, minStars, limit, preset }) => {
      const startTime = performance.now();

      // ── Stage 1: COMPILE — expand concept into multi-strategy queries ──
      const compiled = compileSearchQueries({
        concept,
        language,
        minStars,
      });

      // ── Stage 2: SCOUT — discover strong repos via multiple queries ──
      const repoResults: Awaited<ReturnType<typeof github.searchRepos>> = [];
      for (const rq of compiled.repoQueries.slice(0, 3)) {
        try {
          const hits = await github.searchRepos(rq, { sort: "stars", limit: 10 });
          repoResults.push(...hits);
        } catch { /* rate limit or error — continue with what we have */ }
      }
      // Deduplicate repos by name
      const seenRepos = new Set<string>();
      const uniqueRepos = repoResults.filter((r) => {
        if (seenRepos.has(r.fullName)) return false;
        seenRepos.add(r.fullName);
        return true;
      });

      // ── Stage 3: SEARCH — code search with expanded queries ──
      const codeResults: Awaited<ReturnType<typeof github.searchCode>> = [];
      for (const cq of compiled.codeQueries.slice(0, 4)) {
        try {
          const hits = await github.searchCode(cq, { limit: 15 });
          codeResults.push(...hits);
        } catch { /* continue */ }
      }
      // Also try symbol queries
      for (const sq of compiled.symbolQueries.slice(0, 2)) {
        try {
          const hits = await github.searchCode(sq, { limit: 10 });
          codeResults.push(...hits);
        } catch { /* continue */ }
      }

      // ── Stage 4: INGEST — fetch candidate file contents ──
      // Take top candidates, fetch their actual code
      const candidates: Array<{
        repo: string;
        path: string;
        code: string;
        stars: number;
        language: string | null;
      }> = [];

      const seen = new Set<string>();
      const uniqueToFetch: typeof codeResults = [];
      for (const result of codeResults.slice(0, 15)) {
        const key = `${result.repo}:${result.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueToFetch.push(result);
      }

      // Sequential was 15×latency; now max(ceil(15/5))×latency = 3× improvement
      const CONCURRENCY = 5;
      for (let i = 0; i < uniqueToFetch.length; i += CONCURRENCY) {
        const chunk = uniqueToFetch.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map(async (result) => {
            const [owner, name] = result.repo.split("/");
            if (!owner || !name) return null;
            const file = await github.getFileContent(owner, name, result.path);
            const repoInfo = repoResults.find((r) => r.fullName === result.repo);
            return {
              repo: result.repo,
              path: result.path,
              code: file.content,
              stars: repoInfo?.stars ?? 0,
              language: file.language,
            };
          }),
        );
        for (const outcome of settled) {
          if (outcome.status === "fulfilled" && outcome.value) {
            candidates.push(outcome.value);
          }
        }
      }

      // ── Stage 5: DERIVE — extract symbols + fingerprints ──
      const analyzed = candidates.map((c) => {
        const lang = c.language ?? language ?? "typescript";
        let symbols: ReturnType<typeof extractSymbols>["symbols"];
        try {
          ({ symbols } = extractSymbols(c.code, lang));
        } catch {
          symbols = [];
        }

        // Find the most relevant symbol (matches concept name)
        const conceptWords = concept.toLowerCase().split(/\s+/);
        const bestSymbol = symbols.find((s) =>
          conceptWords.some((w) => s.name.toLowerCase().includes(w)),
        ) ?? symbols.find((s) => s.exported) ?? symbols[0];

        return {
          repo: c.repo,
          path: c.path,
          stars: c.stars,
          language: lang,
          symbol: bestSymbol ?? null,
          fingerprint: bestSymbol ? bestSymbol.astFingerprint : computeAstFingerprint(c.code.slice(0, 2000)),
          hasTests: c.path.includes("test") || c.path.includes("spec"),
          snippet: bestSymbol?.code.slice(0, 1500) ?? c.code.slice(0, 1500),
        };
      });

      // ── Stage 6: CLUSTER — deduplicate by fingerprint ──
      const clusters = new Map<string, typeof analyzed>();
      for (const a of analyzed) {
        const existing = clusters.get(a.fingerprint) ?? [];
        existing.push(a);
        clusters.set(a.fingerprint, existing);
      }

      // Pick best representative per cluster (highest stars)
      const representatives = [...clusters.values()].map((cluster) => {
        const best = cluster.sort((a, b) => b.stars - a.stars)[0]!;
        return { ...best, clusterSize: cluster.length };
      });

      // ── Stage 7: RANK — score by preset ──
      const ranked = representatives.map((r) => {
        const score = scoreByPreset(r, preset);
        return { ...r, score, why: explainScore(r, preset) };
      }).sort((a, b) => b.score - a.score);

      // ── Stage 8: SLICE — return top results with adaptive tier ──
      const results = ranked.slice(0, limit);
      const elapsed = Math.round(performance.now() - startTime);

      // Claude Code pattern: progressive truncation with metadata about what was cut
      const responseTier = selectTier(results.length);

      const tierableResults: TierableResult[] = results.map((r) => ({
        name: r.symbol?.name ?? r.path.split("/").pop() ?? "unknown",
        kind: r.symbol ? "function" : "file",
        language: r.language ?? undefined,
        confidence: r.score,
        signature: r.symbol?.signature ?? undefined,
        description: r.why.join("; "),
        file: r.path,
        repo: r.repo,
        deps: r.symbol?.imports,
        code: responseTier === "L3" ? r.snippet : undefined,
      }));

      if (responseTier !== "L3") {
        const tieredText = formatTieredResults(tierableResults, responseTier);
        return toolJson({
          concept,
          language: language ?? "any",
          preset,
          tier: responseTier,
          totalCandidates: candidates.length,
          clustersFound: clusters.size,
          results: tieredText,
          searchTimeMs: elapsed,
          truncated: { tier: responseTier, fullResultsAvailable: results.length },
        });
      }

      return toolJson({
        concept,
        language: language ?? "any",
        preset,
        tier: "L3",
        totalCandidates: candidates.length,
        clustersFound: clusters.size,
        results: results.map((r) => ({
          repo: r.repo,
          path: r.path,
          symbol: r.symbol?.name ?? null,
          stars: r.stars,
          language: r.language,
          score: Math.round(r.score * 100) / 100,
          why: r.why,
          clusterSize: r.clusterSize,
          snippet: r.snippet,
          importable: {
            hasTests: r.hasTests,
            deps: r.symbol?.imports ?? [],
          },
        })),
        searchTimeMs: elapsed,
        gaps: [
          candidates.length < 5 ? "Few candidates found — try broader query" : null,
          !language ? "No language filter — results may be mixed" : null,
        ].filter(Boolean),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: github.compare
  // ────────────────────────────────────────────────

  server.tool(
    "github.compare",
    "Compare implementations from different repos side-by-side with quality breakdown",
    {
      concept: z.string(),
      repos: z.array(z.string()).min(2).max(5).describe("Repos to compare (owner/repo)"),
    },
    async ({ concept, repos }) => {
      const comparisons = [];

      for (const repo of repos) {
        const [owner, name] = repo.split("/");
        if (!owner || !name) continue;

        try {
          const overview = await github.getRepoOverview(owner, name);

          // Search for concept in this repo
          const codeHits = await github.searchCode(
            `${concept} repo:${repo}`,
            { limit: 3 },
          );

          comparisons.push({
            repo,
            stars: overview.stars,
            language: overview.language,
            license: overview.license,
            hasCI: overview.hasCI,
            archived: overview.archived,
            openIssues: overview.openIssues,
            pushedAt: overview.pushedAt,
            matchingFiles: codeHits.map((h) => h.path),
            textMatch: codeHits[0]?.textMatch?.slice(0, 300) ?? null,
          });
        } catch {
          comparisons.push({ repo, error: "Could not access repo" });
        }
      }

      return toolJson({ concept, comparisons });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: import.extract — provenance-aware code transplant
  // THE CLOSER: takes find_best result → importable code
  // ────────────────────────────────────────────────

  server.tool(
    "import.extract",
    "Extract a function/module from a GitHub repo with provenance. " +
    "License-checked, dependency-resolved, style-adapted. " +
    "Returns ready-to-paste code with attribution.",
    {
      repo: z.string().describe("owner/repo"),
      path: z.string().describe("File path in the repo"),
      symbol: z.string().optional().describe("Specific function/class to extract"),
      ref: z.string().optional().describe("Branch/tag/commit"),
      adaptStyle: z.boolean().default(false).describe("Adapt to your project's style"),
    },
    async ({ repo, path, symbol, ref, adaptStyle }) => {
      const result = await extractWithProvenance(
        { repo, path, symbol, ref, adaptStyle },
        github,
      );

      return toolJson({
        symbol: result.symbol,
        language: result.language,
        source: {
          repo: result.sourceRepo,
          path: result.sourcePath,
          commit: result.sourceCommitSha.slice(0, 12),
          license: result.licenseSpdx,
          licenseVerdict: result.licenseVerdict,
        },
        // Truncation only for very large files (>8KB), never compression
        code: result.code.length <= 8000
          ? result.code
          : result.code.slice(0, 8000) + "\n// ... truncated at 8000 chars (full file: " + result.code.length + " chars)",
        dependencies: result.dependencies,
        adaptations: result.adaptations,
        installCommand: result.installCommand,
        provenance: {
          hash: result.provenanceHash,
          attribution: result.attributionComment,
        },
        mode: result.mode,
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────
// Scoring by preset: Durability×Vitality model
// ─────────────────────────────────────────────────────────────

interface Scorable {
  stars: number;
  hasTests: boolean;
  clusterSize: number;
  symbol: { imports: string[] } | null;
}

function scoreByPreset(candidate: Scorable, preset: string): number {
  const starScore = Math.min(1, Math.log10(candidate.stars + 1) / 5);
  const testScore = candidate.hasTests ? 1 : 0.3;
  const depPenalty = Math.min(1, (candidate.symbol?.imports.length ?? 0) / 10);
  const uniqueness = 1 / (1 + Math.log2(candidate.clusterSize)); // more unique = higher

  switch (preset) {
    case "battle_tested":
      return 0.35 * starScore + 0.30 * testScore + 0.15 * uniqueness + 0.20 * (1 - depPenalty);
    case "modern_active":
      return 0.25 * starScore + 0.20 * testScore + 0.25 * uniqueness + 0.30 * (1 - depPenalty);
    case "minimal_dependency":
      return 0.15 * starScore + 0.15 * testScore + 0.20 * uniqueness + 0.50 * (1 - depPenalty);
    case "teaching_quality":
      return 0.20 * starScore + 0.30 * testScore + 0.30 * uniqueness + 0.20 * (1 - depPenalty);
    default:
      return 0.25 * starScore + 0.25 * testScore + 0.25 * uniqueness + 0.25 * (1 - depPenalty);
  }
}

function explainScore(candidate: Scorable, preset: string): string[] {
  const why: string[] = [];
  if (candidate.stars > 1000) why.push(`Popular repo (${candidate.stars} stars)`);
  if (candidate.hasTests) why.push("Has associated tests");
  if ((candidate.symbol?.imports.length ?? 0) === 0) why.push("Zero external dependencies");
  if (candidate.clusterSize === 1) why.push("Unique implementation (not a copy)");
  if (candidate.clusterSize > 3) why.push(`Common pattern (${candidate.clusterSize} similar implementations)`);
  if (preset === "battle_tested" && candidate.stars > 500) why.push("Ranked by battle-testedness");
  if (preset === "minimal_dependency") why.push("Ranked by minimal dependencies");
  return why;
}

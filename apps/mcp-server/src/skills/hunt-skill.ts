// Evidence-backed code search: scatter → dedup → cluster → score → explain
// Two-stage: provisional (fast, <2s) → verified (quality, <6s)

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SourceOrchestrator } from "@forgemcp/data-sources";
import { compileHuntQueries } from "@forgemcp/data-sources";
import type { HuntRequest, Archetype, ScoredCandidate, RankingPreset } from "@forgemcp/data-sources";
import type { CircuitBreaker, Bulkhead, SourceSelector } from "@forgemcp/data-sources";
import { extractSymbols } from "@forgemcp/ast-intelligence";
import { batchHydrateRepos } from "@forgemcp/github-gateway";
import type { RepoHealthSnapshot } from "@forgemcp/github-gateway";
import type { MemoryEngine } from "@forgemcp/repo-memory";
import {
  computeFingerprint, clusterByJaccard, contentHash,
  computeScore, compositeScore, applyHardCaps,
  classifySymbol, groupByArchetype, archetypeName, archetypeTradeoffs,
  sacSimilarity,
} from "@forgemcp/hunt-engine";
import type { RawSignals } from "@forgemcp/hunt-engine";
import { classifyQuery, planQuery } from "@forgemcp/db/query-planner";
import { selectTier } from "@forgemcp/core";
import { formatTieredResults } from "@forgemcp/core";
import type { TierableResult } from "@forgemcp/core";
import { toolJson, toolError } from "../tool-helpers.js";

function inferLangFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", go: "go", rs: "rust", java: "java",
    rb: "ruby", php: "php", cs: "csharp", swift: "swift",
    kt: "kotlin", scala: "scala", dart: "dart",
  };
  return ext ? (map[ext] ?? null) : null;
}

export interface HuntSkillOptions {
  breakers: Record<string, CircuitBreaker>;
  bulkheads: Record<string, Bulkhead>;
  sourceSelector: SourceSelector;
  githubToken?: string;
  memory?: MemoryEngine;
}

export function registerHuntSkill(
  server: McpServer,
  orchestrator: SourceOrchestrator,
  options?: HuntSkillOptions,
): void {

  // ────────────────────────────────────────────────
  // Tool: genius.hunt — THE FLAGSHIP
  // ────────────────────────────────────────────────

  server.tool(
    "genius.hunt",
    "Find the best implementations of a concept across GitHub, grep.app, and searchcode. " +
    "Returns ranked archetypes (not raw search results) with quality explanations. " +
    "Example: genius.hunt('rate limiter', language: 'typescript')",
    {
      query: z.string().min(2).describe("What to find: 'retry with backoff', 'rate limiter'"),
      language: z.string().optional().describe("Filter by language"),
      preset: z.enum(["battle_tested", "modern_active", "minimal_dependency", "teaching_quality"])
        .default("battle_tested"),
      mode: z.enum(["fast", "balanced", "deep"]).default("balanced")
        .describe("fast: local+grep (<1.5s), balanced: full discovery (<6s), deep: wider hydration"),
      maxArchetypes: z.number().int().min(1).max(10).default(5),
      tier: z.enum(["L1", "L2", "L3", "auto"]).default("auto")
        .describe("Response detail level: L1=compact cards, L2=descriptions, L3=full code, auto=adaptive"),
    },
    async ({ query, language, preset, mode, maxArchetypes, tier }) => {
      const startTime = performance.now();
      const req: HuntRequest = { query, language, preset: preset as RankingPreset, mode: mode as "fast" | "balanced" | "deep", maxArchetypes };

      const queryClass = classifyQuery(query);
      const queryPlan = planQuery(query);

      if (options?.sourceSelector) {
        const recommended = options.sourceSelector.selectSources(queryClass, 3);
        // Log for diagnostics — agent sees which sources were selected
        process.stderr.write(`Source selector chose: ${recommended.join(", ")} for ${queryClass}\n`);
      }

      // ── Stage 1: COMPILE queries for all sources ──
      const compiledQueries = compileHuntQueries(req);

      // ── Stage 2: SCATTER across sources (timeout varies by mode) ──
      // Old values (2/5/10s) caused GitHub to timeout in fast/balanced mode
      const timeoutByMode = { fast: 4000, balanced: 8000, deep: 15000 };
      const timeout = timeoutByMode[req.mode ?? "balanced"];

      let hits: Awaited<ReturnType<typeof orchestrator.scatter>>["hits"];
      let coverage: Awaited<ReturnType<typeof orchestrator.scatter>>["coverage"];

      const emptyCoverage = (): typeof coverage => ({
        sourcesAttempted: [], sourcesSucceeded: [],
        sourcesFailed: [{ source: "github_code" as const, reason: "scatter_error" }],
        blindSpots: [], evidenceConfidence: 0, totalHits: 0, uniqueRepos: 0, cachedHits: 0,
      });

      try {
        if (options?.breakers) {
          const mainBreaker = options.breakers["github"] ?? options.breakers[Object.keys(options.breakers)[0]!];
          const result = await mainBreaker!.run(
            () => orchestrator.scatter(compiledQueries, { timeoutMs: timeout }),
            () => ({ hits: [] as typeof hits, coverage: emptyCoverage() }),
          );
          hits = result.hits;
          coverage = result.coverage;
        } else {
          const result = await orchestrator.scatter(compiledQueries, { timeoutMs: timeout });
          hits = result.hits;
          coverage = result.coverage;
        }
      } catch (err) {
        process.stderr.write(`Scatter error: ${err instanceof Error ? err.message : String(err)}\n`);
        hits = [];
        coverage = emptyCoverage();
      }

      if (hits.length === 0) {
        const failedSources = coverage.sourcesFailed.map((f) => `${f.source}: ${f.reason}`);
        const suggestions: string[] = [];
        if (query.split(/\s+/).length > 4) suggestions.push("Query too long — try 2-3 keywords instead");
        if (!options?.githubToken) suggestions.push("Set GITHUB_TOKEN env var to enable GitHub Code Search and real metadata scores");
        if (failedSources.some((f) => f.includes("timeout"))) suggestions.push("Some sources timed out — try mode: 'deep' for 15s timeout instead of 8s");
        if (failedSources.length === 0) suggestions.push("Try broader query, fewer words, or different language");
        suggestions.push("Tip: use 2-3 keyword queries for best results (e.g. 'rate limiter' not 'token bucket rate limiter with sliding window')");

        return toolJson({
          query, language, preset,
          archetypes: [],
          coverage,
          searchDurationMs: Math.round(performance.now() - startTime),
          stage: "provisional",
          failedSources,
          suggestions: suggestions.length > 0 ? suggestions : ["No results found. Try a different query."],
        });
      }

      // ── Stage 3: DEDUP by content hash ──
      const uniqueBlobs = new Map<string, typeof hits[0]>();
      for (const hit of hits) {
        const hash = contentHash((hit.snippet ?? "") + "|" + hit.repo + "|" + hit.path);
        if (!uniqueBlobs.has(hash)) {
          uniqueBlobs.set(hash, hit);
        }
      }

      const symbolsWithHits: Array<{
        hit: typeof hits[0];
        symbols: ReturnType<typeof extractSymbols>["symbols"];
        blobHash: string;
      }> = [];
      let extractionAttempts = 0;
      let extractionSuccesses = 0;
      let extractionFailures = 0;

      for (const [hash, hit] of uniqueBlobs) {
        if (!hit.snippet || hit.snippet.length < 20) continue;
        extractionAttempts++;
        const hitLang = (hit.language ?? language ?? inferLangFromPath(hit.path)) || "typescript";
        try {
          const { symbols } = extractSymbols(hit.snippet, hitLang);
          if (symbols.length > 0) {
            symbolsWithHits.push({ hit, symbols, blobHash: hash });
            extractionSuccesses++;
          }
        } catch (err) {
          extractionFailures++;
          process.stderr.write(`Symbol extraction failed for ${hit.repo}/${hit.path}: ${err instanceof Error ? err.message : "unknown"}\n`);
        }
      }

      // ── Stage 5: FINGERPRINT + CLUSTER ──
      const queryWords = query.toLowerCase().split(/\s+/);

      const fingerprintItems = symbolsWithHits.flatMap(({ hit, symbols, blobHash }) => {
        // "getUserSession" matches "get_user_session" — BM25/includes cannot do this
        const queryId = queryWords.join("_");
        const scored = symbols.map((s) => ({
          sym: s,
          score: sacSimilarity(queryId, s.name),
        }));
        scored.sort((a, b) => b.score - a.score);
        const best = (scored[0]?.score ?? 0) > 0.2
          ? scored[0]!.sym
          : symbols.find((s) => s.exported) ?? symbols[0];

        if (!best) return [];

        const fp = computeFingerprint(best.code);
        return [{
          id: blobHash,
          fingerprint: fp,
          hit,
          symbol: best,
        }];
      });

      const clusters = clusterByJaccard(
        fingerprintItems.map((f) => ({ id: f.id, fingerprint: f.fingerprint })),
        0.6,
      );

      // This is the key fix: without metadata, repoStars=0 and vitality=0
      // Batch hydration: 10 repos per GraphQL call ≈ 10 rate limit points
      const uniqueRepos = [...new Set(fingerprintItems.map((f) => f.hit.repo))];
      const repoMetadata = new Map<string, RepoHealthSnapshot>();

      let metadataHydrated = 0;
      if (options?.githubToken && uniqueRepos.length > 0) {
        try {
          const hydrateResult = await batchHydrateRepos(uniqueRepos.slice(0, 30), options.githubToken);
          if (hydrateResult.ok) {
            for (const snap of hydrateResult.value) {
              repoMetadata.set(snap.fullName, snap);
              metadataHydrated++;
            }
          }
        } catch (err) {
          process.stderr.write(`Metadata hydration failed: ${err instanceof Error ? err.message : "unknown"}\n`);
        }
      }

      // ── Stage 6: CLASSIFY into archetypes ──
      const archetypes: Archetype[] = [];

      for (const cluster of clusters.slice(0, maxArchetypes * 2)) {
        const centroidItem = fingerprintItems.find((f) => f.id === cluster.centroidId);
        if (!centroidItem) continue;

        const classified = classifySymbol(centroidItem.symbol);

        const meta = repoMetadata.get(centroidItem.hit.repo);
        const hasMetadata = meta !== undefined;

        // ── Stage 7: SCORE with real metadata ──
        const signals: RawSignals = {
          nameMatch: queryWords.some((w) => centroidItem.symbol.name.toLowerCase().includes(w)),
          signatureMatch: queryWords.some((w) => (centroidItem.symbol.signature ?? "").toLowerCase().includes(w)),
          snippetMatch: true,
          repoStars: meta?.stars ?? 0,
          hasTests: centroidItem.hit.path.includes("test") || centroidItem.hit.path.includes("spec"),
          archived: meta?.archived ?? false,
          externalDepCount: centroidItem.symbol.imports.length,
          linesOfCode: centroidItem.symbol.endLine - centroidItem.symbol.startLine + 1,
          exported: centroidItem.symbol.exported,
          licenseSpdx: meta?.license ?? null,
          selfContained: centroidItem.symbol.imports.filter((i) => i.startsWith(".")).length === 0,
          sourceCount: 1,
          hasFullCode: centroidItem.symbol.code.length > 50,
          repoMetadataAvailable: hasMetadata,
          lastPushed: meta?.lastPushed ?? undefined,
          repoAge: meta?.lastPushed ? (Date.now() - new Date(meta.lastPushed).getTime()) / (365.25 * 86400_000) : undefined,
          releaseCount: meta?.releaseCount,
          blindSpots: [...coverage.blindSpots, ...(hasMetadata ? [] : ["metadata_stale" as const])],
        };

        const rawScore = computeScore(signals);
        const breakdown = applyHardCaps(rawScore.breakdown, signals);
        const { why, gaps } = rawScore;
        const score = compositeScore(breakdown, preset as RankingPreset);

        const exemplar: ScoredCandidate = {
          repo: centroidItem.hit.repo,
          path: centroidItem.hit.path,
          symbolName: centroidItem.symbol.name,
          language: centroidItem.hit.language ?? language ?? "typescript",
          snippet: centroidItem.symbol.code.slice(0, 1500),
          score,
          breakdown,
          why,
          gaps,
        };

        archetypes.push({
          name: archetypeName(classified.category, query),
          description: `${classified.category} implementation from ${centroidItem.hit.repo}`,
          category: classified.category,
          exemplar,
          alternatives: [], // would populate from cluster members
          tradeoffs: archetypeTradeoffs(classified.category),
          clusterSize: cluster.size,
        });
      }

      // Sort by exemplar score
      archetypes.sort((a, b) => b.exemplar.score - a.exemplar.score);

      const elapsed = Math.round(performance.now() - startTime);

      // Each genius.hunt call enriches the memory, making future queries faster
      const finalArchetypes = archetypes.slice(0, maxArchetypes);
      if (options?.memory && finalArchetypes.length > 0) {
        try {
          const storedNames = new Set<string>();
          for (const arch of finalArchetypes.slice(0, 3)) {
            if (storedNames.has(arch.exemplar.symbolName)) continue;
            storedNames.add(arch.exemplar.symbolName);

            // FTS5 indexes name + description + signature — tags are in separate table
            const description = [
              `${arch.category}: ${arch.description}`,
              `Query: ${query}`,
              `Score: ${arch.exemplar.score.toFixed(2)}`,
              arch.exemplar.why.join(". "),
            ].join(". ");

            options.memory.store({
              name: arch.exemplar.symbolName,
              kind: "pattern",
              code: arch.exemplar.snippet,
              language: arch.exemplar.language,
              description,
              sourceRepo: arch.exemplar.repo,
              sourcePath: arch.exemplar.path,
              tags: [query, arch.category, preset],
            });
          }
        } catch (err) {
          process.stderr.write(`Memory auto-store failed: ${err instanceof Error ? err.message : "unknown"}\n`);
        }
      }
      const responseTier = tier === "auto"
        ? selectTier(finalArchetypes.length)
        : tier as "L1" | "L2" | "L3";

      const tierableResults: TierableResult[] = finalArchetypes.map((a) => ({
        name: a.exemplar.symbolName,
        kind: a.category,
        language: a.exemplar.language,
        confidence: a.exemplar.score,
        signature: a.exemplar.snippet?.split("\n")[0] ?? undefined,
        description: a.description,
        file: a.exemplar.path,
        repo: a.exemplar.repo,
        code: responseTier === "L3" ? a.exemplar.snippet : undefined,
      }));

      const tieredOutput = responseTier !== "L3"
        ? formatTieredResults(tierableResults, responseTier)
        : undefined;

      // Without this, sources that return 0 results never get negative signal → bias
      if (options?.sourceSelector) {
        for (const src of coverage.sourcesSucceeded) {
          options.sourceSelector.update(queryClass, src, finalArchetypes.length > 0);
        }
        for (const fail of coverage.sourcesFailed) {
          options.sourceSelector.update(queryClass, fail.source, false);
        }
      }

      return toolJson({
        query,
        language: language ?? "any",
        preset,
        tier: responseTier,
        queryClassification: queryClass,
        searchLanes: queryPlan.lanes.map((l) => l.lane),
        ...(tieredOutput
          ? { results: tieredOutput }
          : { archetypes: finalArchetypes }),
        totalCandidates: hits.length,
        uniqueBlobs: uniqueBlobs.size,
        clustersFound: clusters.length,
        coverage,
        sourceHealth: {
          succeeded: coverage.sourcesSucceeded.length,
          failed: coverage.sourcesFailed.length,
          failReasons: coverage.sourcesFailed.map((f) => `${f.source}: ${f.reason}`),
        },
        searchDurationMs: elapsed,
        patternsAutoStored: finalArchetypes.length,
        pipeline: {
          extractionRate: extractionAttempts > 0 ? `${extractionSuccesses}/${extractionAttempts} (${Math.round(100 * extractionSuccesses / extractionAttempts)}%)` : "0/0",
          extractionFailures,
          metadataHydrated: `${metadataHydrated}/${uniqueRepos.length}`,
          familiesBeforeFilter: clusters.length,
        },
        stage: "provisional",
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: genius.explain — score breakdown
  // ────────────────────────────────────────────────

  server.tool(
    "genius.explain",
    "Explain why a code result ranked where it did. Full signal breakdown with per-factor scores.",
    {
      repo: z.string().describe("Repository (owner/name)"),
      path: z.string().describe("File path within repository"),
      query: z.string().describe("The search query to score against"),
      snippet: z.string().optional().describe("Code snippet to analyze (if available)"),
      language: z.string().optional().describe("Language of the code"),
      preset: z.enum(["battle_tested", "modern_active", "minimal_dependency", "teaching_quality"])
        .default("battle_tested"),
    },
    async ({ repo, path, query, snippet, language, preset }) => {
      const lang = language ?? "typescript";
      const queryWords = query.toLowerCase().split(/\s+/);

      // Extract symbols if snippet provided
      let symbolInfo: { name: string; exported: boolean; imports: string[]; startLine: number; endLine: number; signature: string | null; code: string } | null = null;
      if (snippet && snippet.length > 10) {
        try {
          const { symbols } = extractSymbols(snippet, lang);
          const best = symbols.find((s) =>
            queryWords.some((w) => s.name.toLowerCase().includes(w)),
          ) ?? symbols.find((s) => s.exported) ?? symbols[0];
          if (best) symbolInfo = best;
        } catch (err) {
          process.stderr.write(`explain: symbol extraction failed: ${err instanceof Error ? err.message : "unknown"}\n`);
        }
      }

      const signals: RawSignals = {
        nameMatch: symbolInfo ? queryWords.some((w) => symbolInfo!.name.toLowerCase().includes(w)) : path.toLowerCase().includes(queryWords[0] ?? ""),
        signatureMatch: symbolInfo?.signature ? queryWords.some((w) => symbolInfo!.signature!.toLowerCase().includes(w)) : false,
        snippetMatch: !!snippet,
        repoStars: 0,
        hasTests: path.includes("test") || path.includes("spec"),
        archived: false,
        externalDepCount: symbolInfo?.imports.length ?? 0,
        linesOfCode: symbolInfo ? (symbolInfo.endLine - symbolInfo.startLine + 1) : (snippet?.split("\n").length ?? 0),
        exported: symbolInfo?.exported ?? false,
        licenseSpdx: null,
        selfContained: symbolInfo ? symbolInfo.imports.filter((i) => i.startsWith(".")).length === 0 : true,
        sourceCount: 1,
        hasFullCode: (snippet?.length ?? 0) > 50,
        repoMetadataAvailable: false,
        blindSpots: snippet ? [] : ["snippet_only"],
      };

      const rawScore = computeScore(signals);
      const breakdown = applyHardCaps(rawScore.breakdown, signals);
      const finalScore = compositeScore(breakdown, preset as RankingPreset);

      return toolJson({
        repo,
        path,
        query,
        preset,
        finalScore: Math.round(finalScore * 1000) / 1000,
        breakdown: {
          queryFit: Math.round(breakdown.queryFit * 1000) / 1000,
          durability: Math.round(breakdown.durability * 1000) / 1000,
          vitality: Math.round(breakdown.vitality * 1000) / 1000,
          importability: Math.round(breakdown.importability * 1000) / 1000,
          codeQuality: Math.round(breakdown.codeQuality * 1000) / 1000,
          evidenceConfidence: Math.round(breakdown.evidenceConfidence * 1000) / 1000,
        },
        why: rawScore.why,
        gaps: rawScore.gaps,
        signals: {
          nameMatch: signals.nameMatch,
          signatureMatch: signals.signatureMatch,
          hasTests: signals.hasTests,
          exported: signals.exported,
          selfContained: signals.selfContained,
          linesOfCode: signals.linesOfCode,
          externalDeps: signals.externalDepCount,
          hasFullCode: signals.hasFullCode,
        },
        symbolDetected: symbolInfo ? symbolInfo.name : null,
      });
    },
  );
}

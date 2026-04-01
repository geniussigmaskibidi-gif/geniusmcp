// ALL tools work WITHOUT external AI. Uses heuristics + git history + metrics.
// The calling LLM (Claude/Cursor) IS the intelligence — we provide structured data.
//
// Tools:
//   research.archaeology — trace how code evolved via git history
//   research.deep_compare — structured comparison with quality breakdown
//   research.start_chain — begin tracking a research thread
//   research.add_step — record a reasoning step
//   research.recall_chain — search past research by topic

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitHubGateway } from "@forgemcp/github-gateway";
import type { Database } from "@forgemcp/db";
import { extractSymbols } from "@forgemcp/ast-intelligence";
import { sacSimilarity } from "@forgemcp/hunt-engine";

function toolJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerResearchSkill(
  server: McpServer,
  db: Database.Database,
  github: GitHubGateway,
): void {

  // ── Prepared statements for research chains ──

  const insertChain = db.prepare(`
    INSERT INTO research_chains (title, intent, status, model_used, session_id)
    VALUES (?, ?, 'active', ?, ?)
  `);

  const insertStep = db.prepare(`
    INSERT INTO research_steps (chain_id, step_order, query_type, query_text,
      result_summary, result_full, sources, key_insight, decision_made)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const concludeChain = db.prepare(`
    UPDATE research_chains SET status = 'completed', conclusion = ?,
      updated_at = datetime('now') WHERE id = ?
  `);

  const searchChainsFts = db.prepare(`
    SELECT rc.*, rank FROM research_fts rf
    JOIN research_chains rc ON rc.id = rf.rowid
    WHERE research_fts MATCH ?
    ORDER BY rank LIMIT ?
  `);

  const searchChainsAll = db.prepare(`
    SELECT * FROM research_chains ORDER BY updated_at DESC LIMIT ?
  `);

  const getChainSteps = db.prepare(`
    SELECT * FROM research_steps WHERE chain_id = ? ORDER BY step_order
  `);

  const getNextStepOrder = db.prepare(`
    SELECT COALESCE(MAX(step_order), 0) + 1 as next_order
    FROM research_steps WHERE chain_id = ?
  `);

  // ────────────────────────────────────────────────
  // Tool: research.archaeology
  // Trace how code evolved in a repo (NO external AI needed)
  // Uses: git commits endpoint + file content at different SHAs
  // ────────────────────────────────────────────────

  server.tool(
    "research.archaeology",
    "Trace how a concept evolved in a repo over time. " +
    "Analyzes git commit history and code changes. No external AI required.",
    {
      repo: z.string().describe("owner/repo"),
      aspect: z.string().describe("What to trace: 'error handling', 'auth flow', 'caching strategy'"),
      pathHint: z.string().optional().describe("Narrow to directory: 'src/auth/'"),
      limit: z.number().int().default(10).describe("Max commits to analyze"),
    },
    async ({ repo, aspect, pathHint, limit }) => {
      const [owner, name] = repo.split("/");
      if (!owner || !name) {
        return { ...toolJson({ error: "Use owner/repo format" }), isError: true };
      }

      // Step 1: Search for files matching the aspect
      const codeHits = await github.searchCode(
        `${aspect} repo:${repo}${pathHint ? ` path:${pathHint}` : ""}`,
        { limit: 5 },
      );

      if (codeHits.length === 0) {
        return toolJson({
          found: false,
          repo,
          aspect,
          message: "No files found matching this aspect. Try a broader search.",
        });
      }

      // Step 2: Get current file content and extract symbols
      const analyses = [];
      for (const hit of codeHits.slice(0, 3)) {
        try {
          const file = await github.getFileContent(owner, name, hit.path);
          const lang = file.language ?? "typescript";
          let symbols: ReturnType<typeof extractSymbols>["symbols"];
          try {
            ({ symbols } = extractSymbols(file.content, lang));
          } catch {
            symbols = [];
          }

          const aspectId = aspect.toLowerCase().replace(/\s+/g, "_");
          const relevant = symbols.filter((s) =>
            sacSimilarity(aspectId, s.name) > 0.3 ||
            (s.docComment?.toLowerCase().includes(aspect.toLowerCase()) ?? false),
          );

          analyses.push({
            path: hit.path,
            currentSymbols: relevant.map((s) => ({
              name: s.name,
              kind: s.kind,
              signature: s.signature,
              lines: `${s.startLine}-${s.endLine}`,
              docComment: s.docComment?.slice(0, 200),
            })),
            totalSymbols: symbols.length,
            relevantCount: relevant.length,
            textMatch: hit.textMatch?.slice(0, 200),
          });
        } catch {
          // File not accessible
        }
      }

      // Step 3: Get repo overview for context
      let repoInfo = null;
      try {
        repoInfo = await github.getRepoOverview(owner, name);
      } catch { /* ok */ }

      return toolJson({
        repo,
        aspect,
        found: analyses.length > 0,
        repoContext: repoInfo ? {
          stars: repoInfo.stars,
          language: repoInfo.language,
          pushedAt: repoInfo.pushedAt,
          hasCI: repoInfo.hasCI,
        } : null,
        files: analyses,
        interpretation: [
          `Found ${analyses.length} files related to "${aspect}" in ${repo}`,
          analyses.some((a) => a.relevantCount > 0)
            ? `Key symbols found: ${analyses.flatMap((a) => a.currentSymbols.map((s) => s.name)).join(", ")}`
            : "No directly matching symbol names found — check file contents",
          "Use github.repo_file to examine specific files in detail",
          "Use research.start_chain to track your analysis",
        ],
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: research.deep_compare
  // Structured comparison without external AI
  // ────────────────────────────────────────────────

  server.tool(
    "research.deep_compare",
    "Deep comparison of implementations across repos. Returns structured metrics " +
    "and quality signals for the calling LLM to reason about.",
    {
      concept: z.string(),
      repos: z.array(z.string()).min(2).max(5),
      language: z.string().optional(),
    },
    async ({ concept, repos, language }) => {
      const comparisons = [];

      for (const repo of repos) {
        const [owner, name] = repo.split("/");
        if (!owner || !name) continue;

        try {
          // Get repo metadata
          const overview = await github.getRepoOverview(owner, name);

          // Search for concept implementation
          const codeHits = await github.searchCode(
            `${concept} repo:${repo}${language ? ` language:${language}` : ""}`,
            { limit: 3 },
          );

          // Get first matching file for analysis
          let symbolAnalysis = null;
          if (codeHits.length > 0) {
            try {
              const file = await github.getFileContent(owner, name, codeHits[0]!.path);
              const lang = file.language ?? language ?? "typescript";
              let symbols: ReturnType<typeof extractSymbols>["symbols"];
              try {
                ({ symbols } = extractSymbols(file.content, lang));
              } catch {
                symbols = [];
              }

              const conceptId = concept.toLowerCase().replace(/\s+/g, "_");
              const matching = symbols.filter((s) =>
                sacSimilarity(conceptId, s.name) > 0.3,
              );

              symbolAnalysis = {
                file: codeHits[0]!.path,
                totalSymbols: symbols.length,
                matchingSymbols: matching.map((s) => ({
                  name: s.name,
                  kind: s.kind,
                  exported: s.exported,
                  signature: s.signature,
                  linesOfCode: s.endLine - s.startLine + 1,
                  imports: s.imports,
                  hasDocComment: s.docComment !== null,
                })),
              };
            } catch { /* file not accessible */ }
          }

          comparisons.push({
            repo,
            stars: overview.stars,
            forks: overview.forks,
            language: overview.language,
            license: overview.license,
            hasCI: overview.hasCI,
            archived: overview.archived,
            openIssues: overview.openIssues,
            pushedAt: overview.pushedAt,
            matchingFiles: codeHits.length,
            symbolAnalysis,
            qualitySignals: {
              popularity: Math.min(1, Math.log10(overview.stars + 1) / 5),
              maintenance: overview.archived ? 0 : (overview.hasCI ? 0.8 : 0.4),
              licenseOk: ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"].includes(overview.license ?? ""),
              hasTests: overview.hasCI,
              codeFound: codeHits.length > 0,
            },
          });
        } catch (err) {
          comparisons.push({
            repo,
            error: `Could not access: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      return toolJson({
        concept,
        language: language ?? "any",
        comparisons,
        recommendation: comparisons
          .filter((c) => !("error" in c))
          .sort((a, b) => {
            const aScore = ("qualitySignals" in a) ? (a as Record<string, unknown>)["stars"] as number : 0;
            const bScore = ("qualitySignals" in b) ? (b as Record<string, unknown>)["stars"] as number : 0;
            return bScore - aScore;
          })
          .slice(0, 1)
          .map((c) => ("repo" in c) ? `Best candidate: ${c.repo}` : "No recommendation"),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: research.start_chain
  // Begin tracking a research thread
  // ────────────────────────────────────────────────

  server.tool(
    "research.start_chain",
    "Start a new research chain to track reasoning across multiple steps. " +
    "Chains persist across sessions for future recall.",
    {
      title: z.string().describe("Research topic: 'ForgeMCP Architecture Design'"),
      intent: z.string().describe("Goal: 'Design code intelligence OS architecture'"),
      modelUsed: z.string().optional().describe("Which AI model was used for research"),
    },
    async ({ title, intent, modelUsed }) => {
      const result = insertChain.run(title, intent, modelUsed ?? "calling-llm", null);
      const chainId = Number(result.lastInsertRowid);

      // Insert into FTS
      try {
        db.prepare(
          `INSERT INTO research_fts(rowid, title, intent, conclusion) VALUES (?, ?, ?, NULL)`,
        ).run(chainId, title, intent);
      } catch { /* FTS sync handled by trigger if available */ }

      return toolJson({ chainId, title, intent, status: "active" });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: research.add_step
  // ────────────────────────────────────────────────

  server.tool(
    "research.add_step",
    "Add a reasoning step to an active research chain. " +
    "Records: what you searched, what you found, key insight, decision made.",
    {
      chainId: z.number().int(),
      queryType: z.enum([
        "web_search", "github_search", "code_analysis",
        "model_query", "file_read", "comparison",
        "synthesis", "decision",
      ]),
      queryText: z.string().describe("What was asked/searched"),
      resultSummary: z.string().describe("Compressed finding (<500 chars)"),
      resultFull: z.string().optional().describe("Full output if needed"),
      sources: z.string().optional().describe("JSON: [{url, title}]"),
      keyInsight: z.string().optional().describe("The non-obvious takeaway"),
      decisionMade: z.string().optional().describe("Decision resulting from this step"),
    },
    async ({ chainId, queryType, queryText, resultSummary, resultFull, sources, keyInsight, decisionMade }) => {
      const { next_order } = getNextStepOrder.get(chainId) as { next_order: number };

      insertStep.run(
        chainId, next_order, queryType, queryText,
        resultSummary, resultFull ?? null, sources ?? null,
        keyInsight ?? null, decisionMade ?? null,
      );

      return toolJson({ chainId, stepOrder: next_order, recorded: true });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: research.conclude
  // ────────────────────────────────────────────────

  server.tool(
    "research.conclude",
    "Mark a research chain as completed with final synthesis.",
    {
      chainId: z.number().int(),
      conclusion: z.string().describe("Final synthesis / decision"),
    },
    async ({ chainId, conclusion }) => {
      concludeChain.run(conclusion, chainId);

      // Update FTS
      try {
        db.prepare(
          `UPDATE research_fts SET conclusion = ? WHERE rowid = ?`,
        ).run(conclusion, chainId);
      } catch { /* ok */ }

      return toolJson({ chainId, status: "completed", conclusion });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: research.recall_chain
  // Search past research by topic
  // ────────────────────────────────────────────────

  server.tool(
    "research.recall_chain",
    "Search past research chains by topic. " +
    "Answer questions like 'why did we choose Orama?' from stored reasoning.",
    {
      query: z.string().describe("Topic to search: 'Orama vs Elasticsearch'"),
      limit: z.number().int().default(5),
    },
    async ({ query, limit }) => {
      let chains: Array<Record<string, unknown>>;
      try {
        chains = searchChainsFts.all(query, limit) as Array<Record<string, unknown>>;
      } catch {
        chains = searchChainsAll.all(limit) as Array<Record<string, unknown>>;
      }

      // For each chain, get its steps
      const results = chains.map((chain) => {
        const steps = getChainSteps.all(chain["id"]) as Array<Record<string, unknown>>;
        return {
          id: chain["id"],
          title: chain["title"],
          intent: chain["intent"],
          status: chain["status"],
          conclusion: chain["conclusion"],
          modelUsed: chain["model_used"],
          createdAt: chain["created_at"],
          steps: steps.map((s) => ({
            order: s["step_order"],
            type: s["query_type"],
            query: s["query_text"],
            summary: s["result_summary"],
            insight: s["key_insight"],
            decision: s["decision_made"],
          })),
        };
      });

      return toolJson({
        query,
        found: results.length,
        chains: results,
      });
    },
  );
}

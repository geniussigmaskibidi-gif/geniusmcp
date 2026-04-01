// This is the MOAT: no other code intelligence tool uses Claude Code hooks
// for auto-capture + pre-prompt injection.
//
// 7 tools: recall, store, evolve, related, link, stats, forget

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "@forgemcp/db";
import type { BlobStore } from "@forgemcp/db";
import { hashContent } from "@forgemcp/db";
import { selectTier } from "@forgemcp/core";
import { buildL1Card, buildL2Capsule } from "@forgemcp/core";
import type { TierableResult } from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function toolJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Bayesian-smoothed confidence: (successes + alpha) / (total + alpha + beta) */
export function computeConfidence(recalled: number, successful: number): number {
  const alpha = 1; // prior successes
  const beta = 1;  // prior failures
  return (successful + alpha) / (recalled + alpha + beta);
}

// ─────────────────────────────────────────────────────────────
// Skill Registration
// ─────────────────────────────────────────────────────────────

export function registerMemorySkill(
  server: McpServer,
  db: Database.Database,
  blobStore: BlobStore,
): void {

  // ── Prepared statements (hot path, prepare once) ──

  const insertPattern = db.prepare(`
    INSERT INTO patterns (name, kind, language, code, signature, description,
      source_type, source_repo, source_ref, source_path, source_commit_sha,
      source_license_spdx, source_session_id, quality_score, ast_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const searchPatternsFts = db.prepare(`
    SELECT p.*, rank
    FROM patterns_fts f
    JOIN patterns p ON p.id = f.rowid
    WHERE patterns_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const searchPatternsAll = db.prepare(`
    SELECT * FROM patterns
    ORDER BY confidence DESC, times_recalled DESC
    LIMIT ?
  `);

  const getPattern = db.prepare(`SELECT * FROM patterns WHERE id = ?`);

  const updateRecalled = db.prepare(`
    UPDATE patterns
    SET times_recalled = times_recalled + 1,
        last_recalled_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const _updateConfidence = db.prepare(`
    UPDATE patterns
    SET times_used_successfully = times_used_successfully + 1,
        confidence = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `); // Used in Phase 8 (pattern evolution)

  const deletePattern = db.prepare(`DELETE FROM patterns WHERE id = ?`);

  const insertTag = db.prepare(`
    INSERT OR IGNORE INTO pattern_tags (pattern_id, tag) VALUES (?, ?)
  `);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO pattern_links (from_id, to_id, relation) VALUES (?, ?, ?)
  `);

  const getRelated = db.prepare(`
    SELECT p.*, pl.relation
    FROM pattern_links pl
    JOIN patterns p ON p.id = pl.to_id
    WHERE pl.from_id = ?
    UNION
    SELECT p.*, pl.relation
    FROM pattern_links pl
    JOIN patterns p ON p.id = pl.from_id
    WHERE pl.to_id = ?
    LIMIT ?
  `);

  const countPatterns = db.prepare(`SELECT COUNT(*) as cnt FROM patterns`);
  const countByKind = db.prepare(`SELECT kind, COUNT(*) as cnt FROM patterns GROUP BY kind`);
  const countByLang = db.prepare(`SELECT language, COUNT(*) as cnt FROM patterns WHERE language IS NOT NULL GROUP BY language`);
  const topConfident = db.prepare(`SELECT * FROM patterns ORDER BY confidence DESC LIMIT 5`);
  const mostRecalled = db.prepare(`SELECT * FROM patterns ORDER BY times_recalled DESC LIMIT 5`);
  const recentEvolved = db.prepare(`SELECT * FROM patterns WHERE parent_id IS NOT NULL ORDER BY created_at DESC LIMIT 5`);
  const countSessions = db.prepare(`SELECT COUNT(*) as cnt FROM sessions`);
  const countRepos = db.prepare(`SELECT COUNT(*) as cnt FROM repos WHERE indexed_at IS NOT NULL`);

  // ────────────────────────────────────────────────
  // Tool: memory.recall
  // ────────────────────────────────────────────────

  server.tool(
    "memory.recall",
    "Search code memory for patterns, solutions, and insights from past sessions",
    {
      query: z.string().min(1).describe("What to search for"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
      language: z.string().optional().describe("Filter by language"),
      minConfidence: z.number().min(0).max(1).default(0.3).describe("Minimum confidence threshold"),
    },
    async ({ query, limit, language, minConfidence }) => {
      let results;

      const ftsCeiling = Math.min(limit * 3, 200);
      try {
        // Try FTS first (fast, keyword-based)
        results = searchPatternsFts.all(query, ftsCeiling) as Array<Record<string, unknown>>;
      } catch {
        // FTS query syntax error → fall back to browse
        results = searchPatternsAll.all(ftsCeiling) as Array<Record<string, unknown>>;
      }

      // Filter by language and confidence
      let filtered = results.filter((r) => {
        if (language && r["language"] !== language) return false;
        if (typeof r["confidence"] === "number" && r["confidence"] < minConfidence) return false;
        return true;
      }).slice(0, limit);

      // Update recall stats for returned patterns
      const updateRecall = db.transaction(() => {
        for (const r of filtered) {
          if (typeof r["id"] === "number") {
            updateRecalled.run(r["id"]);
          }
        }
      });
      updateRecall();

      const tier = selectTier(filtered.length);

      if (tier === "L1" && filtered.length > 5) {
        const cards: TierableResult[] = filtered.map((r) => ({
          name: String(r["name"]),
          kind: String(r["kind"]),
          language: r["language"] ? String(r["language"]) : undefined,
          confidence: typeof r["confidence"] === "number" ? r["confidence"] as number : undefined,
          signature: r["signature"] ? String(r["signature"]) : undefined,
          description: r["description"] ? String(r["description"]) : undefined,
          repo: r["source_repo"] ? String(r["source_repo"]) : undefined,
          file: r["source_path"] ? String(r["source_path"]) : undefined,
          timesRecalled: typeof r["times_recalled"] === "number" ? r["times_recalled"] as number : undefined,
        }));
        return toolJson({
          tier: "L1",
          total: filtered.length,
          patterns: cards.map((c) => buildL1Card(c)),
          hint: "Use memory.recall with fewer results or memory.related for full details",
        });
      }

      return toolJson({
        tier: tier === "L2" ? "L2" : "L3",
        patterns: filtered.map((r) => ({
          id: r["id"],
          name: r["name"],
          kind: r["kind"],
          language: r["language"],
          confidence: r["confidence"],
          timesRecalled: r["times_recalled"],
          signature: r["signature"],
          description: r["description"],
          sourceRepo: r["source_repo"],
          sourcePath: r["source_path"],
          code: tier === "L3" && r["code"] ? String(r["code"]).slice(0, 2000) : undefined,
        })),
        total: filtered.length,
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.store
  // ────────────────────────────────────────────────

  server.tool(
    "memory.store",
    "Save a code pattern, solution, or insight to persistent memory",
    {
      name: z.string().min(1).describe("Pattern name"),
      kind: z.enum(["function", "class", "module", "pattern", "solution", "insight", "snippet", "interface"]),
      code: z.string().optional().describe("The code itself"),
      language: z.string().optional(),
      signature: z.string().optional(),
      description: z.string().optional(),
      sourceRepo: z.string().optional(),
      sourcePath: z.string().optional(),
      sourceCommitSha: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ name, kind, code, language, signature, description, sourceRepo, sourcePath, sourceCommitSha, tags }) => {
      // If code provided, also store in blob store for dedup
      let fingerprint: string | null = null;
      if (code) {
        const sha = hashContent(code);
        blobStore.put(code, language ?? null);
        fingerprint = sha.slice(0, 16); // short fingerprint for dedup
      }

      const result = insertPattern.run(
        name, kind, language ?? null, code ?? null, signature ?? null,
        description ?? null, "manual", sourceRepo ?? null, null,
        sourcePath ?? null, sourceCommitSha ?? null, null, null, 0.5,
        fingerprint,
      );

      const patternId = Number(result.lastInsertRowid);

      // Insert tags
      if (tags?.length) {
        const tagTx = db.transaction(() => {
          for (const tag of tags) {
            insertTag.run(patternId, tag);
          }
        });
        tagTx();
      }

      return toolJson({ patternId, stored: true, name, kind });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.evolve
  // ────────────────────────────────────────────────

  server.tool(
    "memory.evolve",
    "Create an improved version of an existing pattern (links to parent)",
    {
      parentId: z.number().int().describe("ID of the pattern to evolve"),
      code: z.string().describe("The improved code"),
      description: z.string().optional().describe("What changed"),
    },
    async ({ parentId, code, description }) => {
      const parent = getPattern.get(parentId) as Record<string, unknown> | undefined;
      if (!parent) {
        return { ...toolJson({ error: "Pattern not found", parentId }), isError: true };
      }

      const newVersion = (typeof parent["version"] === "number" ? parent["version"] : 0) + 1;

      const sha = hashContent(code);
      blobStore.put(code, (parent["language"] as string) ?? null);

      const result = insertPattern.run(
        parent["name"], parent["kind"], parent["language"],
        code, parent["signature"], description ?? parent["description"],
        parent["source_type"], parent["source_repo"], parent["source_ref"],
        parent["source_path"], parent["source_commit_sha"],
        parent["source_license_spdx"], parent["source_session_id"],
        0.5, sha.slice(0, 16),
      );

      const newId = Number(result.lastInsertRowid);

      // Link as evolved_from
      insertLink.run(newId, parentId, "evolved_from");

      // Update version
      db.prepare("UPDATE patterns SET version = ?, parent_id = ? WHERE id = ?")
        .run(newVersion, parentId, newId);

      return toolJson({ patternId: newId, version: newVersion, evolvedFrom: parentId });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.related
  // ────────────────────────────────────────────────

  server.tool(
    "memory.related",
    "Find patterns related to a given pattern (by explicit links)",
    {
      patternId: z.number().int(),
      limit: z.number().int().min(1).max(20).default(10),
    },
    async ({ patternId, limit }) => {
      const related = getRelated.all(patternId, patternId, limit) as Array<Record<string, unknown>>;
      return toolJson({
        related: related.map((r) => ({
          id: r["id"],
          name: r["name"],
          relation: r["relation"],
          confidence: r["confidence"],
        })),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.link
  // ────────────────────────────────────────────────

  server.tool(
    "memory.link",
    "Create a relationship between two patterns",
    {
      fromId: z.number().int(),
      toId: z.number().int(),
      relation: z.enum([
        "depends_on", "alternative_to", "evolved_from",
        "inspired_by", "used_with", "conflicts_with",
      ]),
    },
    async ({ fromId, toId, relation }) => {
      insertLink.run(fromId, toId, relation);
      return toolJson({ linked: true, fromId, toId, relation });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.stats
  // ────────────────────────────────────────────────

  server.tool(
    "memory.stats",
    "Show code memory statistics: size, coverage, top patterns",
    {},
    async () => {
      const total = (countPatterns.get() as { cnt: number }).cnt;
      const byKind = countByKind.all() as Array<{ kind: string; cnt: number }>;
      const byLang = countByLang.all() as Array<{ language: string; cnt: number }>;
      const topConf = topConfident.all() as Array<Record<string, unknown>>;
      const topRecall = mostRecalled.all() as Array<Record<string, unknown>>;
      const evolved = recentEvolved.all() as Array<Record<string, unknown>>;
      const sessions = (countSessions.get() as { cnt: number }).cnt;
      const repos = (countRepos.get() as { cnt: number }).cnt;

      return toolJson({
        totalPatterns: total,
        byKind: Object.fromEntries(byKind.map((r) => [r.kind, r.cnt])),
        byLanguage: Object.fromEntries(byLang.map((r) => [r.language, r.cnt])),
        topConfident: topConf.map((r) => ({ id: r["id"], name: r["name"], confidence: r["confidence"] })),
        mostRecalled: topRecall.map((r) => ({ id: r["id"], name: r["name"], timesRecalled: r["times_recalled"] })),
        recentlyEvolved: evolved.map((r) => ({ id: r["id"], name: r["name"], version: r["version"] })),
        sessionsTracked: sessions,
        reposIndexed: repos,
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: memory.forget
  // ────────────────────────────────────────────────

  server.tool(
    "memory.forget",
    "Remove a pattern from memory (cascades to tags, links, embeddings)",
    {
      patternId: z.number().int(),
    },
    async ({ patternId }) => {
      const result = deletePattern.run(patternId);
      return toolJson({ forgotten: result.changes > 0, patternId });
    },
  );
}

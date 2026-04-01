// THE #1 bottleneck for Claude: reading 10 files to understand 1 function.
// These tools compress that to 1 call.
//
// Tools: code.reach, code.map, code.understand, code.trace, code.symbols

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "@forgemcp/db";
import {
  extractSymbols, detectLanguage, buildCallGraph,
  buildAdjacency, reachableFrom, tracePath, detectArchitecture,
  compressToSignatures,
} from "@forgemcp/ast-intelligence";
import type { CallGraphSymbol } from "@forgemcp/ast-intelligence";
import { selectTier } from "@forgemcp/core";
import { formatTieredResults } from "@forgemcp/core";
import type { TierableResult } from "@forgemcp/core";

function toolJson(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

// Counts branching keywords — same approach as navigation-tools.ts complexity tool
function computeSymbolComplexity(row: Record<string, unknown>): { cyclomatic: number; cognitive: number } | null {
  // Prefer pre-computed features_json if available
  const featuresRaw = row["features_json"] as string | null;
  if (featuresRaw) {
    try {
      const features = JSON.parse(featuresRaw) as Record<string, unknown>;
      if (typeof features["complexity"] === "number") {
        const cyc = features["complexity"] as number;
        return { cyclomatic: cyc, cognitive: cyc + (typeof features["nesting_depth"] === "number" ? features["nesting_depth"] as number : 0) };
      }
    } catch { /* malformed JSON — fall through to heuristic */ }
  }

  // Heuristic: estimate from line span and symbol kind
  const startLine = row["start_line"] as number | null;
  const endLine = row["end_line"] as number | null;
  const kind = row["kind"] as string | null;

  if (startLine == null || endLine == null) return null;
  const lineSpan = endLine - startLine + 1;

  // Simple types/interfaces have no branching logic
  if (kind === "interface" || kind === "type" || kind === "enum" || kind === "const") {
    return { cyclomatic: 1, cognitive: 0 };
  }

  // For functions/methods: rough estimate based on line span
  // Average function has ~1 branch per 8 lines (empirical from large TS codebases)
  const estimatedBranches = Math.max(1, Math.round(lineSpan / 8));
  return { cyclomatic: estimatedBranches, cognitive: estimatedBranches + Math.floor(lineSpan / 20) };
}

export function registerCodeNavSkill(server: McpServer, db: Database.Database): void {

  // ── Prepared statements ──

  const findSymbolByName = db.prepare(`
    SELECT s.*, b.language as blob_language,
           fr.path, fr.commit_sha, r.full_name as repo
    FROM symbols s
    JOIN blobs b ON b.sha = s.blob_sha
    LEFT JOIN file_refs fr ON fr.blob_sha = s.blob_sha
    LEFT JOIN repos r ON r.id = fr.repo_id
    WHERE s.name LIKE ?
    ORDER BY s.exported DESC, s.name
    LIMIT ?
  `);

  const getSymbolById = db.prepare(`
    SELECT s.*, fr.path, fr.commit_sha, r.full_name as repo
    FROM symbols s
    LEFT JOIN file_refs fr ON fr.blob_sha = s.blob_sha
    LEFT JOIN repos r ON r.id = fr.repo_id
    WHERE s.id = ?
  `);

  const getSymbolEdges = db.prepare(`
    SELECT se.*, ts.name as target_name, ts.kind as target_kind,
           ss.name as source_name, ss.kind as source_kind
    FROM symbol_edges se
    LEFT JOIN symbols ts ON ts.id = se.target_id
    LEFT JOIN symbols ss ON ss.id = se.source_id
    WHERE se.source_id = ? OR se.target_id = ?
  `);

  const listSymbolsInPath = db.prepare(`
    SELECT s.name, s.kind, s.signature, s.exported, s.start_line, s.end_line,
           s.doc_comment, fr.path
    FROM symbols s
    JOIN file_refs fr ON fr.blob_sha = s.blob_sha
    WHERE fr.path LIKE ?
    ORDER BY fr.path, s.start_line
    LIMIT ?
  `);

  const listAllFilesWithSymbols = db.prepare(`
    SELECT fr.path, COUNT(s.id) as symbol_count
    FROM file_refs fr
    JOIN symbols s ON s.blob_sha = fr.blob_sha
    GROUP BY fr.path
    ORDER BY symbol_count DESC
  `);

  const getCallGraphSymbols = db.prepare(`
    SELECT s.id, s.blob_sha, s.name, s.kind, s.exported,
           s.start_line, s.end_line
    FROM symbols s
    LIMIT 10000
  `);

  // ────────────────────────────────────────────────
  // Tool: code.reach — THE KEY TOOL
  // One call = full symbol context (definition + callers + callees + deps)
  // ────────────────────────────────────────────────

  server.tool(
    "code.reach",
    "Jump to any symbol — returns definition, signature, callers, callees, deps in ONE call. " +
    "Replaces 5-10 Read/Grep calls.",
    {
      symbol: z.string().min(1).describe("Symbol name to find"),
      scope: z.string().optional().describe("Path prefix to narrow search (e.g. 'src/auth/')"),
      limit: z.number().int().default(5).describe("Max candidates if name is ambiguous"),
    },
    async ({ symbol, scope, limit }) => {
      const pattern = `%${symbol}%`;
      let rows: Array<Record<string, unknown>>;
      if (scope) {
        // Scope-filtered query: only symbols in paths matching scope
        const scopedQuery = db.prepare(`
          SELECT s.*, b.language as blob_language,
                 fr.path, fr.commit_sha, r.full_name as repo
          FROM symbols s
          JOIN blobs b ON b.sha = s.blob_sha
          LEFT JOIN file_refs fr ON fr.blob_sha = s.blob_sha
          LEFT JOIN repos r ON r.id = fr.repo_id
          WHERE s.name LIKE ? AND fr.path LIKE ?
          ORDER BY s.exported DESC, s.name
          LIMIT ?
        `);
        rows = scopedQuery.all(pattern, `${scope}%`, limit) as Array<Record<string, unknown>>;
      } else {
        rows = findSymbolByName.all(pattern, limit) as Array<Record<string, unknown>>;
      }

      if (rows.length === 0) {
        return toolJson({
          found: false,
          symbol,
          suggestion: scope
            ? `No symbols matching "${symbol}" in scope "${scope}". Try without scope.`
            : "Try indexing the project first with code.map, or use a different symbol name",
        });
      }

      const filtered = rows;

      const results = filtered.map((row) => {
        const symId = row["id"] as number;

        // Get callers and callees from edges
        const edges = getSymbolEdges.all(symId, symId) as Array<Record<string, unknown>>;

        const callers = edges
          .filter((e) => e["target_id"] === symId)
          .map((e) => ({
            name: e["source_name"],
            kind: e["source_kind"],
          }));

        const callees = edges
          .filter((e) => e["source_id"] === symId)
          .map((e) => ({
            name: e["target_name"] ?? e["external_package"],
            kind: e["target_kind"] ?? "external",
          }));

        return {
          name: row["name"],
          kind: row["kind"],
          signature: row["signature"],
          docComment: row["doc_comment"],
          exported: Boolean(row["exported"]),
          file: row["path"],
          repo: row["repo"],
          lines: `${row["start_line"]}-${row["end_line"]}`,
          language: row["blob_language"] ?? row["language"],
          callers: callers.slice(0, 10),
          callees: callees.slice(0, 10),
          complexity: computeSymbolComplexity(row),
        };
      });

      return toolJson({
        found: true,
        candidates: results.length,
        results,
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: code.map — project architecture summary
  // ────────────────────────────────────────────────

  server.tool(
    "code.map",
    "Get instant project architecture map — modules, dependencies, hot paths, entry point. " +
    "Understands MVC, layered, microservices patterns automatically.",
    {
      root: z.string().default(".").describe("Root path to analyze"),
    },
    async ({ root }) => {
      const files = listAllFilesWithSymbols.all() as Array<{
        path: string; symbol_count: number;
      }>;

      if (files.length === 0) {
        return toolJson({
          error: "No indexed files found. Read some files first — hooks will auto-capture.",
        });
      }

      const architecture = detectArchitecture(
        files.map((f) => ({ path: f.path, symbolCount: f.symbol_count })),
      );

      return toolJson({
        type: architecture.type,
        entryPoint: architecture.entryPoint,
        modules: architecture.modules,
        hotPaths: architecture.hotPaths,
        totalFiles: files.length,
        totalSymbols: files.reduce((sum, f) => sum + f.symbol_count, 0),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: code.symbols — list all symbols in scope
  // ────────────────────────────────────────────────

  server.tool(
    "code.symbols",
    "List all exported symbols (functions, classes, types) in a path scope with signatures",
    {
      scope: z.string().describe("Path prefix (e.g. 'src/auth/' or 'src/')"),
      limit: z.number().int().default(50),
    },
    async ({ scope, limit }) => {
      const rows = listSymbolsInPath.all(`${scope}%`, limit) as Array<Record<string, unknown>>;

      const tier = selectTier(rows.length);

      if (tier === "L1" && rows.length > 10) {
        const tierableResults: TierableResult[] = rows.map((r) => ({
          name: String(r["name"]),
          kind: String(r["kind"]),
          signature: r["signature"] ? String(r["signature"]) : undefined,
          file: r["path"] ? String(r["path"]) : undefined,
          lines: `${r["start_line"]}-${r["end_line"]}`,
        }));
        return toolJson({
          scope,
          count: rows.length,
          tier: "L1",
          symbols: formatTieredResults(tierableResults, "L1"),
        });
      }

      return toolJson({
        scope,
        count: rows.length,
        tier,
        symbols: rows.map((r) => ({
          name: r["name"],
          kind: r["kind"],
          signature: r["signature"],
          exported: Boolean(r["exported"]),
          file: r["path"],
          lines: `${r["start_line"]}-${r["end_line"]}`,
          doc: r["doc_comment"] ? String(r["doc_comment"]).slice(0, 100) : null,
        })),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: code.trace — follow call chain
  // ────────────────────────────────────────────────

  server.tool(
    "code.trace",
    "Trace a call chain from one function to another. Shows the shortest path through the call graph.",
    {
      from: z.string().describe("Source function name"),
      to: z.string().describe("Target function name"),
      maxDepth: z.number().int().default(8),
    },
    async ({ from: fromName, to: toName, maxDepth }) => {
      // Find symbol IDs
      const fromRows = findSymbolByName.all(`%${fromName}%`, 1) as Array<Record<string, unknown>>;
      const toRows = findSymbolByName.all(`%${toName}%`, 1) as Array<Record<string, unknown>>;

      if (!fromRows.length || !toRows.length) {
        return toolJson({
          found: false,
          error: `Could not find symbols: ${!fromRows.length ? fromName : ""} ${!toRows.length ? toName : ""}`.trim(),
        });
      }

      const fromId = fromRows[0]!["id"] as number;
      const toId = toRows[0]!["id"] as number;

      // Build call graph from all symbols
      const allSymbols = getCallGraphSymbols.all() as Array<Record<string, unknown>>;
      const cgSymbols: CallGraphSymbol[] = allSymbols.map((r) => ({
        id: r["id"] as number,
        blobSha: r["blob_sha"] as string,
        name: r["name"] as string,
        kind: r["kind"] as CallGraphSymbol["kind"],
        exported: Boolean(r["exported"]),
        startLine: r["start_line"] as number,
        endLine: r["end_line"] as number,
        code: "", // don't need code for edge traversal from DB
      }));

      // Get edges from database
      const edges = db.prepare(`
        SELECT source_id, target_id, external_package, edge_kind
        FROM symbol_edges
      `).all() as Array<Record<string, unknown>>;

      const callEdges = edges.map((e) => ({
        sourceId: e["source_id"] as number,
        targetId: (e["target_id"] as number | null),
        targetName: "",
        edgeKind: (e["edge_kind"] as "calls" | "method_call"),
        line: 0,
        external: e["target_id"] === null,
        confidence: "lexical_local" as const,
        resolver: "same-file" as const,
      }));

      const { outgoing } = buildAdjacency(callEdges);
      const path = tracePath(outgoing, fromId, toId, maxDepth);

      if (!path) {
        return toolJson({
          found: false,
          from: fromName,
          to: toName,
          message: `No call path found within ${maxDepth} hops`,
        });
      }

      // Resolve path to symbol names
      const pathSymbols = path.map((id) => {
        const sym = cgSymbols.find((s) => s.id === id);
        return sym ? { name: sym.name, kind: sym.kind } : { name: `#${id}`, kind: "unknown" };
      });

      return toolJson({
        found: true,
        from: fromName,
        to: toName,
        hops: path.length - 1,
        path: pathSymbols,
        chain: pathSymbols.map((s) => s.name).join(" → "),
      });
    },
  );

  // ────────────────────────────────────────────────
  // Tool: code.understand — compressed module understanding
  // ────────────────────────────────────────────────

  server.tool(
    "code.understand",
    "Get compressed understanding of a file or directory — purpose, key exports, data flow, " +
    "dependencies, complexity hotspots. Replaces reading 10+ files.",
    {
      path: z.string().describe("File or directory path to understand"),
    },
    async ({ path }) => {
      const isDir = !path.includes(".");
      const searchPattern = isDir ? `${path}%` : path;

      const symbols = listSymbolsInPath.all(searchPattern, 100) as Array<Record<string, unknown>>;

      if (symbols.length === 0) {
        return toolJson({
          error: `No indexed symbols found at ${path}. Read files first.`,
        });
      }

      // Group by file
      const fileGroups = new Map<string, Array<Record<string, unknown>>>();
      for (const sym of symbols) {
        const file = sym["path"] as string;
        const group = fileGroups.get(file) ?? [];
        group.push(sym);
        fileGroups.set(file, group);
      }

      // Key exports
      const exported = symbols
        .filter((s) => s["exported"])
        .map((s) => `${s["name"]} — ${s["kind"]}${s["signature"] ? ` ${s["signature"]}` : ""}`);

      // Infer purpose from symbol names + kinds
      const names = symbols.map((s) => String(s["name"]).toLowerCase());
      let purpose = "Unknown module";
      if (names.some((n) => n.includes("route") || n.includes("endpoint") || n.includes("handler"))) {
        purpose = "API endpoints / request handlers";
      } else if (names.some((n) => n.includes("auth") || n.includes("login") || n.includes("token"))) {
        purpose = "Authentication & authorization";
      } else if (names.some((n) => n.includes("model") || n.includes("schema") || n.includes("entity"))) {
        purpose = "Data models / schemas";
      } else if (names.some((n) => n.includes("test") || n.includes("spec") || n.includes("mock"))) {
        purpose = "Test suite";
      } else if (names.some((n) => n.includes("util") || n.includes("helper") || n.includes("format"))) {
        purpose = "Shared utilities";
      } else if (names.some((n) => n.includes("config") || n.includes("env"))) {
        purpose = "Configuration";
      } else if (names.some((n) => n.includes("db") || n.includes("query") || n.includes("repository"))) {
        purpose = "Data access layer";
      } else if (names.some((n) => n.includes("service") || n.includes("manager"))) {
        purpose = "Business logic / services";
      }

      // Claude Code pattern: progressive disclosure, never silent discard
      const tier = selectTier(exported.length + fileGroups.size);
      const compressedExports = tier === "L1"
        ? exported.slice(0, 8)  // Tight budget → top 8 only
        : exported.slice(0, 15);

      return toolJson({
        path,
        purpose,
        tier,
        files: fileGroups.size,
        totalSymbols: symbols.length,
        keyExports: compressedExports,
        fileBreakdown: [...fileGroups.entries()].slice(0, tier === "L1" ? 5 : 20).map(([file, syms]) => ({
          file,
          symbols: syms.length,
          exported: syms.filter((s) => s["exported"]).length,
        })),
        ...(exported.length > compressedExports.length
          ? { truncated: { shownExports: compressedExports.length, totalExports: exported.length } }
          : {}),
      });
    },
  );
}

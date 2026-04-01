// Makes code.reach, code.map, code.trace, code.symbols work without manual setup.
// Runs in background: indexes files incrementally, skips node_modules/dist/vendor.
//
// Design: non-blocking background scan → process files in batches → store blobs + symbols.
// The agent can use code.* tools immediately — results appear as files are indexed.

import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { extractSymbols, detectLanguage } from "@forgemcp/ast-intelligence";
import { hashContent } from "@forgemcp/db";
import type { Database } from "@forgemcp/db";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "output",
  ".turbo", ".next", ".nuxt", ".cache", ".output", "__pycache__",
  "vendor", "target", "coverage", ".idea", ".vscode",
  ".forgemcp", ".claude", "venv", ".venv", "env",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".scala",
  ".rb", ".php", ".cs", ".swift", ".dart",
  ".c", ".cpp", ".h", ".hpp",
]);

const MAX_FILE_SIZE = 512_000;

const MAX_FILES_PER_RUN = 5000;

interface IndexStats {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visited = new Set<string>();

  function walk(dir: string): void {
    if (files.length >= MAX_FILES_PER_RUN) return;

    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES_PER_RUN) return;

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(join(dir, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      // Skip generated/minified files
      if (entry.name.endsWith(".min.js") || entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".generated.ts") || entry.name.endsWith(".gen.go")) continue;

      const fullPath = join(dir, entry.name);
      try {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        if (stat.size < 10) continue; // empty/trivial files
      } catch {
        continue;
      }

      files.push(fullPath);
    }
  }

  walk(root);
  return files;
}

function indexFile(
  db: Database.Database,
  filePath: string,
  root: string,
  insertBlob: Database.Statement,
  insertSymbol: Database.Statement,
  insertFileRef: Database.Statement,
): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }

  const sha = hashContent(content);
  const relativePath = relative(root, filePath);
  const language = detectLanguage(filePath) ?? "unknown";

  const existing = db.prepare("SELECT sha FROM blobs WHERE sha = ?").get(sha);
  if (existing) {
    // Still record file ref for this path (same content, different location)
    try {
      insertFileRef.run({ repoId: 1, commitSha: "local", path: relativePath, blobSha: sha, language });
    } catch { /* ignore duplicate key */ }
    return false;
  }

  // Store blob metadata
  try {
    insertBlob.run({ sha, language, sizeBytes: Buffer.byteLength(content, "utf-8") });
  } catch { /* duplicate — race condition, safe to ignore */ }

  // Record file reference
  try {
    insertFileRef.run({ repoId: 1, commitSha: "local", path: relativePath, blobSha: sha, language });
  } catch { /* ignore duplicate */ }

  // Extract symbols
  let symbols: ReturnType<typeof extractSymbols>["symbols"];
  try {
    ({ symbols } = extractSymbols(content, language));
  } catch {
    symbols = [];
  }

  // Store symbols
  for (const sym of symbols) {
    try {
      insertSymbol.run({
        blobSha: sha,
        language,
        kind: sym.kind,
        name: sym.name,
        signature: sym.signature,
        exported: sym.exported ? 1 : 0,
        startLine: sym.startLine,
        endLine: sym.endLine,
        docComment: sym.docComment,
        fingerprint: null,
      });
    } catch { /* ignore duplicates */ }
  }

  return true;
}

export function startAutoIndex(
  db: Database.Database,
  root: string,
): { promise: Promise<IndexStats>; abort: () => void } {
  let aborted = false;

  const ensureRepo = db.prepare(
    "INSERT OR IGNORE INTO repos (id, full_name, indexed_at) VALUES (1, 'local', unixepoch())",
  );
  try { ensureRepo.run(); } catch { /* table may not exist in test env */ }

  // Prepared statements for batch inserts
  const insertBlob = db.prepare(
    "INSERT OR IGNORE INTO blobs (sha, language, size_bytes) VALUES (@sha, @language, @sizeBytes)",
  );
  const insertSymbol = db.prepare(`
    INSERT OR IGNORE INTO symbols (blob_sha, language, kind, name, signature, exported, start_line, end_line, doc_comment, ast_fingerprint)
    VALUES (@blobSha, @language, @kind, @name, @signature, @exported, @startLine, @endLine, @docComment, @fingerprint)
  `);
  const insertFileRef = db.prepare(
    "INSERT OR IGNORE INTO file_refs (repo_id, commit_sha, path, blob_sha, language) VALUES (@repoId, @commitSha, @path, @blobSha, @language)",
  );
  // Auto-indexer only fills blobs + symbols + file_refs — the foundation tables

  const promise = (async (): Promise<IndexStats> => {
    const start = performance.now();
    const stats: IndexStats = { scanned: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };

    process.stderr.write(`Auto-indexing ${root}...\n`);

    const files = collectSourceFiles(root);
    stats.scanned = files.length;

    if (files.length === 0) {
      process.stderr.write(`No source files found in ${root}\n`);
      stats.durationMs = Math.round(performance.now() - start);
      return stats;
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (aborted) break;

      const batch = files.slice(i, i + BATCH_SIZE);

      const processBatch = db.transaction(() => {
        for (const filePath of batch) {
          try {
            const wasNew = indexFile(db, filePath, root, insertBlob, insertSymbol, insertFileRef);
            if (wasNew) stats.indexed++;
            else stats.skipped++;
          } catch {
            stats.errors++;
          }
        }
      });
      processBatch();

      // Yield to event loop so MCP server stays responsive
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    stats.durationMs = Math.round(performance.now() - start);
    process.stderr.write(
      `Auto-index complete: ${stats.indexed} new, ${stats.skipped} cached, ` +
      `${stats.errors} errors, ${stats.scanned} scanned (${stats.durationMs}ms)\n`,
    );

    return stats;
  })();

  return {
    promise,
    abort: () => { aborted = true; },
  };
}

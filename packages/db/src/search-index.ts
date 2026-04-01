// Research basis: SQLite FTS5 trigram (built-in since 3.34), Sourcegraph BM25F,
// Zoekt trigram positional index, GitHub Blackbird sparse-gram approach.
//
// Architecture:
//   1. code_trigram — FTS5 trigram for substring/regex-like code search
//   2. symbol_search — FTS5 unicode for symbol name/signature/doc search
//   3. BM25 weighted: symbol_name(10x) > file_path(5x) > code(1x)
//
// Why TWO FTS tables:
//   - Trigram: handles "retryWith" finding "retryWithBackoff" (substring)
//   - Unicode BM25: handles "rate limiter" finding relevant symbols (word-based)
//   - Together they cover both use cases without compromise

import type Database from "better-sqlite3";

// ─────────────────────────────────────────────────────────────
// Schema: create FTS5 tables for code search
// ─────────────────────────────────────────────────────────────

export function createSearchIndexTables(db: Database.Database): void {
  // Trigram index for substring matching over code content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS code_trigram USING fts5(
      file_path,
      symbol_name,
      code_text,
      tokenize='trigram case_sensitive 0'
    );
  `);

  // Unicode/porter BM25 index for natural language queries on symbol metadata
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(
      symbol_name,
      signature,
      doc_comment,
      file_path,
      tokenize='porter unicode61'
    );
  `);

  // Metadata table linking FTS rowids to blob/repo info
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_docs (
      rowid INTEGER PRIMARY KEY,
      blob_sha TEXT NOT NULL,
      symbol_id INTEGER,
      repo TEXT NOT NULL,
      language TEXT NOT NULL,
      file_path TEXT NOT NULL,
      symbol_name TEXT NOT NULL
    );
  `);
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface SearchDocument {
  blobSha: string;
  symbolId: number | null;
  filePath: string;
  symbolName: string;
  codeText: string;
  signature: string | null;
  docComment: string | null;
  repo: string;
  language: string;
}

export interface SearchResult {
  readonly rowid: number;
  readonly filePath: string;
  readonly symbolName: string;
  readonly codeText: string;
  readonly repo: string;
  readonly language: string;
  readonly blobSha: string;
  readonly relevanceScore: number;
  readonly matchSource: "trigram" | "bm25" | "both";
}

// ─────────────────────────────────────────────────────────────
// SearchIndex: manages both FTS tables + RRF fusion
// ─────────────────────────────────────────────────────────────

export interface SearchIndex {
  add(doc: SearchDocument): void;
  addMany(docs: SearchDocument[]): void;
  removeBlob(blobSha: string): void;
  searchTrigram(query: string, limit?: number): SearchResult[];
  searchBm25(query: string, limit?: number): SearchResult[];
  searchHybrid(query: string, limit?: number): SearchResult[];
  count(): number;
}

export function createSearchIndex(db: Database.Database): SearchIndex {
  createSearchIndexTables(db);

  // ── Prepared statements (hot path) ──

  const insertMeta = db.prepare(
    `INSERT OR REPLACE INTO search_docs(blob_sha, symbol_id, repo, language, file_path, symbol_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const insertTrigram = db.prepare(
    `INSERT INTO code_trigram(rowid, file_path, symbol_name, code_text) VALUES (?, ?, ?, ?)`,
  );

  const insertBm25 = db.prepare(
    `INSERT INTO symbol_search(rowid, symbol_name, signature, doc_comment, file_path) VALUES (?, ?, ?, ?, ?)`,
  );

  const deleteMeta = db.prepare(`DELETE FROM search_docs WHERE blob_sha = ?`);
  const deleteTrigramByBlob = db.prepare(
    `DELETE FROM code_trigram WHERE rowid IN (SELECT rowid FROM search_docs WHERE blob_sha = ?)`,
  );
  const deleteBm25ByBlob = db.prepare(
    `DELETE FROM symbol_search WHERE rowid IN (SELECT rowid FROM search_docs WHERE blob_sha = ?)`,
  );

  // BM25 weights: file_path(5) > symbol_name(10) > code_text(1)
  const queryTrigram = db.prepare(`
    SELECT ct.rowid, sd.file_path as filePath, sd.symbol_name as symbolName,
           ct.code_text as codeText, sd.repo, sd.language,
           sd.blob_sha as blobSha,
           bm25(code_trigram, 5.0, 10.0, 1.0) as relevanceScore
    FROM code_trigram ct
    JOIN search_docs sd ON sd.rowid = ct.rowid
    WHERE code_trigram MATCH ?
    ORDER BY relevanceScore
    LIMIT ?
  `);

  const queryBm25 = db.prepare(`
    SELECT ss.rowid, sd.file_path as filePath, sd.symbol_name as symbolName,
           '' as codeText, sd.repo, sd.language,
           sd.blob_sha as blobSha,
           bm25(symbol_search, 10.0, 3.0, 2.0, 5.0) as relevanceScore
    FROM symbol_search ss
    JOIN search_docs sd ON sd.rowid = ss.rowid
    WHERE symbol_search MATCH ?
    ORDER BY relevanceScore
    LIMIT ?
  `);

  const countDocs = db.prepare(`SELECT COUNT(*) as cnt FROM search_docs`);

  // ── Insert helper ──

  function indexDoc(doc: SearchDocument): void {
    const result = insertMeta.run(
      doc.blobSha, doc.symbolId, doc.repo, doc.language,
      doc.filePath, doc.symbolName,
    );
    const rowid = Number(result.lastInsertRowid);

    insertTrigram.run(rowid, doc.filePath, doc.symbolName, doc.codeText);

    if (doc.symbolName) {
      insertBm25.run(rowid, doc.symbolName, doc.signature ?? "", doc.docComment ?? "", doc.filePath);
    }
  }

  // ── Reciprocal Rank Fusion (k=60, standard, no tuning) ──

  function rrfFuse(
    trigramHits: SearchResult[],
    bm25Hits: SearchResult[],
    limit: number,
  ): SearchResult[] {
    const k = 60;
    const scores = new Map<number, { score: number; result: SearchResult; sources: Set<string> }>();

    for (let i = 0; i < trigramHits.length; i++) {
      const r = trigramHits[i]!;
      const e = scores.get(r.rowid) ?? { score: 0, result: r, sources: new Set<string>() };
      e.score += 1 / (k + i);
      e.sources.add("trigram");
      scores.set(r.rowid, e);
    }

    for (let i = 0; i < bm25Hits.length; i++) {
      const r = bm25Hits[i]!;
      const e = scores.get(r.rowid) ?? { score: 0, result: r, sources: new Set<string>() };
      e.score += 1 / (k + i);
      e.sources.add("bm25");
      scores.set(r.rowid, e);
    }

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({
        ...e.result,
        relevanceScore: e.score,
        matchSource: (e.sources.size === 2 ? "both"
          : e.sources.has("trigram") ? "trigram"
          : "bm25") as SearchResult["matchSource"],
      }));
  }

  // ── Public API ──

  return {
    add(doc) { indexDoc(doc); },

    addMany(docs) {
      const tx = db.transaction(() => { for (const doc of docs) indexDoc(doc); });
      tx();
    },

    removeBlob(blobSha) {
      const tx = db.transaction(() => {
        deleteTrigramByBlob.run(blobSha);
        deleteBm25ByBlob.run(blobSha);
        deleteMeta.run(blobSha);
      });
      tx();
    },

    searchTrigram(query, limit = 20) {
      try {
        const escaped = `"${query.replace(/"/g, '""')}"`;
        return queryTrigram.all(escaped, limit) as SearchResult[];
      } catch { return []; }
    },

    searchBm25(query, limit = 20) {
      try {
        return queryBm25.all(query, limit) as SearchResult[];
      } catch { return []; }
    },

    searchHybrid(query, limit = 20) {
      const n = limit * 3;
        const tHits = this.searchTrigram(query, n);
      const bHits = this.searchBm25(query, n);
      return rrfFuse(tHits, bHits, limit);
    },

    count() { return (countDocs.get() as { cnt: number }).cnt; },
  };
}

-- Schema v1 — Blob-centric intelligence layer
-- Principle: content-addressable blobs, commit-pinned refs, immutable derivations

-- ════════════════════════════════════════════════════════════
-- Layer 1: Content-Addressable Blob Store
-- Same file in 10 forks = stored ONCE. Parse once per blob.
-- ════════════════════════════════════════════════════════════

CREATE TABLE blobs (
  sha TEXT PRIMARY KEY,                  -- SHA-256 of raw content
  language TEXT,
  size_bytes INTEGER NOT NULL,
  simhash TEXT,                          -- for near-duplicate detection
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Note: actual file content lives on disk (CAS dir), NOT in SQLite.
-- This table is metadata-only. Keeps DB small even with 100K files.

-- Maps repo+commit+path → blob SHA. The join between "where" and "what".
CREATE TABLE file_refs (
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha),
  language TEXT,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (repo_id, commit_sha, path)
);

-- Derivation records: "analyzer X version Y already processed blob Z"
-- If exists → skip recompute. Bumping version auto-invalidates.
CREATE TABLE derivations (
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  analyzer TEXT NOT NULL,                -- 'symbols' | 'chunks' | 'fingerprint' | 'quality'
  analyzer_version TEXT NOT NULL,
  produced_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (blob_sha, analyzer, analyzer_version)
);

-- ════════════════════════════════════════════════════════════
-- Layer 2: Symbols (extracted from AST)
-- ════════════════════════════════════════════════════════════

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- function|class|method|interface|type|const|enum
  name TEXT NOT NULL,
  signature TEXT,                        -- "(opts: Options) => Promise<T>"
  exported INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  doc_comment TEXT,
  ast_fingerprint TEXT,                  -- normalized hash for clone clustering
  features_json TEXT                     -- quality features: complexity, deps count, etc.
);

CREATE INDEX idx_symbols_blob ON symbols(blob_sha);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_kind ON symbols(kind);
CREATE INDEX idx_symbols_exported ON symbols(exported) WHERE exported = 1;
CREATE INDEX idx_symbols_fingerprint ON symbols(ast_fingerprint) WHERE ast_fingerprint IS NOT NULL;

-- Symbol dependency edges (calls, imports, extends)
CREATE TABLE symbol_edges (
  source_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  external_package TEXT,                 -- non-null if target is external
  edge_kind TEXT NOT NULL,               -- calls|imports|extends|implements|references
  UNIQUE (source_id, target_id, edge_kind)
);

CREATE INDEX idx_edges_target ON symbol_edges(target_id) WHERE target_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- Layer 3: Chunks (for trigram lexical code search)
-- NOT whole files. AST-delimited or line-window based.
-- ════════════════════════════════════════════════════════════

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- symbol_body|line_window|import_block|comment_block
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL                     -- actual code for trigram indexing
);

CREATE INDEX idx_chunks_blob ON chunks(blob_sha);

-- Trigram postings for code-aware substring search
-- This is our "mini-Blackbird": sparse-gram positional index in SQLite
CREATE TABLE chunk_grams (
  gram TEXT NOT NULL,                    -- 3-char gram
  chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,             -- position within chunk
  PRIMARY KEY (gram, chunk_id, position)
) WITHOUT ROWID;

-- ════════════════════════════════════════════════════════════
-- Layer 5: SQLite Control Plane (metadata, state, cache)
-- FTS5 for README/docs/notes/comments ONLY — NOT for code
-- ════════════════════════════════════════════════════════════

-- Repos
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  full_name TEXT UNIQUE NOT NULL,        -- "owner/repo"
  description TEXT,
  stars INTEGER DEFAULT 0,
  forks INTEGER DEFAULT 0,
  language TEXT,
  topics TEXT,                           -- JSON array
  license_spdx TEXT,
  default_branch TEXT DEFAULT 'main',
  pushed_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  heat TEXT NOT NULL DEFAULT 'cold' CHECK(heat IN ('cold','warm','hot')),
  pinned INTEGER NOT NULL DEFAULT 0,
  health_json TEXT,
  user_tags TEXT,                         -- JSON array
  user_notes TEXT,
  indexed_at TEXT,                        -- NULL = cache only
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  etag TEXT
);

CREATE INDEX idx_repos_heat ON repos(heat);
CREATE INDEX idx_repos_stars ON repos(stars DESC);

-- Refs (commit-pinned snapshots)
CREATE TABLE refs (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_json TEXT,                         -- recursive file tree
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo_id, ref_name, commit_sha)
);

-- ════════════════════════════════════════════════════════════
-- Patterns (persistent code memory)
-- ════════════════════════════════════════════════════════════

CREATE TABLE patterns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  language TEXT,
  code TEXT,
  signature TEXT,
  description TEXT,
  source_type TEXT NOT NULL,
  source_repo TEXT,
  source_ref TEXT,
  source_path TEXT,
  source_commit_sha TEXT,
  source_license_spdx TEXT,
  source_session_id TEXT,
  quality_score REAL NOT NULL DEFAULT 0.5,
  times_recalled INTEGER NOT NULL DEFAULT 0,
  times_used_successfully INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0.5,
  parent_id INTEGER REFERENCES patterns(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  ast_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_recalled_at TEXT
);

CREATE INDEX idx_patterns_name ON patterns(name);
CREATE INDEX idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX idx_patterns_language ON patterns(language);

CREATE TABLE pattern_tags (
  pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (pattern_id, tag)
);

CREATE TABLE pattern_links (
  from_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);

-- FTS for pattern search (metadata, NOT code content)
CREATE VIRTUAL TABLE patterns_fts USING fts5(
  name, description, signature,
  content='patterns', content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS sync triggers
CREATE TRIGGER patterns_fts_ai AFTER INSERT ON patterns BEGIN
  INSERT INTO patterns_fts(rowid, name, description, signature)
  VALUES (new.id, new.name, new.description, new.signature);
END;
CREATE TRIGGER patterns_fts_ad AFTER DELETE ON patterns BEGIN
  INSERT INTO patterns_fts(patterns_fts, rowid, name, description, signature)
  VALUES ('delete', old.id, old.name, old.description, old.signature);
END;
CREATE TRIGGER patterns_fts_au AFTER UPDATE ON patterns BEGIN
  INSERT INTO patterns_fts(patterns_fts, rowid, name, description, signature)
  VALUES ('delete', old.id, old.name, old.description, old.signature);
  INSERT INTO patterns_fts(rowid, name, description, signature)
  VALUES (new.id, new.name, new.description, new.signature);
END;

-- FTS for repo metadata search
CREATE VIRTUAL TABLE repos_fts USING fts5(
  full_name, description, topics, user_notes,
  content='repos', content_rowid='id',
  tokenize='porter unicode61'
);

-- ════════════════════════════════════════════════════════════
-- Semantic Anchors (viewed code locations)
-- ════════════════════════════════════════════════════════════

CREATE TABLE anchors (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  symbol TEXT,
  snippet_hash TEXT,
  ast_fingerprint TEXT,
  query_intent TEXT,
  tags TEXT,                             -- JSON array
  interaction_score INTEGER NOT NULL DEFAULT 1,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_anchors_repo ON anchors(repo_id);
CREATE INDEX idx_anchors_symbol ON anchors(symbol) WHERE symbol IS NOT NULL;
CREATE INDEX idx_anchors_intent ON anchors(query_intent) WHERE query_intent IS NOT NULL;

-- Resume cards (materialized from anchors)
CREATE TABLE resume_cards (
  repo_id INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  ref_name TEXT,
  last_path TEXT,
  last_symbol TEXT,
  interaction_score INTEGER NOT NULL DEFAULT 0,
  viewed_files TEXT,                     -- JSON array
  last_touched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════
-- Sessions & Research Chains
-- ════════════════════════════════════════════════════════════

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  summary TEXT,
  patterns_captured INTEGER NOT NULL DEFAULT 0,
  patterns_recalled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE research_chains (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
  conclusion TEXT,
  model_used TEXT,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE research_steps (
  id INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES research_chains(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  query_type TEXT NOT NULL,
  query_text TEXT NOT NULL,
  result_summary TEXT NOT NULL,
  result_full TEXT,
  sources TEXT,                          -- JSON
  key_insight TEXT,
  decision_made TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chain_id, step_order)
);

CREATE VIRTUAL TABLE research_fts USING fts5(
  title, intent, conclusion,
  content='research_chains', content_rowid='id'
);

-- ════════════════════════════════════════════════════════════
-- Import provenance
-- ════════════════════════════════════════════════════════════

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  pattern_id INTEGER REFERENCES patterns(id) ON DELETE SET NULL,
  source_repo TEXT NOT NULL,
  source_commit_sha TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_symbol TEXT,
  license_spdx TEXT,
  mode TEXT NOT NULL DEFAULT 'generate_inspired_by',
  target_path TEXT,
  dependency_closure TEXT,               -- JSON
  adaptations TEXT,                      -- JSON
  provenance_hash TEXT NOT NULL,
  security_appendix TEXT,                -- JSON
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════
-- API cache (scope-aware to prevent auth leakage)
-- ════════════════════════════════════════════════════════════

CREATE TABLE api_cache (
  key TEXT PRIMARY KEY,
  auth_scope TEXT NOT NULL,              -- 'public' | 'pat:user' | 'app:123'
  value TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_cache_expires ON api_cache(expires_at);

-- ════════════════════════════════════════════════════════════
-- Rate limits & jobs
-- ════════════════════════════════════════════════════════════

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,               -- core|search|code_search|graphql
  rate_limit INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  payload TEXT NOT NULL,                 -- JSON
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_jobs_status ON jobs(status) WHERE status IN ('pending','running');

-- ════════════════════════════════════════════════════════════
-- Waypoints (bookmarked code locations for instant return)
-- ════════════════════════════════════════════════════════════

CREATE TABLE waypoints (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref_name TEXT,
  path TEXT,
  symbol TEXT,
  title TEXT NOT NULL,
  note TEXT,
  heat INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_visited_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_waypoints_repo ON waypoints(repo_id);

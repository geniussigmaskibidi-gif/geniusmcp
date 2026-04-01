-- [ForgeMCP] Schema v2 — Evidence Graph (RFC v2 Section 20)
-- Versioned computation: extractor_version, scorer_version, classifier_version
-- Evidence-centric: queries reuse evidence, evidence survives queries

-- ════════════════════════════════════════════════════════════
-- Query Runs (track every hunt execution)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS query_runs (
  id TEXT PRIMARY KEY,
  normalized_query_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('verified','partial','failed')),
  coverage_json TEXT NOT NULL,
  archetype_count INTEGER DEFAULT 0,
  total_candidates INTEGER DEFAULT 0,
  duration_ms INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_query_runs_hash ON query_runs(normalized_query_hash);

-- ════════════════════════════════════════════════════════════
-- Blob Locations (one blob, many repos — tracks provenance)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS blob_locations (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha),
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blob_sha, repo, path)
);

CREATE INDEX IF NOT EXISTS idx_blob_locations_repo ON blob_locations(repo);

-- ════════════════════════════════════════════════════════════
-- Symbol Slices (the ranking unit — function + closure)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS symbol_slices (
  id TEXT PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha),
  symbol_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('function','class','method','module')),
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  normalized_ast_hash TEXT,
  import_closure_json TEXT NOT NULL DEFAULT '[]',
  dependency_hints_json TEXT NOT NULL DEFAULT '[]',
  query_fit REAL DEFAULT 0,
  winnowing_fingerprint TEXT,
  extractor_version TEXT NOT NULL DEFAULT '1.0',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slices_blob ON symbol_slices(blob_sha);
CREATE INDEX IF NOT EXISTS idx_slices_ast_hash ON symbol_slices(normalized_ast_hash) WHERE normalized_ast_hash IS NOT NULL;

-- ════════════════════════════════════════════════════════════
-- Pattern Families (clusters of near-duplicate implementations)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pattern_families (
  id TEXT PRIMARY KEY,
  canonical_symbol_id TEXT NOT NULL REFERENCES symbol_slices(id),
  exact_clone_count INTEGER DEFAULT 0,
  structural_clone_count INTEGER DEFAULT 0,
  fuzzy_clone_count INTEGER DEFAULT 0,
  family_features_json TEXT NOT NULL DEFAULT '{}',
  fingerprint_version TEXT NOT NULL DEFAULT '1.0',
  classifier_version TEXT NOT NULL DEFAULT '1.0',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS family_members (
  family_id TEXT NOT NULL REFERENCES pattern_families(id) ON DELETE CASCADE,
  symbol_id TEXT NOT NULL REFERENCES symbol_slices(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  PRIMARY KEY (family_id, symbol_id)
);

-- ════════════════════════════════════════════════════════════
-- Score Cache (versioned, invalidated on metadata refresh)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS score_cache (
  symbol_id TEXT NOT NULL REFERENCES symbol_slices(id) ON DELETE CASCADE,
  preset TEXT NOT NULL,
  score_json TEXT NOT NULL,
  scorer_version TEXT NOT NULL DEFAULT '1.0',
  metadata_snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (symbol_id, preset, scorer_version)
);

-- ════════════════════════════════════════════════════════════
-- Repo Metadata Cache (enriched from GitHub REST)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS repo_metadata_cache (
  repo TEXT PRIMARY KEY,
  stars INTEGER,
  forks INTEGER,
  license_spdx TEXT,
  pushed_at TEXT,
  archived INTEGER DEFAULT 0,
  open_issues INTEGER,
  has_ci INTEGER DEFAULT 0,
  contributor_count INTEGER,
  topics_json TEXT DEFAULT '[]',
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),
  etag TEXT
);

-- ════════════════════════════════════════════════════════════
-- Policy Decisions (track import policy outcomes)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS policy_decisions (
  id INTEGER PRIMARY KEY,
  symbol_id TEXT REFERENCES symbol_slices(id),
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow','warn','block')),
  reason TEXT,
  license_spdx TEXT,
  dependency_count INTEGER,
  blind_spots_json TEXT DEFAULT '[]',
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

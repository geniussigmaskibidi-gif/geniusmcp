-- [ForgeMCP] Schema v4 — From 3.md + 4.md production blueprints
-- New: identifier micro-index, pattern cards, feedback events, hook spool, module exports

-- ════════════════════════════════════════════════════════════
-- Identifier micro-index (replaces chunk_grams for short tokens)
-- Solves: "id", "fn", "db" queries that FTS5 trigram can't handle (<3 chars)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS identifier_terms (
  term TEXT NOT NULL,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('exact','split','abbr','short','path_stem')),
  PRIMARY KEY(term, symbol_id, file_path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_id_terms_term ON identifier_terms(term);

-- ════════════════════════════════════════════════════════════
-- Pattern cards (pre-rendered for injection — Layer 1/2 cache)
-- Eliminates re-computing injection cards every time
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pattern_cards (
  pattern_id INTEGER PRIMARY KEY REFERENCES patterns(id) ON DELETE CASCADE,
  card_l1 TEXT NOT NULL,               -- Layer 1: 50 tokens compact card
  card_l2 TEXT,                        -- Layer 2: 150 tokens with signature/deps
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  scorer_version TEXT NOT NULL DEFAULT '1.0'
);

-- ════════════════════════════════════════════════════════════
-- Feedback events (for self-improving ranker, no ML)
-- Stores: what was shown, what was selected, how long user dwelled
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  result_repo TEXT NOT NULL,
  result_path TEXT NOT NULL,
  result_symbol TEXT,
  selected INTEGER NOT NULL DEFAULT 0,  -- 1 = user accepted
  dwell_ms INTEGER,                     -- interaction duration
  rating INTEGER,                       -- 1-5 if user provided
  preset TEXT,                          -- ranking preset used
  score REAL,                           -- score at time of showing
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_events(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_query ON feedback_events(query_text);

-- ════════════════════════════════════════════════════════════
-- Hook spool (durable queue when daemon is unavailable)
-- More reliable than filesystem spool
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hook_spool (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('capture','inject','save_context','session_end')),
  envelope_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,  -- 1=inject(highest), 5=read(lowest)
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_spool_unprocessed ON hook_spool(priority, enqueued_at)
  WHERE processed_at IS NULL;

-- ════════════════════════════════════════════════════════════
-- Module exports (for import closure resolution)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS module_exports (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  module_path TEXT NOT NULL,
  export_kind TEXT CHECK(export_kind IN ('default','named','re-export','namespace')),
  export_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_module_exports_path ON module_exports(module_path);

-- ════════════════════════════════════════════════════════════
-- Blob usage counters (for GC mark-sweep)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS blob_usage (
  blob_sha TEXT PRIMARY KEY REFERENCES blobs(sha) ON DELETE CASCADE,
  file_ref_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  pattern_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ════════════════════════════════════════════════════════════
-- Research artifacts + links (durable, linkable)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS research_artifacts (
  id INTEGER PRIMARY KEY,
  research_step_id INTEGER NOT NULL REFERENCES research_steps(id) ON DELETE CASCADE,
  artifact_uri TEXT NOT NULL,
  role TEXT CHECK(role IN ('example','reference','contrast','evidence')),
  title TEXT,
  checksum TEXT
);

CREATE TABLE IF NOT EXISTS research_links (
  id INTEGER PRIMARY KEY,
  research_chain_id INTEGER NOT NULL REFERENCES research_chains(id) ON DELETE CASCADE,
  target_uri TEXT NOT NULL,
  relation TEXT CHECK(relation IN ('depends_on','conflicts_with','extends','supersedes'))
);

-- ════════════════════════════════════════════════════════════
-- Add missing columns to blobs for lifecycle management
-- ════════════════════════════════════════════════════════════

-- Note: ALTER TABLE in SQLite can't add CHECK constraints, so using TEXT
ALTER TABLE blobs ADD COLUMN status TEXT DEFAULT 'live';
ALTER TABLE blobs ADD COLUMN last_accessed_at TEXT;
ALTER TABLE blobs ADD COLUMN verified_at TEXT;

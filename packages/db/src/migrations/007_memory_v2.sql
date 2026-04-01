-- [ForgeMCP] Memory 2.0: pattern families, versioned capsules, anchors, resume cards, waypoints
-- Extends the pattern system with multi-layer context recall and session resume support.

-- Pattern families group related patterns across repos/languages
CREATE TABLE IF NOT EXISTS pattern_families (
  family_id INTEGER PRIMARY KEY,
  canonical_pattern_id INTEGER,
  family_name TEXT NOT NULL,
  family_description TEXT,
  archetype TEXT,
  member_count INTEGER DEFAULT 1,
  created_at_ms INTEGER DEFAULT 0,
  updated_at_ms INTEGER DEFAULT 0
);

-- Immutable version snapshots for patterns
CREATE TABLE IF NOT EXISTS pattern_versions (
  version_id INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL,
  family_id INTEGER,
  version_number INTEGER DEFAULT 1,
  code_blob_sha TEXT,
  signature_text TEXT,
  doc_text TEXT,
  feature_flags TEXT,
  ast_fingerprint TEXT,
  simhash64 TEXT,
  created_at_ms INTEGER DEFAULT 0,
  UNIQUE(pattern_id, version_number)
);

-- Multi-layer capsules (L1/L2/L3) for context-aware recall
CREATE TABLE IF NOT EXISTS pattern_capsules (
  capsule_id INTEGER PRIMARY KEY,
  pattern_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  layer INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  rendered_at_ms INTEGER DEFAULT 0
);

-- Anchors track where the developer has been working
CREATE TABLE IF NOT EXISTS anchors (
  anchor_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  symbol_id INTEGER,
  blob_sha TEXT NOT NULL,
  commit_sha TEXT,
  interaction_type TEXT NOT NULL,
  heat_score REAL DEFAULT 1.0,
  first_seen_at_ms INTEGER DEFAULT 0,
  last_seen_at_ms INTEGER DEFAULT 0,
  visit_count INTEGER DEFAULT 1
);

-- Resume cards for session continuity
CREATE TABLE IF NOT EXISTS resume_cards (
  card_id INTEGER PRIMARY KEY,
  anchor_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  context_json TEXT,
  rendered_at_ms INTEGER DEFAULT 0
);

-- Waypoints: user-labelled bookmarks tied to anchors
CREATE TABLE IF NOT EXISTS waypoints (
  waypoint_id INTEGER PRIMARY KEY,
  anchor_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  note TEXT,
  created_at_ms INTEGER DEFAULT 0
);

-- Extend patterns with memory tier and family linkage
ALTER TABLE patterns ADD COLUMN memory_tier TEXT DEFAULT 'project';
ALTER TABLE patterns ADD COLUMN family_id INTEGER;

-- Indexes for anchor queries
CREATE INDEX IF NOT EXISTS idx_anchors_project ON anchors(project_id, path);
CREATE INDEX IF NOT EXISTS idx_anchors_heat ON anchors(heat_score DESC);

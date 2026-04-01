-- [ForgeMCP] Schema v3 — Pattern State Machine (build spec Section 6)
-- States: candidate → active → reinforced → stale → superseded → archived → deleted

ALTER TABLE patterns ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate'
  CHECK(state IN ('candidate','active','reinforced','stale','superseded','archived','deleted'));

CREATE INDEX IF NOT EXISTS idx_patterns_state ON patterns(state)
  WHERE state NOT IN ('archived','deleted');

-- Track state transitions
ALTER TABLE patterns ADD COLUMN state_changed_at TEXT;

-- Track lineage more explicitly
ALTER TABLE patterns ADD COLUMN lineage_head_id INTEGER REFERENCES patterns(id);

-- Scope for cross-project learning
ALTER TABLE patterns ADD COLUMN scope TEXT DEFAULT 'project'
  CHECK(scope IN ('session','project','workspace','global'));

-- Freshness half-life (days) — configurable per pattern
ALTER TABLE patterns ADD COLUMN freshness_half_life_days REAL DEFAULT 30.0;

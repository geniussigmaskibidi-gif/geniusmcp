-- [ForgeMCP] Phase 1: Blob lifecycle state machine
-- Adds lifecycle columns, usage counters, integrity tracking, GC support.
-- Note: blob_usage already exists from migration 004 — we add missing columns.

-- Lifecycle columns on blobs
ALTER TABLE blobs ADD COLUMN content_state TEXT DEFAULT 'committed';
ALTER TABLE blobs ADD COLUMN disk_state TEXT DEFAULT 'present';
ALTER TABLE blobs ADD COLUMN simhash64 TEXT;
ALTER TABLE blobs ADD COLUMN created_at_ms INTEGER DEFAULT 0;
ALTER TABLE blobs ADD COLUMN last_accessed_at_ms INTEGER;
ALTER TABLE blobs ADD COLUMN last_verified_at_ms INTEGER;
ALTER TABLE blobs ADD COLUMN quarantine_reason TEXT;
ALTER TABLE blobs ADD COLUMN ref_count INTEGER DEFAULT 0;
ALTER TABLE blobs ADD COLUMN pin_count INTEGER DEFAULT 0;

-- blob_usage already exists from 004 — add missing columns
ALTER TABLE blob_usage ADD COLUMN import_count INTEGER DEFAULT 0;
ALTER TABLE blob_usage ADD COLUMN last_used_at_ms INTEGER DEFAULT 0;

-- Blob pins (manual + automatic GC roots)
CREATE TABLE IF NOT EXISTS blob_pins (
  blob_sha TEXT NOT NULL,
  reason TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER,
  PRIMARY KEY(blob_sha, owner_type, owner_id)
);

-- Blob ingest journal (crash recovery)
CREATE TABLE IF NOT EXISTS blob_ingest_journal (
  sha TEXT PRIMARY KEY,
  temp_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'writing',
  started_at_ms INTEGER NOT NULL DEFAULT 0
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_blobs_content_state ON blobs(content_state);
CREATE INDEX IF NOT EXISTS idx_blobs_disk_state ON blobs(disk_state, last_accessed_at_ms);
CREATE INDEX IF NOT EXISTS idx_blob_pins_expiry ON blob_pins(expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_blob_usage_last ON blob_usage(last_used_at_ms);

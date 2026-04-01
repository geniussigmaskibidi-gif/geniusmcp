import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, migrateDatabase, closeDatabase } from "@forgemcp/db";

describe("Evidence Graph (v2 Schema)", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgemcp-ev-"));
    db = openDatabase(join(tmpDir, "test.db"));
    migrateDatabase(db); // runs both v1 + v2 migrations
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create query_runs table", () => {
    const stmt = db.prepare("INSERT INTO query_runs (id, normalized_query_hash, request_json, status, coverage_json) VALUES (?, ?, ?, ?, ?)");
    stmt.run("run-1", "hash123", '{"query":"retry"}', "verified", '{"blindSpots":[]}');

    const row = db.prepare("SELECT * FROM query_runs WHERE id = ?").get("run-1") as Record<string, unknown>;
    expect(row["status"]).toBe("verified");
    expect(row["normalized_query_hash"]).toBe("hash123");
  });

  it("should create blob_locations table with dedup", () => {
    // First need a blob
    db.prepare("INSERT INTO blobs (sha, language, size_bytes) VALUES (?, ?, ?)").run("sha-abc", "typescript", 100);

    // Insert two locations for same blob
    db.prepare("INSERT INTO blob_locations (blob_sha, repo, path) VALUES (?, ?, ?)").run("sha-abc", "owner/repo1", "src/retry.ts");
    db.prepare("INSERT INTO blob_locations (blob_sha, repo, path) VALUES (?, ?, ?)").run("sha-abc", "owner/repo2", "lib/retry.ts");

    const locations = db.prepare("SELECT * FROM blob_locations WHERE blob_sha = ?").all("sha-abc");
    expect(locations).toHaveLength(2);
  });

  it("should create symbol_slices with extractor_version", () => {
    db.prepare("INSERT INTO blobs (sha, language, size_bytes) VALUES (?, ?, ?)").run("sha-def", "typescript", 200);

    db.prepare(`INSERT INTO symbol_slices (id, blob_sha, symbol_name, kind, start_line, end_line, extractor_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run("slice-1", "sha-def", "retryWithBackoff", "function", 10, 30, "1.0");

    const slice = db.prepare("SELECT * FROM symbol_slices WHERE id = ?").get("slice-1") as Record<string, unknown>;
    expect(slice["symbol_name"]).toBe("retryWithBackoff");
    expect(slice["extractor_version"]).toBe("1.0");
  });

  it("should create pattern_families with versioning", () => {
    db.prepare("INSERT INTO blobs (sha, language, size_bytes) VALUES (?, ?, ?)").run("sha-ghi", "typescript", 150);
    db.prepare(`INSERT INTO symbol_slices (id, blob_sha, symbol_name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)`).run("slice-2", "sha-ghi", "tokenBucket", "class", 1, 50);

    db.prepare(`INSERT INTO pattern_families (id, canonical_symbol_id, fingerprint_version, classifier_version) VALUES (?, ?, ?, ?)`).run("fam-1", "slice-2", "1.0", "1.0");

    db.prepare(`INSERT INTO family_members (family_id, symbol_id, similarity) VALUES (?, ?, ?)`).run("fam-1", "slice-2", 1.0);

    const family = db.prepare("SELECT * FROM pattern_families WHERE id = ?").get("fam-1") as Record<string, unknown>;
    expect(family["canonical_symbol_id"]).toBe("slice-2");

    const members = db.prepare("SELECT * FROM family_members WHERE family_id = ?").all("fam-1");
    expect(members).toHaveLength(1);
  });

  it("should create score_cache with versioned keys", () => {
    db.prepare("INSERT INTO blobs (sha, language, size_bytes) VALUES (?, ?, ?)").run("sha-jkl", "go", 300);
    db.prepare(`INSERT INTO symbol_slices (id, blob_sha, symbol_name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)`).run("slice-3", "sha-jkl", "NewLimiter", "function", 5, 20);

    db.prepare(`INSERT INTO score_cache (symbol_id, preset, score_json, scorer_version) VALUES (?, ?, ?, ?)`).run("slice-3", "battle_tested", '{"overall":0.85}', "1.0");

    // Same symbol + preset + DIFFERENT scorer version = separate entry
    db.prepare(`INSERT INTO score_cache (symbol_id, preset, score_json, scorer_version) VALUES (?, ?, ?, ?)`).run("slice-3", "battle_tested", '{"overall":0.90}', "2.0");

    const scores = db.prepare("SELECT * FROM score_cache WHERE symbol_id = ?").all("slice-3");
    expect(scores).toHaveLength(2); // versioned — both exist
  });

  it("should create repo_metadata_cache with ETag", () => {
    db.prepare(`INSERT INTO repo_metadata_cache (repo, stars, license_spdx, archived) VALUES (?, ?, ?, ?)`).run("facebook/react", 230000, "MIT", 0);

    const meta = db.prepare("SELECT * FROM repo_metadata_cache WHERE repo = ?").get("facebook/react") as Record<string, unknown>;
    expect(meta["stars"]).toBe(230000);
    expect(meta["license_spdx"]).toBe("MIT");
  });

  it("should create policy_decisions", () => {
    db.prepare(`INSERT INTO policy_decisions (repo, path, mode, decision, reason) VALUES (?, ?, ?, ?, ?)`).run("owner/repo", "src/lib.ts", "snippet_transplant", "allow", "All checks passed");

    const decisions = db.prepare("SELECT * FROM policy_decisions WHERE repo = ?").all("owner/repo");
    expect(decisions).toHaveLength(1);
  });

  it("should have schema version 2", () => {
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(5); // v5 after blob lifecycle migration
  });
});

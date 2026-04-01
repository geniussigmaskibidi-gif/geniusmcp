// Research: better-sqlite3 best practices, SQLite performance tuning guides

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_VERSION = 5;

// When running from dist/, SQL files live in ../src/migrations/
function migrationsDir(): string {
  const local = join(__dirname, "migrations");
  if (existsSync(join(local, "001_initial.sql"))) return local;
  const src = join(__dirname, "..", "src", "migrations");
  if (existsSync(join(src, "001_initial.sql"))) return src;
  return local;
}

export function openDatabase(dbPath: string): Database.Database {
  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // ── Performance PRAGMAs (from SQLite performance tuning research) ──
  // WAL: 10-100x improvement, concurrent readers don't block writer
  db.pragma("journal_mode = WAL");
  // NORMAL sync in WAL is safe + fast (commits survive process crash)
  db.pragma("synchronous = NORMAL");
  // 200MB page cache in memory (50000 pages × 4KB)
  db.pragma("cache_size = -200000");
  // Temp tables in RAM
  db.pragma("temp_store = MEMORY");
  // Enable foreign keys (SQLite doesn't by default!)
  db.pragma("foreign_keys = ON");
  // Auto-checkpoint every 1000 pages to prevent WAL bloat
  db.pragma("wal_autocheckpoint = 1000");
  // Busy timeout: wait up to 5s for lock instead of immediate SQLITE_BUSY
  db.pragma("busy_timeout = 5000");

  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`Database integrity check failed: ${String(integrity)}. File may be corrupted: ${dbPath}`);
  }

  return db;
}

/** Run migrations using PRAGMA user_version for versioning. */
export function migrateDatabase(db: Database.Database): void {
  const result = db.pragma("user_version", { simple: true });
  const currentVersion = typeof result === "number" ? result : 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  if (currentVersion < 1) {
    const migrationPath = join(migrationsDir(), "001_initial.sql");
    const sql = readFileSync(migrationPath, "utf-8");

    // Execute entire schema in a transaction for atomicity
    const migrate = db.transaction(() => {
      db.exec(sql);
      db.pragma("user_version = 1");
    });
    migrate();
  }

  if (currentVersion < 2) {
    const sql2 = readFileSync(
      join(migrationsDir(), "002_evidence_graph.sql"),
      "utf-8",
    );
    const migrate2 = db.transaction(() => {
      db.exec(sql2);
      db.pragma("user_version = 2");
    });
    migrate2();
  }

  if (currentVersion < 3) {
    const sql3 = readFileSync(
      join(migrationsDir(), "003_pattern_states.sql"),
      "utf-8",
    );
    const migrate3 = db.transaction(() => {
      db.exec(sql3);
      db.pragma("user_version = 3");
    });
    migrate3();
  }

  if (currentVersion < 4) {
    const sql4 = readFileSync(
      join(migrationsDir(), "004_from_blueprints.sql"),
      "utf-8",
    );
    const migrate4 = db.transaction(() => {
      db.exec(sql4);
      db.pragma("user_version = 4");
    });
    migrate4();
  }

  if (currentVersion < 5) {
    const sql5 = readFileSync(
      join(migrationsDir(), "005_blob_lifecycle.sql"),
      "utf-8",
    );
    const migrate5 = db.transaction(() => {
      db.exec(sql5);
      db.pragma("user_version = 5");
    });
    migrate5();
  }
}

/**
 * v1.0 build spec Section 18.4: run PRAGMA optimize on startup
 * SQLite recommends `PRAGMA optimize=0x10002` for fresh long-lived connections.
 * Also run periodically (via `runOptimize`) and on close.
 */
export function warmupDatabase(db: Database.Database): void {
  db.pragma("optimize=0x10002");
}

/** Run PRAGMA optimize periodically (every ~1 hour). */
export function runOptimize(db: Database.Database): void {
  db.pragma("optimize");
}

/** Close database cleanly. Call on process exit. */
export function closeDatabase(db: Database.Database): void {
  db.pragma("optimize");
  db.close();
}

export type { Database };

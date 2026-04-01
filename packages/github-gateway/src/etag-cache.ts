// Research: GitHub says authenticated 304 does NOT count against rate limit.
// Highest-ROI optimization: saves rate budget on repeat requests.

// At runtime the caller passes a better-sqlite3 Database instance.
import { createHash } from "node:crypto";

export interface PreparedStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
}

export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
}

export interface CachedResponse {
  readonly data: unknown;
  readonly etag: string | null;
  readonly cachedAt: number;
}

export interface ETagCache {
  getEtag(key: string): string | null;
  getCached(key: string): CachedResponse | null;
  store(key: string, data: unknown, etag: string | null, ttlSeconds?: number): void;
  buildKey(method: string, url: string, params?: Record<string, unknown>): string;
  prune(): number;
  size(): number;
}

export function createETagCache(db: SqliteHandle): ETagCache {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etag_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      etag TEXT,
      cached_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_etag_exp ON etag_cache(expires_at);
  `);

  const getEntry = db.prepare(
    `SELECT data, etag, cached_at FROM etag_cache WHERE key = ? AND expires_at > ?`,
  );
  const getEtagOnly = db.prepare(`SELECT etag FROM etag_cache WHERE key = ?`);
  const upsert = db.prepare(`
    INSERT INTO etag_cache (key, data, etag, cached_at, expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET data=excluded.data, etag=excluded.etag,
      cached_at=excluded.cached_at, expires_at=excluded.expires_at
  `);
  const delExpired = db.prepare(`DELETE FROM etag_cache WHERE expires_at < ?`);
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM etag_cache`);

  return {
    getEtag(key) {
      return (getEtagOnly.get(key) as { etag: string | null } | undefined)?.etag ?? null;
    },
    getCached(key) {
      const now = Math.floor(Date.now() / 1000);
      const row = getEntry.get(key, now) as { data: string; etag: string | null; cached_at: number } | undefined;
      if (!row) return null;
      try { return { data: JSON.parse(row.data), etag: row.etag, cachedAt: row.cached_at }; }
      catch { return null; }
    },
    store(key, data, etag, ttl = 3600) {
      const now = Math.floor(Date.now() / 1000);
      upsert.run(key, JSON.stringify(data), etag, now, now + ttl);
    },
    buildKey(method, url, params) {
      const parts = [method.toUpperCase(), url];
      if (params) {
        parts.push(Object.keys(params).sort().map(k => `${k}=${String(params[k])}`).join("&"));
      }
      return createHash("sha256").update(parts.join("|")).digest("hex");
    },
    prune() {
      return delExpired.run(Math.floor(Date.now() / 1000)).changes;
    },
    size() {
      return (cnt.get() as { c: number }).c;
    },
  };
}

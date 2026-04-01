// Research: SQLite job queue patterns (~10-15K claims/sec on better-sqlite3).
// Design: Atomic claim, lease tokens for crash safety,
// exponential backoff on retry, dead-letter after max attempts.

import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type JobState = "pending" | "claimed" | "completed" | "failed" | "dead";
export type JobPriority = 0 | 1 | 2;

export interface Job {
  readonly jobId: string;
  readonly type: string;
  readonly priority: JobPriority;
  readonly payload: string;
  readonly state: JobState;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: number;
  readonly scheduledAt: number;
  readonly completedAt: number | null;
  readonly errorJson: string | null;
}

export interface JobQueueStats {
  readonly pending: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly dead: number;
}

// ─────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────

export interface JobQueue {
  submit(type: string, payload: unknown, opts?: {
    priority?: JobPriority;
    delayMs?: number;
    maxAttempts?: number;
    idempotencyKey?: string;
  }): string;

  claim(workerId: string, types: string[], limit?: number): Job[];
  heartbeat(jobId: string, leaseToken: string): boolean;
  complete(jobId: string, leaseToken: string): void;
  fail(jobId: string, leaseToken: string, errorMessage: string): void;
  recoverExpired(): number;
  stats(): JobQueueStats;
}

// ─────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS forge_jobs (
  job_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_json TEXT,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_forge_jobs_claim
  ON forge_jobs(state, priority, scheduled_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_forge_jobs_lease
  ON forge_jobs(lease_expires_at) WHERE state = 'claimed';
`;

export function createJobQueue(db: Database.Database, opts?: {
  leaseTimeMs?: number;
}): JobQueue {
  const leaseTimeMs = opts?.leaseTimeMs ?? 30_000;

  db.exec(SCHEMA);

  const submitStmt = db.prepare(
    "INSERT OR IGNORE INTO forge_jobs" +
    " (job_id, type, priority, payload, state, created_at, scheduled_at, max_attempts, idempotency_key)" +
    " VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)"
  );

  const heartbeatStmt = db.prepare(
    "UPDATE forge_jobs SET lease_expires_at = ?" +
    " WHERE job_id = ? AND lease_token = ? AND state = 'claimed'"
  );

  const completeStmt = db.prepare(
    "UPDATE forge_jobs SET state = 'completed', completed_at = ?," +
    " lease_token = NULL, lease_expires_at = NULL" +
    " WHERE job_id = ? AND lease_token = ?"
  );

  const getJobStmt = db.prepare(
    "SELECT attempts, max_attempts FROM forge_jobs WHERE job_id = ?"
  );

  const failStmt = db.prepare(
    "UPDATE forge_jobs SET state = ?, error_json = ?," +
    " lease_token = NULL, lease_expires_at = NULL, scheduled_at = ?" +
    " WHERE job_id = ? AND lease_token = ?"
  );

  const recoverStmt = db.prepare(
    "UPDATE forge_jobs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL" +
    " WHERE state = 'claimed' AND lease_expires_at < ? AND attempts < max_attempts"
  );

  const deadLetterStmt = db.prepare(
    "UPDATE forge_jobs SET state = 'dead', lease_token = NULL, lease_expires_at = NULL" +
    " WHERE state = 'claimed' AND lease_expires_at < ? AND attempts >= max_attempts"
  );

  const statsStmt = db.prepare(
    "SELECT state, COUNT(*) as cnt FROM forge_jobs GROUP BY state"
  );

  return {
    submit(type, payload, submitOpts) {
      const jobId = randomBytes(12).toString("hex");
      const now = Date.now();
      submitStmt.run(
        jobId, type,
        submitOpts?.priority ?? 2,
        JSON.stringify(payload),
        now,
        now + (submitOpts?.delayMs ?? 0),
        submitOpts?.maxAttempts ?? 3,
        submitOpts?.idempotencyKey ?? null,
      );
      return jobId;
    },

    claim(workerId, types, limit = 1) {
      const now = Date.now();
      const token = workerId + ":" + randomBytes(4).toString("hex");
      const leaseExpiry = now + leaseTimeMs;
      const claimed: Job[] = [];

      const claimTx = db.transaction(() => {
        for (let i = 0; i < limit; i++) {
          const placeholders = types.map(() => "?").join(",");
          const findStmt = db.prepare(
            "SELECT job_id FROM forge_jobs" +
            " WHERE state = 'pending' AND type IN (" + placeholders + ")" +
            " AND scheduled_at <= ?" +
            " ORDER BY priority ASC, scheduled_at ASC LIMIT 1"
          );
          const candidate = findStmt.get(...types, now) as { job_id: string } | undefined;
          if (!candidate) break;

          const updateStmt = db.prepare(
            "UPDATE forge_jobs SET state = 'claimed', lease_token = ?," +
            " lease_expires_at = ?, attempts = attempts + 1" +
            " WHERE job_id = ? AND state = 'pending'"
          );
          const result = updateStmt.run(token, leaseExpiry, candidate.job_id);
          if (result.changes === 0) continue;

          const row = db.prepare("SELECT * FROM forge_jobs WHERE job_id = ?")
            .get(candidate.job_id) as Record<string, unknown> | undefined;
          if (row) {
            claimed.push({
              jobId: row.job_id as string,
              type: row.type as string,
              priority: row.priority as JobPriority,
              payload: row.payload as string,
              state: row.state as JobState,
              leaseToken: row.lease_token as string | null,
              leaseExpiresAt: row.lease_expires_at as number | null,
              attempts: row.attempts as number,
              maxAttempts: row.max_attempts as number,
              createdAt: row.created_at as number,
              scheduledAt: row.scheduled_at as number,
              completedAt: row.completed_at as number | null,
              errorJson: row.error_json as string | null,
            });
          }
        }
      });
      claimTx();
      return claimed;
    },

    heartbeat(jobId, leaseToken) {
      const result = heartbeatStmt.run(Date.now() + leaseTimeMs, jobId, leaseToken);
      return result.changes > 0;
    },

    complete(jobId, leaseToken) {
      completeStmt.run(Date.now(), jobId, leaseToken);
    },

    fail(jobId, leaseToken, errorMessage) {
      const job = getJobStmt.get(jobId) as { attempts: number; max_attempts: number } | undefined;
      const newState = job && job.attempts >= job.max_attempts ? "dead" : "pending";
      const backoffMs = Math.min(1000 * Math.pow(2, (job?.attempts ?? 1) - 1), 300_000);
      failStmt.run(newState, JSON.stringify({ message: errorMessage }),
        Date.now() + backoffMs, jobId, leaseToken);
    },

    recoverExpired() {
      const now = Date.now();
      deadLetterStmt.run(now);
      const result = recoverStmt.run(now);
      return result.changes;
    },

    stats() {
      const rows = statsStmt.all() as Array<{ state: string; cnt: number }>;
      const m = Object.fromEntries(rows.map(r => [r.state, r.cnt]));
      return {
        pending: m["pending"] ?? 0,
        claimed: m["claimed"] ?? 0,
        completed: m["completed"] ?? 0,
        failed: m["failed"] ?? 0,
        dead: m["dead"] ?? 0,
      };
    },
  };
}

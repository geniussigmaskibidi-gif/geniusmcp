import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, createJobQueue } from "@forgemcp/db";

describe("SQLite Job Queue", () => {
  let db: ReturnType<typeof openDatabase>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "forgemcp-jq-test-"));
    db = openDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("submit and claim lifecycle", () => {
    const queue = createJobQueue(db);
    const jobId = queue.submit("parse", { blobSha: "abc123" });
    expect(jobId).toHaveLength(24); // 12 random bytes = 24 hex chars

    const claimed = queue.claim("worker-1", ["parse"]);
    expect(claimed).toHaveLength(1);
    const job = claimed[0]!;
    expect(job.type).toBe("parse");
    expect(job.state).toBe("claimed");
    expect(job.leaseToken).toBeTruthy();
    expect(job.attempts).toBe(1);

    // Complete
    queue.complete(job.jobId, job.leaseToken!);
    const stats = queue.stats();
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("claim returns empty when no matching jobs", () => {
    const queue = createJobQueue(db);
    queue.submit("parse", {});
    const claimed = queue.claim("w1", ["index"]); // wrong type
    expect(claimed).toHaveLength(0);
  });

  it("priority ordering (P0 > P1 > P2)", () => {
    const queue = createJobQueue(db);
    queue.submit("task", { name: "low" }, { priority: 2 });
    queue.submit("task", { name: "high" }, { priority: 0 });
    queue.submit("task", { name: "mid" }, { priority: 1 });

    const c1 = queue.claim("w1", ["task"]);
    const first = c1[0]!;
    expect(JSON.parse(first.payload).name).toBe("high");

    queue.complete(first.jobId, first.leaseToken!);
    const c2 = queue.claim("w1", ["task"]);
    const second = c2[0]!;
    expect(JSON.parse(second.payload).name).toBe("mid");
  });

  it("idempotency key prevents duplicate submissions", () => {
    const queue = createJobQueue(db);
    queue.submit("parse", { a: 1 }, { idempotencyKey: "unique-1" });
    queue.submit("parse", { a: 2 }, { idempotencyKey: "unique-1" }); // duplicate

    const stats = queue.stats();
    expect(stats.pending).toBe(1); // only one job
  });

  it("fail retries with backoff", () => {
    const queue = createJobQueue(db);
    queue.submit("task", {}, { maxAttempts: 3 });

    // First attempt fails
    const c1 = queue.claim("w1", ["task"]);
    queue.fail(c1[0]!.jobId, c1[0]!.leaseToken!, "transient error");

    // Should be back in pending with delayed scheduledAt
    const stats = queue.stats();
    expect(stats.pending).toBe(1);
  });

  it("dead-letter after max attempts", () => {
    const queue = createJobQueue(db);
    queue.submit("task", {}, { maxAttempts: 1 });

    const c1 = queue.claim("w1", ["task"]);
    queue.fail(c1[0]!.jobId, c1[0]!.leaseToken!, "permanent error");

    const stats = queue.stats();
    expect(stats.dead).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("heartbeat extends lease", () => {
    const queue = createJobQueue(db, { leaseTimeMs: 100 });
    queue.submit("task", {});
    const claimed = queue.claim("w1", ["task"]);

    const ok = queue.heartbeat(claimed[0]!.jobId, claimed[0]!.leaseToken!);
    expect(ok).toBe(true);

    // Bad lease token fails
    const bad = queue.heartbeat(claimed[0]!.jobId, "wrong-token");
    expect(bad).toBe(false);
  });

  it("recover expired leases", async () => {
    const queue = createJobQueue(db, { leaseTimeMs: 1 }); // 1ms lease
    queue.submit("task", {}, { maxAttempts: 3 });
    queue.claim("w1", ["task"]); // claims with 1ms lease

    // Wait for lease to expire
    await new Promise(r => setTimeout(r, 10));

    const recovered = queue.recoverExpired();
    expect(recovered).toBe(1);

    const stats = queue.stats();
    expect(stats.pending).toBe(1);
  });

  it("claim multiple jobs at once", () => {
    const queue = createJobQueue(db);
    queue.submit("task", { n: 1 });
    queue.submit("task", { n: 2 });
    queue.submit("task", { n: 3 });

    const claimed = queue.claim("w1", ["task"], 2);
    expect(claimed).toHaveLength(2);

    const stats = queue.stats();
    expect(stats.claimed).toBe(2);
    expect(stats.pending).toBe(1);
  });

  it("delayed jobs are not claimed before scheduled time", () => {
    const queue = createJobQueue(db);
    queue.submit("task", {}, { delayMs: 60_000 }); // 1 minute delay

    const claimed = queue.claim("w1", ["task"]);
    expect(claimed).toHaveLength(0);
  });
});

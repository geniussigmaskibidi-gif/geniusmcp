// Tests: Logger, Health, Context, ForgeResult helpers, Config

import { describe, it, expect, vi } from "vitest";
import {
  ok, err,
  createLogger, createNullLogger,
  createHealthRegistry,
  createRequestContext, remainingBudget, elapsed,
} from "@forgemcp/core";

// ─────────────────────────────────────────────────────────────
// ForgeResult<T> helpers
// ─────────────────────────────────────────────────────────────

describe("ForgeResult helpers", () => {
  it("ok() produces success result with value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("ok() includes optional metadata", () => {
    const result = ok("data", {
      stale: true,
      gaps: ["missing_tests"],
      cursor: "abc123",
      cost: { ms: 50, githubPoints: 1 },
      warnings: [{ code: "W001", message: "test warning" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("data");
      expect(result.stale).toBe(true);
      expect(result.gaps).toEqual(["missing_tests"]);
      expect(result.cursor).toBe("abc123");
      expect(result.cost?.ms).toBe(50);
      expect(result.warnings?.[0]!.code).toBe("W001");
    }
  });

  it("err() produces error result with code and message", () => {
    const result = err<number>("NOT_FOUND", "Thing not found");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("Thing not found");
      expect(result.error.recoverable).toBe(false);
    }
  });

  it("err() includes optional recovery hints", () => {
    const result = err<string>("RATE_LIMIT", "Too fast", {
      recoverable: true,
      retryAfterMs: 5000,
      suggestedAction: "Wait and retry",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.recoverable).toBe(true);
      expect(result.error.retryAfterMs).toBe(5000);
      expect(result.error.suggestedAction).toBe("Wait and retry");
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Structured Logger
// ─────────────────────────────────────────────────────────────

describe("Logger", () => {
  it("outputs valid NDJSON lines", () => {
    const lines: string[] = [];
    const logger = createLogger({
      module: "test",
      level: "trace",
      sink: (line) => lines.push(line),
    });

    logger.info("hello world", { key: "value" });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello world");
    expect(parsed.module).toBe("test");
    expect(parsed.key).toBe("value");
    expect(typeof parsed.ts).toBe("number");
  });

  it("respects level filtering", () => {
    const lines: string[] = [];
    const logger = createLogger({
      module: "test",
      level: "warn",
      sink: (line) => lines.push(line),
    });

    logger.trace("should not appear");
    logger.debug("should not appear");
    logger.info("should not appear");
    logger.warn("should appear");
    logger.error("should appear");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).level).toBe("warn");
    expect(JSON.parse(lines[1]!).level).toBe("error");
  });

  it("child logger inherits parent bindings", () => {
    const lines: string[] = [];
    const parent = createLogger({
      module: "parent",
      level: "info",
      sink: (line) => lines.push(line),
    });

    const child = parent.child({ reqId: "abc123", userId: "u1" });
    child.info("from child");

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.module).toBe("parent");
    expect(parsed.reqId).toBe("abc123");
    expect(parsed.userId).toBe("u1");
  });

  it("null logger produces no output", () => {
    const logger = createNullLogger();
    // Should not throw
    logger.info("test");
    logger.error("test");
    logger.child({ x: 1 }).debug("test");
    expect(logger.level).toBe("fatal");
  });
});

// ─────────────────────────────────────────────────────────────
// Health Check Registry
// ─────────────────────────────────────────────────────────────

describe("HealthRegistry", () => {
  it("aggregates healthy probes to overall healthy", async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: "db",
      check: () => ({ status: "healthy" }),
    });
    registry.register({
      name: "search",
      check: () => ({ status: "healthy" }),
    });

    const health = await registry.check();
    expect(health.overall).toBe("healthy");
    expect(health.checks.db!.status).toBe("healthy");
    expect(health.checks.search!.status).toBe("healthy");
    expect(typeof health.uptimeMs).toBe("number");
  });

  it("worst-of aggregation: degraded + healthy = degraded", async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: "db",
      check: () => ({ status: "healthy" }),
    });
    registry.register({
      name: "disk",
      check: () => ({ status: "degraded", message: "Low space" }),
    });

    const health = await registry.check();
    expect(health.overall).toBe("degraded");
  });

  it("worst-of aggregation: unhealthy wins all", async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: "db",
      check: () => ({ status: "healthy" }),
    });
    registry.register({
      name: "broken",
      check: () => ({ status: "unhealthy", message: "Connection lost" }),
    });

    const health = await registry.check();
    expect(health.overall).toBe("unhealthy");
  });

  it("handles failing probes gracefully", async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: "crasher",
      check: () => { throw new Error("boom"); },
    });

    const health = await registry.check();
    expect(health.overall).toBe("unhealthy");
    expect(health.checks.crasher!.status).toBe("unhealthy");
    expect(health.checks.crasher!.message).toBe("boom");
    expect(typeof health.checks.crasher!.latencyMs).toBe("number");
  });

  it("records latency for each probe", async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: "slow",
      check: async () => {
        await new Promise(r => setTimeout(r, 10));
        return { status: "healthy" };
      },
    });

    const health = await registry.check();
    expect(health.checks.slow!.latencyMs).toBeGreaterThanOrEqual(5);
  });

  it("probeNames returns registered names", () => {
    const registry = createHealthRegistry();
    registry.register({ name: "a", check: () => ({ status: "healthy" }) });
    registry.register({ name: "b", check: () => ({ status: "healthy" }) });
    expect(registry.probeNames()).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────
// Request Context
// ─────────────────────────────────────────────────────────────

describe("RequestContext", () => {
  it("generates unique reqIds", () => {
    const ctx1 = createRequestContext("test.tool");
    const ctx2 = createRequestContext("test.tool");
    expect(ctx1.reqId).not.toBe(ctx2.reqId);
    expect(ctx1.reqId).toHaveLength(8);
  });

  it("includes tool name and timestamp", () => {
    const before = Date.now();
    const ctx = createRequestContext("genius.hunt", { sessionId: "s1", budgetMs: 5000 });
    const after = Date.now();

    expect(ctx.toolName).toBe("genius.hunt");
    expect(ctx.sessionId).toBe("s1");
    expect(ctx.budgetMs).toBe(5000);
    expect(ctx.startedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.startedAt).toBeLessThanOrEqual(after);
  });

  it("remainingBudget returns Infinity when no budget set", () => {
    const ctx = createRequestContext("test");
    expect(remainingBudget(ctx)).toBe(Infinity);
  });

  it("remainingBudget decreases over time", async () => {
    const ctx = createRequestContext("test", { budgetMs: 100 });
    const before = remainingBudget(ctx);
    await new Promise(r => setTimeout(r, 20));
    const after = remainingBudget(ctx);
    expect(after).toBeLessThan(before);
  });

  it("elapsed returns time since start", async () => {
    const ctx = createRequestContext("test");
    await new Promise(r => setTimeout(r, 10));
    expect(elapsed(ctx)).toBeGreaterThanOrEqual(5);
  });
});

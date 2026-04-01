// Design: lightweight immutable context passed through call chain.
// reqId is 8-char hex for log readability (collision-safe for per-process scope).

import { randomBytes } from "node:crypto";

export interface RequestContext {
  /** Short unique ID for correlating logs across a single tool call */
  readonly reqId: string;
  /** MCP tool name that initiated this request */
  readonly toolName: string;
  /** Epoch ms when the request started */
  readonly startedAt: number;
  /** Optional session ID from hook system */
  readonly sessionId?: string;
  /** Maximum execution time budget in ms */
  readonly budgetMs?: number;
}

/**
 * Create a new request context for a tool invocation.
 *
 * Uses randomBytes for reqId (faster than randomUUID, no dashes to strip).
 * The 8-char hex gives 4 billion unique IDs — more than enough per-process.
 */
export function createRequestContext(toolName: string, opts?: {
  sessionId?: string;
  budgetMs?: number;
}): RequestContext {
  return {
    reqId: randomBytes(4).toString("hex"),
    toolName,
    startedAt: Date.now(),
    sessionId: opts?.sessionId,
    budgetMs: opts?.budgetMs,
  };
}

/**
 * Check if the request has exceeded its time budget.
 * Returns remaining ms, or 0 if expired. Returns Infinity if no budget set.
 */
export function remainingBudget(ctx: RequestContext): number {
  if (ctx.budgetMs === undefined) return Infinity;
  const elapsed = Date.now() - ctx.startedAt;
  return Math.max(0, ctx.budgetMs - elapsed);
}

/**
 * Elapsed time since request started, in ms.
 */
export function elapsed(ctx: RequestContext): number {
  return Date.now() - ctx.startedAt;
}

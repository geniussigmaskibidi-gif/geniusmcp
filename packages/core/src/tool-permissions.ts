export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type RateBudgetBucket = 'core' | 'search' | 'code_search' | 'graphql';

export interface PermissionDecision<TInput> {
  readonly behavior: PermissionBehavior;
  readonly updatedInput: TInput;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RateBudgetStatus {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly used?: number;
}

export interface RateBudgetSnapshot {
  readonly core?: RateBudgetStatus;
  readonly search?: RateBudgetStatus;
  readonly code_search?: RateBudgetStatus;
  readonly graphql?: RateBudgetStatus;
}

interface ForgeResultLike<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly message: string;
  };
}

export interface PermissionContext {
  readonly services?: {
    readonly gitHubGateway?: {
      getRateLimit: () => Promise<ForgeResultLike<RateBudgetSnapshot>>;
    };
    readonly policyEngine?: {
      evaluatePolicy?: (
        mode: string,
        license: string | null | undefined,
        signals: Readonly<Record<string, unknown>>,
      ) => Promise<unknown> | unknown;
    };
  };
  readonly logger?: {
    warn: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  };
}

export interface PolicyPermissionInput {
  readonly mode: string;
  readonly license?: string | null;
  readonly signals?: Readonly<Record<string, unknown>>;
}

export function allowPermission<TInput>(
  updatedInput: TInput,
  metadata?: Readonly<Record<string, unknown>>,
): PermissionDecision<TInput> {
  return {
    behavior: 'allow',
    updatedInput,
    metadata,
  };
}

export function denyPermission<TInput>(
  updatedInput: TInput,
  reason: string,
  metadata?: Readonly<Record<string, unknown>>,
): PermissionDecision<TInput> {
  return {
    behavior: 'deny',
    updatedInput,
    reason,
    metadata,
  };
}

export function askPermission<TInput>(
  updatedInput: TInput,
  reason: string,
  metadata?: Readonly<Record<string, unknown>>,
): PermissionDecision<TInput> {
  return {
    behavior: 'ask',
    updatedInput,
    reason,
    metadata,
  };
}

function normalizeRateBudget(snapshot: unknown): RateBudgetSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    return {};
  }
  const asRecord = snapshot as Record<string, unknown>;
  const coerce = (value: unknown): RateBudgetStatus | undefined => {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const limit = typeof record.limit === 'number' ? record.limit : 0;
    const remaining = typeof record.remaining === 'number' ? record.remaining : 0;
    const resetAt = typeof record.resetAt === 'string' ? record.resetAt : new Date(0).toISOString();
    const used = typeof record.used === 'number' ? record.used : undefined;
    return { limit, remaining, resetAt, used };
  };
  return {
    core: coerce(asRecord.core),
    search: coerce(asRecord.search),
    code_search: coerce(asRecord.code_search),
    graphql: coerce(asRecord.graphql),
  };
}

export async function checkRateBudget<TInput>(
  input: TInput,
  ctx: PermissionContext,
  bucket: RateBudgetBucket,
  minimumRemaining = 1,
): Promise<PermissionDecision<TInput>> {
  const gateway = ctx.services?.gitHubGateway;
  if (!gateway) {
    return allowPermission(input, { rateCheck: 'skipped', bucket });
  }

  const rateLimit = await gateway.getRateLimit();
  if (!rateLimit.ok) {
    ctx.logger?.warn('GitHub rate-limit lookup failed; allowing request.', rateLimit.error?.message ?? 'unknown');
    return allowPermission(input, { rateCheck: 'failed_open', bucket });
  }

  const snapshot = normalizeRateBudget(rateLimit.value);
  const budget = snapshot[bucket];
  if (!budget) {
    return allowPermission(input, { rateCheck: 'missing_bucket', bucket });
  }

  if (budget.remaining <= 0) {
    return denyPermission(
      input,
      `GitHub ${bucket} budget exhausted until ${budget.resetAt}`,
      { bucket, budget },
    );
  }

  if (budget.remaining < minimumRemaining) {
    return askPermission(
      input,
      `GitHub ${bucket} budget is low (${budget.remaining} remaining, resets ${budget.resetAt})`,
      { bucket, budget },
    );
  }

  return allowPermission(input, { bucket, budget });
}

export async function checkLicensePolicy<TInput extends PolicyPermissionInput>(
  input: TInput,
  ctx: PermissionContext,
): Promise<PermissionDecision<TInput>> {
  const evaluator = ctx.services?.policyEngine?.evaluatePolicy;
  if (!evaluator) {
    return allowPermission(input, { policyCheck: 'skipped' });
  }

  const decision = await evaluator(input.mode, input.license, input.signals ?? {});
  if (!decision || typeof decision !== 'object') {
    return allowPermission(input, { policyCheck: 'opaque_allow' });
  }

  const record = decision as Record<string, unknown>;
  const verdict = typeof record.verdict === 'string' ? record.verdict : 'allow';
  const reason = typeof record.reason === 'string' ? record.reason : undefined;

  if (verdict === 'deny') {
    return denyPermission(input, reason ?? 'License policy denied the operation', { policy: record });
  }
  if (verdict === 'ask' || verdict === 'review') {
    return askPermission(input, reason ?? 'License policy requires review', { policy: record });
  }
  return allowPermission(input, { policy: record });
}

export type ForgeSeverity = "info" | "warning" | "error";

export interface ForgeDiagnostic {
  readonly severity: ForgeSeverity;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface ForgeError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly suggestedAction?: string;
  readonly details?: unknown;
}

export interface ForgeSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly warnings?: readonly string[];
  readonly diagnostics?: readonly ForgeDiagnostic[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface ForgeFailure {
  readonly ok: false;
  readonly error: ForgeError;
  readonly warnings?: readonly string[];
  readonly diagnostics?: readonly ForgeDiagnostic[];
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type ForgeResult<T> = ForgeSuccess<T> | ForgeFailure;

export function forgeOk<T>(
  data: T,
  init: Omit<Partial<ForgeSuccess<T>>, "ok" | "data"> = {},
): ForgeSuccess<T> {
  return {
    ok: true,
    data,
    warnings: init.warnings,
    diagnostics: init.diagnostics,
    meta: init.meta,
  };
}

export function forgeFail(
  code: string,
  message: string,
  init: Omit<Partial<ForgeFailure>, "ok" | "error"> & {
    retryable?: boolean;
    suggestedAction?: string;
    details?: unknown;
  } = {},
): ForgeFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: init.retryable,
      suggestedAction: init.suggestedAction,
      details: init.details,
    },
    warnings: init.warnings,
    diagnostics: init.diagnostics,
    meta: init.meta,
  };
}

export function isForgeResult<T = unknown>(value: unknown): value is ForgeResult<T> {
  return Boolean(
    value &&
      typeof value === "object" &&
      "ok" in (value as Record<string, unknown>) &&
      typeof (value as { ok?: unknown }).ok === "boolean",
  );
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause:
        typeof (error as { cause?: unknown }).cause === "undefined"
          ? undefined
          : String((error as { cause?: unknown }).cause),
    };
  }

  return { message: String(error) };
}

export function fromUnknownError(
  error: unknown,
  fallbackCode = "tool_execution_failed",
  suggestedAction = "Inspect the diagnostics and retry with narrower input.",
): ForgeFailure {
  const payload = serializeError(error);
  return forgeFail(
    fallbackCode,
    typeof payload.message === "string" ? payload.message : "Unknown tool failure.",
    {
      retryable: true,
      suggestedAction,
      details: payload,
      diagnostics: [
        {
          severity: "error",
          code: fallbackCode,
          message: typeof payload.message === "string" ? payload.message : "Unknown tool failure.",
          details: payload,
        },
      ],
    },
  );
}

export async function captureForgeResult<T>(
  operation: () => Promise<T>,
  fallbackCode = "tool_execution_failed",
): Promise<ForgeResult<T>> {
  try {
    return forgeOk(await operation());
  } catch (error) {
    return fromUnknownError(error, fallbackCode);
  }
}

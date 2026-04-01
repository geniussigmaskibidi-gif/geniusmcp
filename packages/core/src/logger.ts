// Zero-dep: pino/winston add 200KB+ and we need <1ms overhead on hot paths.
// Design: JSON lines to stderr, level filtering, child loggers with bindings.
// Research: pino's architecture (fast-json-stringify), but simplified for our needs.

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  readonly module?: string;
  readonly reqId?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

const LEVEL_NUM: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  /** Create child logger with additional bound fields */
  child(bindings: Record<string, unknown>): Logger;
  /** Current minimum log level */
  readonly level: LogLevel;
}

export interface LoggerOptions {
  module: string;
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  /** Custom output sink for testing — defaults to process.stderr */
  sink?: (line: string) => void;
}

/**
 * Create a structured logger instance.
 *
 * Each log line is a single JSON object followed by newline (NDJSON).
 * Level filtering is O(1) via numeric comparison.
 * Child loggers inherit parent bindings + add their own.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const minLevel = LEVEL_NUM[opts.level ?? "info"];
  const base: Record<string, unknown> = { module: opts.module, ...opts.bindings };
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line));

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_NUM[level] < minLevel) return;

    const entry: Record<string, unknown> = {
      ts: Date.now(),
      level,
      msg,
      ...base,
    };

    // Merge data fields without Object.assign (avoids allocation on hot path)
    if (data) {
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]!;
        entry[k] = data[k];
      }
    }

    // Single write — no buffering, no async, minimal GC pressure
    sink(JSON.stringify(entry) + "\n");
  }

  return {
    level: opts.level ?? "info",
    trace: (msg, data) => emit("trace", msg, data),
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    fatal: (msg, data) => emit("fatal", msg, data),
    child(bindings) {
      return createLogger({
        module: opts.module,
        level: opts.level,
        bindings: { ...base, ...bindings },
        sink: opts.sink,
      });
    },
  };
}

/** No-op logger for testing or silent mode */
export function createNullLogger(): Logger {
  const noop = () => {};
  return {
    level: "fatal",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createNullLogger(),
  };
}

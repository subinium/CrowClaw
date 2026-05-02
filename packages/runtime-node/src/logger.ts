// ---------------------------------------------------------------------------
// Structured JSON logger — zero-dependency, pino-compatible API
// ---------------------------------------------------------------------------

import { getTelemetryHooks, redactStructuredData } from '@crowclaw/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  name?: string;
  level?: LogLevel;
}

/**
 * Create a structured JSON logger.
 *
 * Each log line is a single JSON object written to stdout (info/debug/warn)
 * or stderr (error/fatal). Child loggers inherit parent bindings so every
 * line emitted through a child carries the correlation context.
 */
export function createLogger(
  options: LoggerOptions = {},
  parentBindings: Record<string, unknown> = {},
): Logger {
  const minLevel = LEVEL_VALUES[options.level ?? 'info'];
  const bindings: Record<string, unknown> = {
    ...(options.name ? { name: options.name } : {}),
    ...parentBindings,
  };

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_VALUES[level] < minLevel) return;

    // #68 + #135: walk `data` through the centralized redactor before merging
    // into the log entry. Catches both key-name leaks (`{ token: '...' }`) and
    // string-content leaks (`{ message: 'Bearer sk-...' }`).
    const safeData = data ? redactStructuredData(data) : undefined;

    const entry: Record<string, unknown> = {
      level,
      time: Date.now(),
      ...bindings,
      msg,
      ...safeData,
    };
    const spanContext = getTelemetryHooks()?.getActiveSpan?.()?.spanContext?.();
    if (spanContext?.traceId) entry.traceId = spanContext.traceId;
    if (spanContext?.spanId) entry.spanId = spanContext.spanId;

    const line = JSON.stringify(entry) + '\n';

    if (LEVEL_VALUES[level] >= LEVEL_VALUES.error) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  return {
    debug: (msg, data) => emit('debug', msg, data),
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
    fatal: (msg, data) => emit('fatal', msg, data),
    child(childBindings) {
      return createLogger(
        { level: options.level },
        { ...bindings, ...childBindings },
      );
    },
  };
}

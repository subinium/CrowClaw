import { FileSecurityAuditLog, SecurityAuditLog } from '@crowclaw/core';
import type { MemoryProvider } from '@crowclaw/memory';
import type { GatewayDebouncer, SseSubscriber } from './runtime-support.js';
import type { WebSocketManager } from './websocket.js';

interface ProcessRef {
  off?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
}

export function createRuntimeShutdown(ctx: {
  sseSubscribers: Set<SseSubscriber>;
  wsManager: WebSocketManager;
  unsubscribeHeartbeatTracker: () => void;
  unsubscribeRuntimeTelemetryMetrics: () => void;
  clearContextRefresh: () => void;
  gatewayDebouncer: GatewayDebouncer;
  inFlightLearning: Set<Promise<void>>;
  memoryProvider: MemoryProvider;
  sighupListenerAttached: boolean;
  processRef?: ProcessRef;
  reloadSecretsOnSighup: () => void;
  securityAuditLog: SecurityAuditLog | FileSecurityAuditLog;
}): (timeoutMs?: number) => Promise<{ ssEClosed: number; learningAwaited: number; learningPending: number; debouncerFlushed: number }> {
  return async function shutdown(timeoutMs: number = 5_000) {
    const ssEClosed = ctx.sseSubscribers.size;
    for (const sub of ctx.sseSubscribers) {
      clearInterval(sub.heartbeat);
      sub.unsubscribe();
      try { sub.controller.close(); } catch {}
    }
    ctx.sseSubscribers.clear();

    try { ctx.wsManager.stop(); } catch {}
    try { ctx.unsubscribeHeartbeatTracker(); } catch {}
    try { ctx.unsubscribeRuntimeTelemetryMetrics(); } catch {}
    ctx.clearContextRefresh();
    const debouncerFlushed = ctx.gatewayDebouncer.flush();

    const pending = [...ctx.inFlightLearning];
    const learningAwaited = pending.length;
    if (pending.length > 0) {
      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), timeoutMs);
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref(): void }).unref();
      });
      await Promise.race([Promise.allSettled(pending), timeout]);
    }

    if (ctx.memoryProvider.shutdown) {
      try { await ctx.memoryProvider.shutdown(); } catch {}
    }
    if (ctx.sighupListenerAttached) {
      try {
        if (ctx.processRef?.off) ctx.processRef.off('SIGHUP', ctx.reloadSecretsOnSighup);
        else ctx.processRef?.removeListener?.('SIGHUP', ctx.reloadSecretsOnSighup);
      } catch {}
    }
    if (ctx.securityAuditLog instanceof FileSecurityAuditLog) {
      try { await ctx.securityAuditLog.drainWrites(); } catch {}
    }
    return {
      ssEClosed,
      learningAwaited,
      learningPending: ctx.inFlightLearning.size,
      debouncerFlushed,
    };
  };
}

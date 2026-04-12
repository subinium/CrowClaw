export interface CodeBridgeTranscriptEntry {
  toolName: string;
  ok: boolean;
  output: string;
  createdAt: string;
  transport?: 'runtime' | 'socket';
  executionMode?: 'direct-socket' | 'fallback-runtime' | 'runtime';
  requestedToolName?: string | null;
  canonicalToolName?: string | null;
  aliasApplied?: boolean;
  nestedDirectToolName?: string | null;
  nestedRequestedToolName?: string | null;
  nestedCanonicalToolName?: string | null;
  nestedAliasApplied?: boolean;
  nestedDirectToolExecution?: boolean;
}

export interface CodeBridgeSession {
  sessionId: string;
  maxToolCalls?: number;
  status: 'open' | 'busy' | 'closed';
  runtimeMode: 'simulated-bridge';
  processId: string;
  openedAt: string;
  lastActivityAt: string;
  lastHeartbeatAt?: string;
  idleTimeoutMs?: number;
  leaseExpiresAt?: string;
  closedAt?: string;
  reopenCount: number;
  activeCallCount: number;
  lastToolName?: string;
  transcript: CodeBridgeTranscriptEntry[];
}

export function ensureBridgeSession(
  sessions: Map<string, CodeBridgeSession>,
  sessionId: string,
  maxToolCalls?: number,
  idleTimeoutMs?: number
): CodeBridgeSession {
  const existing = sessions.get(sessionId);
  if (existing) {
    if (typeof maxToolCalls === 'number') {
      existing.maxToolCalls = maxToolCalls;
    }
    if (typeof idleTimeoutMs === 'number') {
      existing.idleTimeoutMs = idleTimeoutMs;
      existing.leaseExpiresAt = new Date(Date.now() + idleTimeoutMs).toISOString();
    }
    if (existing.status === 'closed') {
      existing.status = 'open';
      existing.closedAt = undefined;
      existing.transcript = [];
      existing.reopenCount += 1;
    }
    existing.lastActivityAt = new Date().toISOString();
    return existing;
  }

  const now = new Date().toISOString();
  const created: CodeBridgeSession = {
    sessionId,
    maxToolCalls,
    status: 'open',
    runtimeMode: 'simulated-bridge',
    processId: `bridge-${sessionId}-${Date.now()}`,
    openedAt: now,
    lastActivityAt: now,
    lastHeartbeatAt: now,
    idleTimeoutMs,
    leaseExpiresAt: typeof idleTimeoutMs === 'number' ? new Date(Date.now() + idleTimeoutMs).toISOString() : undefined,
    reopenCount: 0,
    activeCallCount: 0,
    transcript: []
  };
  sessions.set(sessionId, created);
  return created;
}

export function computeBridgeIdle(session: CodeBridgeSession, now = Date.now()): boolean {
  if (typeof session.idleTimeoutMs !== 'number') {
    return false;
  }
  return now - new Date(session.lastActivityAt).getTime() >= session.idleTimeoutMs;
}

export function markBridgeHeartbeat(session: CodeBridgeSession): void {
  const now = new Date().toISOString();
  session.lastHeartbeatAt = now;
  session.lastActivityAt = now;
  if (typeof session.idleTimeoutMs === 'number') {
    session.leaseExpiresAt = new Date(Date.now() + session.idleTimeoutMs).toISOString();
  }
}

export function getBridgeIdleInfo(session?: CodeBridgeSession): { idle: boolean; idleForMs: number; idleTimeoutMs?: number } {
  if (!session) {
    return { idle: false, idleForMs: 0, idleTimeoutMs: undefined };
  }
  const idleForMs = Math.max(Date.now() - new Date(session.lastActivityAt).getTime(), 0);
  return {
    idle: computeBridgeIdle(session),
    idleForMs,
    idleTimeoutMs: session.idleTimeoutMs
  };
}

export function getBridgeLeaseInfo(session?: CodeBridgeSession): { leaseExpiresAt?: string; leaseExpired: boolean } {
  if (!session?.leaseExpiresAt) {
    return { leaseExpiresAt: undefined, leaseExpired: false };
  }
  return {
    leaseExpiresAt: session.leaseExpiresAt,
    leaseExpired: new Date(session.leaseExpiresAt).getTime() <= Date.now()
  };
}

export function beginBridgeCall(session: CodeBridgeSession, toolName: string): void {
  session.status = 'busy';
  session.activeCallCount += 1;
  session.lastToolName = toolName;
  session.lastActivityAt = new Date().toISOString();
  if (typeof session.idleTimeoutMs === 'number') {
    session.leaseExpiresAt = new Date(Date.now() + session.idleTimeoutMs).toISOString();
  }
}

export function endBridgeCall(session: CodeBridgeSession): void {
  session.activeCallCount = Math.max(session.activeCallCount - 1, 0);
  session.status = session.activeCallCount > 0 ? 'busy' : 'open';
  session.lastActivityAt = new Date().toISOString();
  if (typeof session.idleTimeoutMs === 'number') {
    session.leaseExpiresAt = new Date(Date.now() + session.idleTimeoutMs).toISOString();
  }
}

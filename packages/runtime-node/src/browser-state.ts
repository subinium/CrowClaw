export interface BrowserSessionState {
  sessionId: string;
  currentUrl?: string;
  history: string[];
  lastSnapshot?: string;
  lastRefs: string[];
  updatedAt: string;
}

export function ensureBrowserSession(
  sessions: Map<string, BrowserSessionState>,
  sessionId: string
): BrowserSessionState {
  const existing = sessions.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: BrowserSessionState = {
    sessionId,
    history: [],
    lastRefs: [],
    updatedAt: new Date().toISOString()
  };
  sessions.set(sessionId, created);
  return created;
}

export function recordBrowserNavigation(session: BrowserSessionState, url: string): void {
  session.currentUrl = url;
  if (session.history.at(-1) !== url) {
    session.history.push(url);
  }
  session.updatedAt = new Date().toISOString();
}

export function resolveBrowserUrl(session: BrowserSessionState, explicitUrl?: string): string {
  return explicitUrl || session.currentUrl || '';
}

/**
 * #35: Drop browser sessions whose `updatedAt` is older than `maxAgeMs`.
 * Mirrors the prune-on-read pattern used by `getPendingPairingsMap` so
 * long-running runtimes don't accumulate dead browser sessions forever
 * (each entry holds history + lastSnapshot + lastRefs strings).
 */
export function pruneStaleBrowserSessions(
  sessions: Map<string, BrowserSessionState>,
  maxAgeMs: number = 60 * 60 * 1000, // 1 hour default
  now: number = Date.now(),
): number {
  let removed = 0;
  for (const [key, session] of sessions) {
    const ts = new Date(session.updatedAt).getTime();
    if (!Number.isFinite(ts)) continue;
    if (now - ts > maxAgeMs) {
      sessions.delete(key);
      removed++;
    }
  }
  return removed;
}

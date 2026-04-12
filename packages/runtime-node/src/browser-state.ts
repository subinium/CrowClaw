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

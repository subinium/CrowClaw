/**
 * Simple reactive state store for CrowClaw dashboard.
 * Uses CustomEvents for cross-component communication.
 */

export interface AppState {
  /** Current session ID */
  sessionId: string | null;
  /** List of sessions */
  sessions: SessionInfo[];
  /** Auth status */
  authenticated: boolean;
  /** Connection status */
  connected: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

const state: AppState = {
  sessionId: localStorage.getItem('cc_sid'),
  sessions: [],
  authenticated: false,
  connected: false,
};

type StateKey = keyof AppState;

export const getState = (): Readonly<AppState> => state;

export const setState = <K extends StateKey>(key: K, value: AppState[K]) => {
  (state as AppState)[key] = value;
  document.dispatchEvent(new CustomEvent(`crowclaw:state:${key}`, { detail: value }));
};

export const onStateChange = <K extends StateKey>(
  key: K,
  callback: (value: AppState[K]) => void,
): (() => void) => {
  const handler = (e: Event) => callback((e as CustomEvent).detail);
  document.addEventListener(`crowclaw:state:${key}`, handler);
  return () => document.removeEventListener(`crowclaw:state:${key}`, handler);
};

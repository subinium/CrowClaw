/**
 * Session control API client for the CrowClaw dashboard.
 *
 * Provides typed wrappers around the abort / compact / steer / list-active
 * REST endpoints exposed by the runtime.
 */

import { api } from './api.js';

export interface ActiveSessionInfo {
  sessionId: string;
  status: string;
  startedAt: string;
}

export interface AbortResponse {
  ok: boolean;
  aborted: boolean;
}

export interface CompactResponse {
  ok: boolean;
  originalMessageCount: number;
  compactedMessageCount: number;
  summary: string;
}

export interface SteerResponse {
  ok: boolean;
  injectedPrompt: string;
}

export interface ActiveSessionsResponse {
  sessions: ActiveSessionInfo[];
}

export interface SessionControlApi {
  abort(sessionId: string): Promise<AbortResponse>;
  compact(sessionId: string, keepLastN?: number): Promise<CompactResponse>;
  steer(sessionId: string, directive: string): Promise<SteerResponse>;
  getActiveSessions(): Promise<ActiveSessionsResponse>;
}

export const createSessionControlApi = (baseUrl?: string): SessionControlApi => {
  const prefix = baseUrl ?? '';

  return {
    async abort(sessionId: string): Promise<AbortResponse> {
      return api<AbortResponse>(`${prefix}/api/sessions/${sessionId}/abort`, {
        method: 'POST',
      });
    },

    async compact(sessionId: string, keepLastN?: number): Promise<CompactResponse> {
      const body: Record<string, unknown> = {};
      if (keepLastN !== undefined) {
        body.keepLastN = keepLastN;
      }
      return api<CompactResponse>(`${prefix}/api/sessions/${sessionId}/compact`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async steer(sessionId: string, directive: string): Promise<SteerResponse> {
      return api<SteerResponse>(`${prefix}/api/sessions/${sessionId}/steer`, {
        method: 'POST',
        body: JSON.stringify({ directive }),
      });
    },

    async getActiveSessions(): Promise<ActiveSessionsResponse> {
      return api<ActiveSessionsResponse>(`${prefix}/api/sessions/active`);
    },
  };
};

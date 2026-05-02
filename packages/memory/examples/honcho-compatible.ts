import { createMemoryBackendPlugin } from '@crowclaw/plugins';

export interface HonchoCompatibleClient {
  search(input: {
    sessionId: string;
    query: string;
    limit: number;
    scope?: string;
    scopeKey?: string;
  }): Promise<unknown[]>;
  remember(record: Record<string, unknown>): Promise<unknown>;
  forget(id: string): Promise<boolean>;
  list(input: { sessionId: string; scope?: string; limit?: number }): Promise<unknown[]>;
  syncTurn?(sessionId: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
}

export function createHonchoCompatibleMemoryPlugin(client: HonchoCompatibleClient) {
  return createMemoryBackendPlugin({
    name: 'honcho-compatible-memory',
    version: '0.1.0',
    description: 'Reference adapter for a Honcho-compatible external memory backend.',
    provider: {
      recall(sessionId, query, limit, scope, scopeKey) {
        return client.search({ sessionId, query, limit, scope, scopeKey });
      },
      store(record) {
        return client.remember(record);
      },
      delete(id) {
        return client.forget(id);
      },
      list(sessionId, scope, limit) {
        return client.list({ sessionId, scope, limit });
      },
      sync_turn(sessionId, summary, metadata) {
        return client.syncTurn?.(sessionId, summary, metadata) ?? Promise.resolve();
      },
      shutdown() {
        return client.close?.() ?? Promise.resolve();
      },
    },
  });
}

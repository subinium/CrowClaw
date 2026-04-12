import type { ConversationMessage } from '@crowclaw/core';
import type { MemoryRecord, MemoryStore } from '@crowclaw/storage';

export interface MemoryNote {
  scope: 'session' | 'user' | 'workspace';
  summary: string;
  messages: number;
  tags: string[];
}

function uniqueTags(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
}

export class MemoryService {
  constructor(private readonly store?: MemoryStore) {}

  summarize(messages: ConversationMessage[], scope: MemoryNote['scope'] = 'session'): MemoryNote {
    const recentText = messages
      .slice(-4)
      .map((message) => message.content)
      .join(' ')
      .trim();

    const tags = uniqueTags(
      recentText
        .split(/\W+/)
        .filter((token) => token.length >= 4)
        .slice(0, 8)
    );

    return {
      scope,
      summary: `Recent activity: ${recentText.slice(0, 200)}`,
      messages: messages.length,
      tags
    };
  }

  async captureSessionSummary(sessionId: string, messages: ConversationMessage[]): Promise<MemoryRecord | null> {
    return this.captureScopedSummary('session', sessionId, messages);
  }

  async captureScopedSummary(scope: MemoryRecord['scope'], sessionId: string, messages: ConversationMessage[], scopeKey?: string): Promise<MemoryRecord | null> {
    if (!this.store || messages.length === 0) {
      return null;
    }

    const note = this.summarize(messages, scope);
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope: note.scope,
      scopeKey,
      summary: note.summary,
      tags: note.tags,
      createdAt: new Date().toISOString(),
      metadata: { messages: note.messages }
    };

    await this.store.write(record);
    return record;
  }

  async remember(sessionId: string, summary: string, tags: string[] = [], metadata?: Record<string, unknown>, scope: MemoryRecord['scope'] = 'session', scopeKey?: string): Promise<MemoryRecord> {
    if (!this.store) {
      throw new Error('Memory store not configured.');
    }

    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope,
      scopeKey,
      summary,
      tags: uniqueTags(tags),
      createdAt: new Date().toISOString(),
      metadata
    };

    await this.store.write(record);
    return record;
  }

  async recall(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    return this.store.search(sessionId, query, limit);
  }

  async recallByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    return this.store.searchByScope(scope, query, limit, scopeKey);
  }

  async list(sessionId: string, limit = 50): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    return (await this.store.list(sessionId)).slice(0, limit);
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    return this.store.listByScope(scope, limit, scopeKey);
  }
}

export { MarkdownMemoryStore, type MarkdownMemoryRecord, type MarkdownMemoryFileSystem } from './markdown-store.js';

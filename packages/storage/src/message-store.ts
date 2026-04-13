export interface StoredMessage {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  createdAt: string;
  tokens?: number;
  costUsd?: number;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageQuery {
  sessionId: string;
  role?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface MessageStats {
  sessionId: string;
  totalMessages: number;
  totalTokens: number;
  totalCostUsd: number;
  byRole: Record<string, number>;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

export interface MessageStore {
  /** Append a message to a session */
  append(message: StoredMessage): Promise<void>;

  /** Append multiple messages at once */
  appendBatch(messages: StoredMessage[]): Promise<void>;

  /** Get messages for a session with optional filtering */
  query(query: MessageQuery): Promise<StoredMessage[]>;

  /** Get a single message by ID */
  getById(id: string): Promise<StoredMessage | null>;

  /** Full-text search across messages in a session */
  search(sessionId: string, query: string, limit?: number): Promise<StoredMessage[]>;

  /** Search across ALL sessions */
  searchAll(query: string, limit?: number): Promise<StoredMessage[]>;

  /** Get stats for a session */
  stats(sessionId: string): Promise<MessageStats>;

  /** Delete all messages for a session */
  deleteSession(sessionId: string): Promise<number>;

  /** Get lineage: messages that descend from a compression */
  getLineage(parentId: string): Promise<StoredMessage[]>;
}

function sortByCreatedAt(messages: StoredMessage[]): StoredMessage[] {
  return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export class InMemoryMessageStore implements MessageStore {
  private messages = new Map<string, StoredMessage[]>();
  private byId = new Map<string, StoredMessage>();

  async append(message: StoredMessage): Promise<void> {
    const existing = this.messages.get(message.sessionId) ?? [];
    existing.push(message);
    this.messages.set(message.sessionId, existing);
    this.byId.set(message.id, message);
  }

  async appendBatch(messages: StoredMessage[]): Promise<void> {
    for (const message of messages) {
      await this.append(message);
    }
  }

  async query(q: MessageQuery): Promise<StoredMessage[]> {
    let results = sortByCreatedAt(this.messages.get(q.sessionId) ?? []);

    if (q.role) {
      results = results.filter((m) => m.role === q.role);
    }

    if (q.after) {
      const after = q.after;
      results = results.filter((m) => m.createdAt > after);
    }

    if (q.before) {
      const before = q.before;
      results = results.filter((m) => m.createdAt < before);
    }

    if (q.search) {
      const needle = q.search.toLowerCase();
      results = results.filter((m) => m.content.toLowerCase().includes(needle));
    }

    const offset = q.offset ?? 0;
    const limit = q.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  async getById(id: string): Promise<StoredMessage | null> {
    return this.byId.get(id) ?? null;
  }

  async search(sessionId: string, query: string, limit = 50): Promise<StoredMessage[]> {
    const needle = query.toLowerCase();
    const sessionMessages = sortByCreatedAt(this.messages.get(sessionId) ?? []);
    return sessionMessages
      .filter((m) => m.content.toLowerCase().includes(needle))
      .slice(0, limit);
  }

  async searchAll(query: string, limit = 50): Promise<StoredMessage[]> {
    const needle = query.toLowerCase();
    const all: StoredMessage[] = [];
    for (const messages of this.messages.values()) {
      for (const m of messages) {
        if (m.content.toLowerCase().includes(needle)) {
          all.push(m);
        }
      }
    }
    return sortByCreatedAt(all).slice(0, limit);
  }

  async stats(sessionId: string): Promise<MessageStats> {
    const messages = sortByCreatedAt(this.messages.get(sessionId) ?? []);
    const byRole: Record<string, number> = {};
    let totalTokens = 0;
    let totalCostUsd = 0;

    for (const m of messages) {
      byRole[m.role] = (byRole[m.role] ?? 0) + 1;
      totalTokens += m.tokens ?? 0;
      totalCostUsd += m.costUsd ?? 0;
    }

    return {
      sessionId,
      totalMessages: messages.length,
      totalTokens,
      totalCostUsd,
      byRole,
      firstMessageAt: messages.length > 0 ? messages[0]!.createdAt : null,
      lastMessageAt: messages.length > 0 ? messages[messages.length - 1]!.createdAt : null,
    };
  }

  async deleteSession(sessionId: string): Promise<number> {
    const existing = this.messages.get(sessionId);
    if (!existing || existing.length === 0) {
      return 0;
    }
    const count = existing.length;
    for (const m of existing) {
      this.byId.delete(m.id);
    }
    this.messages.delete(sessionId);
    return count;
  }

  async getLineage(parentId: string): Promise<StoredMessage[]> {
    const children: StoredMessage[] = [];
    for (const m of this.byId.values()) {
      if (m.parentId === parentId) {
        children.push(m);
      }
    }
    return sortByCreatedAt(children);
  }
}

/** SQL schema for D1/SQLite message store */
export const MESSAGE_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  tokens INTEGER,
  cost_usd REAL,
  parent_id TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, session_id UNINDEXED, id UNINDEXED
);
`;

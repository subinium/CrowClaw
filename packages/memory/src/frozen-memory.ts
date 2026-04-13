import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrozenMemoryEntry {
  key: string;
  value: string;
  category?: string; // e.g., 'fact', 'preference', 'context'
  updatedAt: string;
  source?: string; // sessionId that last updated this
}

export interface FrozenSnapshot {
  entries: FrozenMemoryEntry[];
  frozenAt: string;
  version: number;
}

export interface FrozenMemoryStore {
  /** Load the current snapshot */
  load(namespace: string): Promise<FrozenSnapshot | null>;
  /** Persist the current snapshot */
  save(namespace: string, snapshot: FrozenSnapshot): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryFrozenStore
// ---------------------------------------------------------------------------

export class InMemoryFrozenStore implements FrozenMemoryStore {
  private readonly store = new Map<string, FrozenSnapshot>();

  async load(namespace: string): Promise<FrozenSnapshot | null> {
    return this.store.get(namespace) ?? null;
  }

  async save(namespace: string, snapshot: FrozenSnapshot): Promise<void> {
    this.store.set(namespace, snapshot);
  }
}

// ---------------------------------------------------------------------------
// FileFrozenStore
// ---------------------------------------------------------------------------

export class FileFrozenStore implements FrozenMemoryStore {
  constructor(private readonly basePath: string) {}

  private filePath(namespace: string): string {
    return join(this.basePath, `${namespace}.json`);
  }

  async load(namespace: string): Promise<FrozenSnapshot | null> {
    try {
      const raw = await readFile(this.filePath(namespace), 'utf-8');
      return JSON.parse(raw) as FrozenSnapshot;
    } catch {
      return null;
    }
  }

  async save(namespace: string, snapshot: FrozenSnapshot): Promise<void> {
    const fp = this.filePath(namespace);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, JSON.stringify(snapshot, null, 2), 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// FrozenMemory
// ---------------------------------------------------------------------------

export class FrozenMemory {
  private entries = new Map<string, FrozenMemoryEntry>();
  private version = 0;
  private frozenAt: string | null = null;

  constructor(
    private readonly store: FrozenMemoryStore,
    private readonly namespace: string
  ) {}

  /** Load snapshot from store. Call at session start. */
  async load(): Promise<void> {
    const snapshot = await this.store.load(this.namespace);
    if (!snapshot) {
      return;
    }

    this.entries.clear();
    for (const entry of snapshot.entries) {
      this.entries.set(entry.key, entry);
    }
    this.version = snapshot.version;
    this.frozenAt = snapshot.frozenAt;
  }

  /** Add a new entry. Error if key exists (use replace). */
  add(key: string, value: string, category?: string, source?: string): void {
    if (this.entries.has(key)) {
      throw new Error(`Key "${key}" already exists. Use replace() to update.`);
    }

    this.entries.set(key, {
      key,
      value,
      category,
      updatedAt: new Date().toISOString(),
      source,
    });
  }

  /** Replace an existing entry's value. Error if key doesn't exist. */
  replace(key: string, newValue: string, source?: string): void {
    const existing = this.entries.get(key);
    if (!existing) {
      throw new Error(`Key "${key}" does not exist. Use add() to create.`);
    }

    this.entries.set(key, {
      ...existing,
      value: newValue,
      updatedAt: new Date().toISOString(),
      source: source ?? existing.source,
    });
  }

  /** Remove an entry by key. No-op if key doesn't exist. */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /** Upsert: add if new, replace if exists. */
  set(key: string, value: string, category?: string, source?: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.set(key, {
        ...existing,
        value,
        category: category ?? existing.category,
        updatedAt: new Date().toISOString(),
        source: source ?? existing.source,
      });
    } else {
      this.entries.set(key, {
        key,
        value,
        category,
        updatedAt: new Date().toISOString(),
        source,
      });
    }
  }

  /** Get a single entry by key. */
  get(key: string): FrozenMemoryEntry | undefined {
    return this.entries.get(key);
  }

  /** Get all entries sorted by updatedAt descending (newest first). */
  getAll(): FrozenMemoryEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  /** Search entries by query (substring match on key + value). */
  search(query: string, limit?: number): FrozenMemoryEntry[] {
    const needle = query.toLowerCase();
    const matches = [...this.entries.values()].filter(
      (entry) =>
        entry.key.toLowerCase().includes(needle) ||
        entry.value.toLowerCase().includes(needle)
    );
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return limit !== undefined ? matches.slice(0, limit) : matches;
  }

  /** Persist current state to store. Call at session end. */
  async save(source?: string): Promise<void> {
    this.version += 1;
    this.frozenAt = new Date().toISOString();

    // Stamp source on entries that lack one, if provided
    if (source) {
      for (const entry of this.entries.values()) {
        if (!entry.source) {
          entry.source = source;
        }
      }
    }

    const snapshot: FrozenSnapshot = {
      entries: this.getAll(),
      frozenAt: this.frozenAt,
      version: this.version,
    };

    await this.store.save(this.namespace, snapshot);
  }

  /** Format as MEMORY.md-style frozen text for prompt injection. */
  formatForPrompt(): string {
    const all = this.getAll();
    if (all.length === 0) {
      return '';
    }

    const header = `## Memory Snapshot (v${this.version}, frozen ${this.frozenAt ?? 'never'})`;
    const tableHeader = '| Key | Value | Category |';
    const separator = '|-----|-------|----------|';
    const rows = all.map(
      (entry) =>
        `| ${entry.key} | ${entry.value} | ${entry.category ?? ''} |`
    );

    return [header, '', tableHeader, separator, ...rows].join('\n');
  }

  /** Apply bounded size limit: keep most recently updated entries up to maxEntries. */
  prune(maxEntries = 100): number {
    if (this.entries.size <= maxEntries) {
      return 0;
    }

    const sorted = this.getAll(); // already sorted newest-first
    const toRemove = sorted.slice(maxEntries);

    for (const entry of toRemove) {
      this.entries.delete(entry.key);
    }

    return toRemove.length;
  }

  get size(): number {
    return this.entries.size;
  }

  get snapshotVersion(): number {
    return this.version;
  }
}

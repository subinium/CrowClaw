import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FrozenMemory,
  InMemoryFrozenStore,
  FileFrozenStore,
  type FrozenSnapshot,
} from '@crowclaw/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMemory(store?: InMemoryFrozenStore, namespace = 'test'): FrozenMemory {
  return new FrozenMemory(store ?? new InMemoryFrozenStore(), namespace);
}

// ---------------------------------------------------------------------------
// FrozenMemory — core operations
// ---------------------------------------------------------------------------

describe('FrozenMemory', () => {
  let store: InMemoryFrozenStore;
  let memory: FrozenMemory;

  beforeEach(() => {
    store = new InMemoryFrozenStore();
    memory = createMemory(store);
  });

  it('add creates new entry', () => {
    memory.add('lang', 'TypeScript', 'preference');
    const entry = memory.get('lang');
    expect(entry).toBeDefined();
    expect(entry!.key).toBe('lang');
    expect(entry!.value).toBe('TypeScript');
    expect(entry!.category).toBe('preference');
  });

  it('add throws for duplicate key', () => {
    memory.add('lang', 'TypeScript');
    expect(() => memory.add('lang', 'Rust')).toThrow(/already exists/);
  });

  it('replace updates existing entry', () => {
    memory.add('lang', 'TypeScript');
    memory.replace('lang', 'Rust');
    expect(memory.get('lang')!.value).toBe('Rust');
  });

  it('replace throws for missing key', () => {
    expect(() => memory.replace('missing', 'value')).toThrow(/does not exist/);
  });

  it('set upserts — adds when new', () => {
    memory.set('editor', 'vim');
    expect(memory.get('editor')!.value).toBe('vim');
  });

  it('set upserts — replaces when existing', () => {
    memory.add('editor', 'vim');
    memory.set('editor', 'neovim');
    expect(memory.get('editor')!.value).toBe('neovim');
    expect(memory.size).toBe(1);
  });

  it('set preserves existing category when none provided on update', () => {
    memory.add('editor', 'vim', 'preference');
    memory.set('editor', 'neovim');
    expect(memory.get('editor')!.category).toBe('preference');
  });

  it('remove deletes entry', () => {
    memory.add('tmp', 'data');
    memory.remove('tmp');
    expect(memory.get('tmp')).toBeUndefined();
    expect(memory.size).toBe(0);
  });

  it('remove is no-op for missing key', () => {
    memory.add('keep', 'value');
    memory.remove('nonexistent');
    expect(memory.size).toBe(1);
  });

  it('get returns entry by key', () => {
    memory.add('k1', 'v1');
    expect(memory.get('k1')!.value).toBe('v1');
    expect(memory.get('missing')).toBeUndefined();
  });

  it('getAll returns all entries sorted by updatedAt descending', async () => {
    // Manually stagger timestamps so ordering is deterministic
    memory.add('old', 'first');
    // Nudge the internal timestamp forward
    await new Promise((r) => setTimeout(r, 5));
    memory.add('new', 'second');

    const all = memory.getAll();
    expect(all).toHaveLength(2);
    // Newest first
    expect(all[0]!.key).toBe('new');
    expect(all[1]!.key).toBe('old');
  });

  it('search finds by key and value substring', () => {
    memory.add('fav-lang', 'TypeScript is great');
    memory.add('fav-editor', 'Neovim rules');
    memory.add('hobby', 'reading books');

    const byKey = memory.search('fav');
    expect(byKey).toHaveLength(2);

    const byValue = memory.search('books');
    expect(byValue).toHaveLength(1);
    expect(byValue[0]!.key).toBe('hobby');
  });

  it('search respects limit', () => {
    memory.add('a', 'match');
    memory.add('b', 'match');
    memory.add('c', 'match');

    const results = memory.search('match', 2);
    expect(results).toHaveLength(2);
  });

  it('search is case-insensitive', () => {
    memory.add('DB', 'PostgreSQL');
    const results = memory.search('postgresql');
    expect(results).toHaveLength(1);
  });

  it('size reflects current count', () => {
    expect(memory.size).toBe(0);
    memory.add('a', '1');
    expect(memory.size).toBe(1);
    memory.add('b', '2');
    expect(memory.size).toBe(2);
    memory.remove('a');
    expect(memory.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  it('save persists to store with incremented version', async () => {
    memory.add('k', 'v');
    expect(memory.snapshotVersion).toBe(0);

    await memory.save();
    expect(memory.snapshotVersion).toBe(1);

    await memory.save();
    expect(memory.snapshotVersion).toBe(2);
  });

  it('load populates from store', async () => {
    memory.add('lang', 'TS', 'preference');
    await memory.save();

    const fresh = createMemory(store);
    await fresh.load();
    expect(fresh.size).toBe(1);
    expect(fresh.get('lang')!.value).toBe('TS');
    expect(fresh.get('lang')!.category).toBe('preference');
  });

  it('save + load round-trip preserves all entries', async () => {
    memory.add('a', 'alpha', 'fact', 'session-1');
    memory.add('b', 'beta', 'context');
    memory.add('c', 'gamma');
    await memory.save('session-1');

    const loaded = createMemory(store);
    await loaded.load();
    expect(loaded.size).toBe(3);
    expect(loaded.get('a')!.value).toBe('alpha');
    expect(loaded.get('a')!.source).toBe('session-1');
    expect(loaded.get('b')!.value).toBe('beta');
    expect(loaded.get('c')!.value).toBe('gamma');
    expect(loaded.snapshotVersion).toBe(1);
  });

  it('load on empty store is a no-op', async () => {
    await memory.load();
    expect(memory.size).toBe(0);
    expect(memory.snapshotVersion).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // formatForPrompt
  // ---------------------------------------------------------------------------

  it('formatForPrompt produces markdown table', async () => {
    memory.add('lang', 'TypeScript', 'preference');
    memory.add('os', 'macOS');
    await memory.save();

    const output = memory.formatForPrompt();
    expect(output).toContain('## Memory Snapshot');
    expect(output).toContain('v1');
    expect(output).toContain('| Key | Value | Category |');
    expect(output).toContain('| lang | TypeScript | preference |');
    expect(output).toContain('| os | macOS |  |');
  });

  it('formatForPrompt returns empty string when no entries', () => {
    expect(memory.formatForPrompt()).toBe('');
  });

  // ---------------------------------------------------------------------------
  // prune
  // ---------------------------------------------------------------------------

  it('prune keeps most recent entries within limit', async () => {
    for (let i = 0; i < 10; i++) {
      memory.add(`key-${i}`, `value-${i}`);
      // Ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(memory.size).toBe(10);

    const removed = memory.prune(5);
    expect(removed).toBe(5);
    expect(memory.size).toBe(5);

    // The 5 most recent entries should remain (key-5 through key-9)
    for (let i = 5; i < 10; i++) {
      expect(memory.get(`key-${i}`)).toBeDefined();
    }
    for (let i = 0; i < 5; i++) {
      expect(memory.get(`key-${i}`)).toBeUndefined();
    }
  });

  it('prune returns 0 when under limit', () => {
    memory.add('a', '1');
    const removed = memory.prune(100);
    expect(removed).toBe(0);
    expect(memory.size).toBe(1);
  });

  it('prune defaults to 100', () => {
    for (let i = 0; i < 50; i++) {
      memory.add(`key-${i}`, `value-${i}`);
    }
    const removed = memory.prune();
    expect(removed).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // version tracking
  // ---------------------------------------------------------------------------

  it('snapshotVersion starts at 0 and increments on save', async () => {
    expect(memory.snapshotVersion).toBe(0);
    memory.add('a', '1');
    await memory.save();
    expect(memory.snapshotVersion).toBe(1);
    memory.add('b', '2');
    await memory.save();
    expect(memory.snapshotVersion).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // source tracking
  // ---------------------------------------------------------------------------

  it('add records source on entry', () => {
    memory.add('fact', 'earth is round', 'fact', 'session-42');
    expect(memory.get('fact')!.source).toBe('session-42');
  });

  it('replace updates source when provided', () => {
    memory.add('fact', 'old value', undefined, 'session-1');
    memory.replace('fact', 'new value', 'session-2');
    expect(memory.get('fact')!.source).toBe('session-2');
  });

  it('replace preserves source when not provided', () => {
    memory.add('fact', 'old value', undefined, 'session-1');
    memory.replace('fact', 'new value');
    expect(memory.get('fact')!.source).toBe('session-1');
  });

  it('save stamps source on entries that lack one', async () => {
    memory.add('no-source', 'value');
    expect(memory.get('no-source')!.source).toBeUndefined();

    await memory.save('session-99');
    expect(memory.get('no-source')!.source).toBe('session-99');
  });
});

// ---------------------------------------------------------------------------
// InMemoryFrozenStore
// ---------------------------------------------------------------------------

describe('InMemoryFrozenStore', () => {
  it('returns null for unknown namespace', async () => {
    const store = new InMemoryFrozenStore();
    const result = await store.load('unknown');
    expect(result).toBeNull();
  });

  it('saves and loads snapshot', async () => {
    const store = new InMemoryFrozenStore();
    const snapshot: FrozenSnapshot = {
      entries: [{ key: 'k', value: 'v', updatedAt: new Date().toISOString() }],
      frozenAt: new Date().toISOString(),
      version: 1,
    };

    await store.save('ns', snapshot);
    const loaded = await store.load('ns');
    expect(loaded).toEqual(snapshot);
  });

  it('isolates namespaces', async () => {
    const store = new InMemoryFrozenStore();
    await store.save('a', {
      entries: [{ key: 'k', value: 'alpha', updatedAt: new Date().toISOString() }],
      frozenAt: new Date().toISOString(),
      version: 1,
    });
    await store.save('b', {
      entries: [{ key: 'k', value: 'beta', updatedAt: new Date().toISOString() }],
      frozenAt: new Date().toISOString(),
      version: 1,
    });

    const a = await store.load('a');
    const b = await store.load('b');
    expect(a!.entries[0]!.value).toBe('alpha');
    expect(b!.entries[0]!.value).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// FileFrozenStore
// ---------------------------------------------------------------------------

describe('FileFrozenStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'frozen-memory-test-'));
  });

  // Clean up after tests — ignore errors if dir already removed
  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('returns null when file does not exist', async () => {
    const fileStore = new FileFrozenStore(tmpDir);
    const result = await fileStore.load('nonexistent');
    expect(result).toBeNull();
  });

  it('persists to disk and loads back', async () => {
    const fileStore = new FileFrozenStore(tmpDir);
    const snapshot: FrozenSnapshot = {
      entries: [
        { key: 'lang', value: 'TypeScript', category: 'preference', updatedAt: new Date().toISOString() },
        { key: 'os', value: 'macOS', updatedAt: new Date().toISOString() },
      ],
      frozenAt: new Date().toISOString(),
      version: 3,
    };

    await fileStore.save('memory', snapshot);
    const loaded = await fileStore.load('memory');
    expect(loaded).toEqual(snapshot);
  });

  it('round-trips through FrozenMemory', async () => {
    const fileStore = new FileFrozenStore(tmpDir);
    const mem = new FrozenMemory(fileStore, 'user-profile');

    mem.add('name', 'Alice', 'fact');
    mem.add('role', 'Engineer', 'fact');
    await mem.save('session-1');

    // Load into a fresh instance
    const fresh = new FrozenMemory(fileStore, 'user-profile');
    await fresh.load();
    expect(fresh.size).toBe(2);
    expect(fresh.get('name')!.value).toBe('Alice');
    expect(fresh.get('role')!.value).toBe('Engineer');
    expect(fresh.snapshotVersion).toBe(1);
  });

  it('creates nested directories as needed', async () => {
    const nested = join(tmpDir, 'deep', 'nested', 'dir');
    const fileStore = new FileFrozenStore(nested);

    await fileStore.save('test', {
      entries: [],
      frozenAt: new Date().toISOString(),
      version: 0,
    });

    const loaded = await fileStore.load('test');
    expect(loaded).toBeDefined();
    expect(loaded!.version).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { InMemoryDreamStore } from '../packages/memory/src/index.js';

describe('InMemoryDreamStore', () => {
  it('addLive stores session summaries', async () => {
    const store = new InMemoryDreamStore();
    await store.addLive('session-1', 'User asked about TypeScript generics');

    // Live entries are not in long-term yet
    const longTerm = await store.getLongTerm();
    expect(longTerm).toHaveLength(0);

    // But consolidation should pick them up
    const consolidated = await store.consolidate();
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0].content).toContain('TypeScript generics');
    expect(consolidated[0].source).toBe('consolidation');
    expect(consolidated[0].sourceSessionIds).toContain('session-1');
  });

  it('consolidate merges live entries into long-term', async () => {
    const store = new InMemoryDreamStore();
    await store.addLive('s1', 'Summary A');
    await store.addLive('s2', 'Summary B');

    const newEntries = await store.consolidate();
    expect(newEntries.length).toBeGreaterThanOrEqual(1);

    // After consolidation, live should be cleared
    const secondConsolidate = await store.consolidate();
    expect(secondConsolidate).toHaveLength(0);

    // Long-term should have the consolidated entries
    const longTerm = await store.getLongTerm();
    expect(longTerm.length).toBeGreaterThanOrEqual(1);
  });

  it('getLongTerm returns consolidated entries', async () => {
    const store = new InMemoryDreamStore();
    await store.addLive('s1', 'First session summary');
    await store.consolidate();

    await store.addLive('s2', 'Second session summary');
    await store.consolidate();

    const longTerm = await store.getLongTerm();
    expect(longTerm).toHaveLength(2);
    // Both entries should be present
    const allContent = longTerm.map((e) => e.content).join(' ');
    expect(allContent).toContain('First session summary');
    expect(allContent).toContain('Second session summary');
  });

  it('getLongTerm respects limit parameter', async () => {
    const store = new InMemoryDreamStore();
    for (let i = 0; i < 5; i++) {
      await store.addLive(`s${i}`, `Summary ${i}`);
      await store.consolidate();
    }

    const limited = await store.getLongTerm(2);
    expect(limited).toHaveLength(2);
  });

  it('formatForPrompt returns markdown', async () => {
    const store = new InMemoryDreamStore();
    await store.addLive('sess-a', 'Discussed deployment pipeline');
    await store.consolidate();

    const prompt = await store.formatForPrompt();
    expect(prompt).toContain('## Long-term Memory');
    expect(prompt).toContain('Discussed deployment pipeline');
    expect(prompt).toContain('sess-a');
    expect(prompt).toContain('[consolidation]');
  });

  it('empty store returns empty results', async () => {
    const store = new InMemoryDreamStore();

    const longTerm = await store.getLongTerm();
    expect(longTerm).toHaveLength(0);

    const prompt = await store.formatForPrompt();
    expect(prompt).toBe('');

    const consolidated = await store.consolidate();
    expect(consolidated).toHaveLength(0);
  });

  it('multiple sessions consolidate correctly', async () => {
    const store = new InMemoryDreamStore();
    await store.addLive('s1', 'Auth flow discussion');
    await store.addLive('s2', 'Database schema review');
    await store.addLive('s3', 'API endpoint design');

    const entries = await store.consolidate();
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // All source sessions should be tracked
    const allSourceIds = entries.flatMap((e) => e.sourceSessionIds);
    expect(allSourceIds).toContain('s1');
    expect(allSourceIds).toContain('s2');
    expect(allSourceIds).toContain('s3');

    // All content should be present (merged with ' | ' separator)
    const allContent = entries.map((e) => e.content).join(' ');
    expect(allContent).toContain('Auth flow discussion');
    expect(allContent).toContain('Database schema review');
    expect(allContent).toContain('API endpoint design');

    // Long-term should now have entries
    const longTerm = await store.getLongTerm();
    expect(longTerm.length).toBe(entries.length);

    // Each entry should have consolidation metadata
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
      expect(entry.consolidatedAt).toBeTruthy();
    }
  });
});

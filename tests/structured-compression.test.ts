import { describe, expect, it } from 'vitest';
import {
  compressWithStructure,
  mergeStructuredSummaries,
  formatStructuredSummary,
  type StructuredSummary,
  type ConversationMessage,
} from '@crowclaw/core';

function msg(
  role: ConversationMessage['role'],
  content: string,
  extra?: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe('compressWithStructure', () => {
  it('compresses middle messages and preserves head and tail', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'You are a helpful assistant.'),
      msg('user', 'Hello'),
      msg('assistant', 'Hi there! How can I help?'),
      msg('user', 'What is 2+2?'),
      msg('assistant', 'The answer is 4.'),
      msg('user', 'Thanks'),
      msg('assistant', 'You are welcome.'),
      msg('user', 'Tell me about TypeScript'),
      msg('assistant', 'TypeScript is a typed superset of JavaScript.'),
      msg('user', 'Great'),
      msg('assistant', 'Glad to help!'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 2,
      protectLastMessages: 4,
    });

    // Head: first 2 messages
    expect(result.messages[0].content).toBe('You are a helpful assistant.');
    expect(result.messages[1].content).toBe('Hello');

    // Summary message in the middle
    expect(result.messages[2].role).toBe('system');
    expect(result.messages[2].content).toContain('Structured conversation summary');

    // Tail: last 4 messages
    const tail = result.messages.slice(-4);
    expect(tail[0].content).toBe('Tell me about TypeScript');
    expect(tail[3].content).toBe('Glad to help!');

    expect(result.compressedCount).toBe(5);
    expect(result.summary.resolved.length).toBeGreaterThan(0);
  });

  it('extracts tool names from tool messages', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'System context'),
      msg('user', 'Run a search'),
      msg('tool', 'Search result: found 10 items', {
        name: 'web.search',
        metadata: { ok: true },
      }),
      msg('tool', 'File contents: ...', {
        name: 'fs.read',
        metadata: { ok: true },
      }),
      msg('assistant', 'I found the results.'),
      msg('user', 'Run another search'),
      msg('tool', 'Search result: found 5 items', {
        name: 'web.search',
        metadata: { ok: true },
      }),
      msg('assistant', 'Here are 5 more results.'),
      msg('user', 'Ok, done'),
      msg('assistant', 'Great!'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 1,
      protectLastMessages: 2,
    });

    expect(result.summary.toolsUsed).toContain('web.search');
    expect(result.summary.toolsUsed).toContain('fs.read');
    // Deduplicated
    expect(
      result.summary.toolsUsed.filter((t) => t === 'web.search').length,
    ).toBe(1);
  });

  it('extracts resolved items from successful tool results', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'System context'),
      msg('user', 'Start'),
      msg('tool', 'Operation completed successfully', {
        name: 'db.query',
        metadata: { ok: true },
      }),
      msg('assistant', 'The query ran successfully.'),
      msg('user', 'Next step'),
      msg('assistant', 'Working on it.'),
      msg('user', 'Continue'),
      msg('assistant', 'Done!'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 1,
      protectLastMessages: 2,
    });

    const resolvedToolItems = result.summary.resolved.filter((r) =>
      r.startsWith('db.query'),
    );
    expect(resolvedToolItems.length).toBeGreaterThan(0);
  });

  it('extracts pending items from unanswered questions and failed tools', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'System'),
      msg('user', 'First question'),
      msg('user', 'What about this issue?'),
      // No assistant reply to the question above in compressed region
      msg('tool', 'Error: connection refused', {
        name: 'api.call',
        metadata: { ok: false },
      }),
      msg('user', 'Anything else'),
      msg('assistant', 'Let me check.'),
      msg('user', 'Still waiting'),
      msg('assistant', 'Here you go.'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 1,
      protectLastMessages: 2,
    });

    const failedItems = result.summary.pending.filter((p) =>
      p.includes('failed'),
    );
    expect(failedItems.length).toBeGreaterThan(0);
    expect(failedItems[0]).toContain('api.call');
  });

  it('extracts remaining work from todo/next mentions', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'System'),
      msg('user', 'Plan'),
      msg('assistant', 'TODO: implement the login page later'),
      msg('user', 'What about the next steps?'),
      msg('assistant', 'Next we need to add validation.'),
      msg('user', 'Remaining tasks?'),
      msg('assistant', 'The remaining work is testing.'),
      msg('user', 'Ok'),
      msg('assistant', 'Done for now.'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 1,
      protectLastMessages: 2,
    });

    expect(result.summary.remainingWork.length).toBeGreaterThan(0);
  });

  it('extracts key facts from system messages', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'You are a coding assistant.'),
      msg('system', 'The user prefers TypeScript.'),
      msg('user', 'Hello'),
      msg('assistant', 'Hi'),
      msg('user', 'Build something'),
      msg('assistant', 'Sure'),
      msg('system', 'Memory: user likes dark mode'),
      msg('user', 'More'),
      msg('assistant', 'Ok'),
      msg('user', 'End'),
      msg('assistant', 'Bye'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 2,
      protectLastMessages: 2,
    });

    const darkModeFact = result.summary.keyFacts.find((f) =>
      f.includes('dark mode'),
    );
    expect(darkModeFact).toBeDefined();
  });

  it('returns original messages when not enough to compress', () => {
    const messages: ConversationMessage[] = [
      msg('user', 'Hello'),
      msg('assistant', 'Hi'),
      msg('user', 'Bye'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 2,
      protectLastMessages: 2,
    });

    expect(result.messages).toEqual(messages);
    expect(result.compressedCount).toBe(0);
    expect(result.summary.resolved).toEqual([]);
  });

  it('handles empty messages array', () => {
    const result = compressWithStructure([]);

    expect(result.messages).toEqual([]);
    expect(result.compressedCount).toBe(0);
  });

  it('handles all-tool messages', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'Init'),
      msg('user', 'Go'),
      msg('tool', 'Result 1', { name: 'a.tool', metadata: { ok: true } }),
      msg('tool', 'Result 2', { name: 'b.tool', metadata: { ok: true } }),
      msg('tool', 'Result 3', { name: 'c.tool', metadata: { ok: true } }),
      msg('tool', 'Result 4', { name: 'd.tool', metadata: { ok: false } }),
      msg('tool', 'Result 5', { name: 'e.tool', metadata: { ok: true } }),
      msg('user', 'Done'),
      msg('assistant', 'All done.'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 2,
      protectLastMessages: 2,
    });

    expect(result.compressedCount).toBe(5);
    expect(result.summary.toolsUsed.length).toBe(5);
    expect(result.summary.resolved.length).toBeGreaterThan(0);
  });

  it('handles no pending items gracefully', () => {
    const messages: ConversationMessage[] = [
      msg('system', 'Init'),
      msg('user', 'Do this'),
      msg('assistant', 'Done.'),
      msg('user', 'Do that'),
      msg('assistant', 'Also done.'),
      msg('user', 'Great'),
      msg('assistant', 'Thanks!'),
    ];

    const result = compressWithStructure(messages, {
      protectFirstMessages: 1,
      protectLastMessages: 2,
    });

    expect(result.summary.pending).toEqual([]);
  });

  it('uses default options when none provided', () => {
    // 2 head + 6 tail = 8 protected; need >8 messages to compress
    const messages: ConversationMessage[] = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`),
    );

    const result = compressWithStructure(messages);

    // Default: protectFirst=2, protectLast=6 => 4 compressed
    expect(result.compressedCount).toBe(4);
    expect(result.messages[0].content).toBe('Message 0');
    expect(result.messages[1].content).toBe('Message 1');
    expect(result.messages[result.messages.length - 1].content).toBe('Message 11');
  });
});

describe('mergeStructuredSummaries', () => {
  it('merges two summaries and deduplicates', () => {
    const a: StructuredSummary = {
      resolved: ['task A done'],
      pending: ['waiting on API'],
      remainingWork: ['implement login'],
      keyFacts: ['user prefers TypeScript'],
      toolsUsed: ['web.search'],
    };

    const b: StructuredSummary = {
      resolved: ['task B done', 'task A done'],
      pending: ['waiting on API', 'new question'],
      remainingWork: ['implement login', 'add tests'],
      keyFacts: ['user prefers TypeScript', 'dark mode enabled'],
      toolsUsed: ['web.search', 'fs.read'],
    };

    const merged = mergeStructuredSummaries(a, b);

    // Resolved deduplicated
    expect(merged.resolved.filter((r) => r === 'task A done').length).toBe(1);
    expect(merged.resolved).toContain('task B done');

    // KeyFacts deduplicated
    expect(
      merged.keyFacts.filter((f) => f === 'user prefers TypeScript').length,
    ).toBe(1);
    expect(merged.keyFacts).toContain('dark mode enabled');

    // Tools deduplicated
    expect(merged.toolsUsed).toContain('web.search');
    expect(merged.toolsUsed).toContain('fs.read');
    expect(merged.toolsUsed.filter((t) => t === 'web.search').length).toBe(1);
  });

  it('removes pending items that moved to resolved', () => {
    const existing: StructuredSummary = {
      resolved: [],
      pending: ['fix the bug'],
      remainingWork: ['fix the bug'],
      keyFacts: [],
      toolsUsed: [],
    };

    const incoming: StructuredSummary = {
      resolved: ['fix the bug'],
      pending: [],
      remainingWork: [],
      keyFacts: [],
      toolsUsed: [],
    };

    const merged = mergeStructuredSummaries(existing, incoming);

    expect(merged.resolved).toContain('fix the bug');
    expect(merged.pending).not.toContain('fix the bug');
    expect(merged.remainingWork).not.toContain('fix the bug');
  });

  it('handles empty summaries', () => {
    const empty: StructuredSummary = {
      resolved: [],
      pending: [],
      remainingWork: [],
      keyFacts: [],
      toolsUsed: [],
    };

    const merged = mergeStructuredSummaries(empty, empty);

    expect(merged.resolved).toEqual([]);
    expect(merged.pending).toEqual([]);
    expect(merged.remainingWork).toEqual([]);
    expect(merged.keyFacts).toEqual([]);
    expect(merged.toolsUsed).toEqual([]);
  });
});

describe('formatStructuredSummary', () => {
  it('formats a full summary with all sections', () => {
    const summary: StructuredSummary = {
      resolved: ['query completed'],
      pending: ['waiting on approval'],
      remainingWork: ['add validation'],
      keyFacts: ['user is admin'],
      toolsUsed: ['db.query', 'fs.read'],
    };

    const text = formatStructuredSummary(summary);

    expect(text).toContain('## Resolved');
    expect(text).toContain('- query completed');
    expect(text).toContain('## Pending');
    expect(text).toContain('- waiting on approval');
    expect(text).toContain('## Remaining Work');
    expect(text).toContain('- add validation');
    expect(text).toContain('## Key Facts');
    expect(text).toContain('- user is admin');
    expect(text).toContain('## Tools Used');
    expect(text).toContain('db.query, fs.read');
  });

  it('omits empty sections', () => {
    const summary: StructuredSummary = {
      resolved: ['done'],
      pending: [],
      remainingWork: [],
      keyFacts: [],
      toolsUsed: [],
    };

    const text = formatStructuredSummary(summary);

    expect(text).toContain('## Resolved');
    expect(text).not.toContain('## Pending');
    expect(text).not.toContain('## Remaining Work');
    expect(text).not.toContain('## Key Facts');
    expect(text).not.toContain('## Tools Used');
  });

  it('returns empty string when all sections are empty', () => {
    const summary: StructuredSummary = {
      resolved: [],
      pending: [],
      remainingWork: [],
      keyFacts: [],
      toolsUsed: [],
    };

    const text = formatStructuredSummary(summary);
    expect(text).toBe('');
  });
});

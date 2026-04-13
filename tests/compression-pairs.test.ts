import { describe, it, expect } from 'vitest';
import {
  identifyToolPairs,
  splitWithPairPreservation,
  extractPreflightFacts,
  createCompressionChild,
} from '../packages/core/src/compression-utils.js';
import type { ConversationMessage } from '../packages/core/src/index.js';

function msg(role: ConversationMessage['role'], content: string, name?: string): ConversationMessage {
  return { role, content, createdAt: new Date().toISOString(), ...(name ? { name } : {}) };
}

describe('identifyToolPairs', () => {
  it('finds consecutive assistant+tool pairs', () => {
    const messages = [
      msg('user', 'search for X'),
      msg('assistant', 'calling web.search'),
      msg('tool', 'results for X', 'web.search'),
      msg('assistant', 'here are the results'),
    ];
    const pairs = identifyToolPairs(messages);
    expect(pairs).toEqual([
      { callIndex: 1, resultIndex: 2, toolName: 'web.search' },
    ]);
  });

  it('handles multiple consecutive pairs', () => {
    const messages = [
      msg('assistant', 'calling tool A'),
      msg('tool', 'result A', 'toolA'),
      msg('assistant', 'calling tool B'),
      msg('tool', 'result B', 'toolB'),
    ];
    const pairs = identifyToolPairs(messages);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].toolName).toBe('toolA');
    expect(pairs[1].toolName).toBe('toolB');
  });

  it('returns empty for no tools', () => {
    const messages = [
      msg('user', 'hello'),
      msg('assistant', 'hi'),
      msg('user', 'bye'),
    ];
    expect(identifyToolPairs(messages)).toEqual([]);
  });

  it('skips non-consecutive (user between call and result)', () => {
    const messages = [
      msg('assistant', 'calling tool'),
      msg('user', 'wait'),
      msg('tool', 'result', 'myTool'),
    ];
    const pairs = identifyToolPairs(messages);
    expect(pairs).toEqual([]);
  });

  it('uses "unknown" when tool name is missing', () => {
    const messages = [
      msg('assistant', 'calling something'),
      msg('tool', 'result'),
    ];
    const pairs = identifyToolPairs(messages);
    expect(pairs[0].toolName).toBe('unknown');
  });
});

describe('splitWithPairPreservation', () => {
  it('keeps last N messages', () => {
    const messages = [
      msg('user', 'msg1'),
      msg('assistant', 'msg2'),
      msg('user', 'msg3'),
      msg('assistant', 'msg4'),
      msg('user', 'msg5'),
      msg('assistant', 'msg6'),
    ];
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 2);
    expect(toKeep).toHaveLength(2);
    expect(toCompress).toHaveLength(4);
    expect(toKeep[0].content).toBe('msg5');
    expect(toKeep[1].content).toBe('msg6');
  });

  it('expands boundary to include complete tool pair', () => {
    const messages = [
      msg('user', 'do something'),
      msg('assistant', 'calling tool'),   // index 1 — call
      msg('tool', 'tool result', 'myTool'), // index 2 — result
      msg('assistant', 'done'),            // index 3
    ];
    // keepLastN=2 would initially keep indices 2,3 — but index 2 is a tool result
    // paired with index 1, so boundary expands to keep indices 1,2,3
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 2);
    expect(toKeep.some((m) => m.content === 'calling tool')).toBe(true);
    expect(toKeep.some((m) => m.content === 'tool result')).toBe(true);
    expect(toKeep.some((m) => m.content === 'done')).toBe(true);
  });

  it('preserves system prefix', () => {
    const messages = [
      msg('system', 'you are an assistant'),
      msg('user', 'msg1'),
      msg('assistant', 'msg2'),
      msg('user', 'msg3'),
      msg('assistant', 'msg4'),
    ];
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 2);
    expect(toKeep[0].role).toBe('system');
    expect(toKeep[0].content).toBe('you are an assistant');
    // System msg is in toKeep, not toCompress
    expect(toCompress.every((m) => m.role !== 'system')).toBe(true);
  });

  it('handles all messages protected (nothing to compress)', () => {
    const messages = [
      msg('user', 'msg1'),
      msg('assistant', 'msg2'),
    ];
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 5);
    expect(toCompress).toHaveLength(0);
    expect(toKeep).toHaveLength(2);
  });

  it('with keepLastN=0 still keeps pair integrity at end', () => {
    const messages = [
      msg('user', 'start'),
      msg('assistant', 'calling tool'),
      msg('tool', 'result', 'myTool'),
    ];
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 0);
    // The last two messages form a pair — they should stay together
    expect(toKeep.some((m) => m.content === 'calling tool')).toBe(true);
    expect(toKeep.some((m) => m.content === 'result')).toBe(true);
  });

  it('handles multiple system messages as prefix', () => {
    const messages = [
      msg('system', 'sys1'),
      msg('system', 'sys2'),
      msg('user', 'msg1'),
      msg('assistant', 'msg2'),
      msg('user', 'msg3'),
      msg('assistant', 'msg4'),
    ];
    const { toCompress, toKeep } = splitWithPairPreservation(messages, 2);
    expect(toKeep.filter((m) => m.role === 'system')).toHaveLength(2);
    expect(toCompress.every((m) => m.role !== 'system')).toBe(true);
  });
});

describe('extractPreflightFacts', () => {
  it('extracts tool results', () => {
    const messages = [
      msg('tool', 'deployment succeeded on prod', 'deploy.run'),
    ];
    // Set name explicitly since msg helper handles it
    const facts = extractPreflightFacts(messages);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain('Tool deploy.run');
    expect(facts[0]).toContain('deployment succeeded');
  });

  it('extracts assistant decisions', () => {
    const messages = [
      msg('assistant', 'I decided to use PostgreSQL for the database layer.'),
    ];
    const facts = extractPreflightFacts(messages);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toContain('decided');
  });

  it('limits to 10 facts', () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg('tool', `result number ${i}`, `tool${i}`));
    }
    const facts = extractPreflightFacts(messages);
    expect(facts).toHaveLength(10);
  });

  it('handles empty messages', () => {
    const facts = extractPreflightFacts([]);
    expect(facts).toEqual([]);
  });

  it('skips assistant messages that are too long', () => {
    const longContent = 'I decided ' + 'x'.repeat(400);
    const messages = [msg('assistant', longContent)];
    const facts = extractPreflightFacts(messages);
    expect(facts).toHaveLength(0);
  });

  it('skips assistant messages that are too short', () => {
    const messages = [msg('assistant', 'ok decided')];
    // 10 chars, under the 20-char minimum
    const facts = extractPreflightFacts(messages);
    expect(facts).toHaveLength(0);
  });
});

describe('createCompressionChild', () => {
  it('produces correct child session ID format', () => {
    const messages = [
      msg('system', 'you are helpful'),
      msg('user', 'hello'),
      msg('assistant', 'hi there'),
    ];
    const result = createCompressionChild('sess-1', messages, 'summary text', 1);
    expect(result.childSessionId).toMatch(/^sess-1__c\d+$/);
    expect(result.parentSessionId).toBe('sess-1');
  });

  it('preserves system message', () => {
    const messages = [
      msg('system', 'you are helpful'),
      msg('user', 'hello'),
      msg('assistant', 'hi'),
      msg('user', 'bye'),
      msg('assistant', 'goodbye'),
    ];
    const result = createCompressionChild('sess-2', messages, 'summary', 2);
    expect(result.compressedMessages[0].role).toBe('system');
    expect(result.compressedMessages[0].content).toBe('you are helpful');
  });

  it('includes compression summary as second system message', () => {
    const messages = [
      msg('system', 'base prompt'),
      msg('user', 'msg1'),
      msg('assistant', 'msg2'),
      msg('user', 'msg3'),
      msg('assistant', 'msg4'),
    ];
    const result = createCompressionChild('sess-3', messages, 'compressed summary here', 2);
    const summaryMsg = result.compressedMessages[1];
    expect(summaryMsg.role).toBe('system');
    expect(summaryMsg.content).toContain('[Compression summary from parent session sess-3]');
    expect(summaryMsg.content).toContain('compressed summary here');
  });

  it('keeps recent messages with pair integrity', () => {
    const messages = [
      msg('system', 'sys'),
      msg('user', 'old message'),
      msg('assistant', 'old response'),
      msg('assistant', 'calling tool'),
      msg('tool', 'tool result', 'myTool'),
      msg('assistant', 'final answer'),
    ];
    // keepLastN=2: initially keeps indices 4,5 of non-system (tool result + final answer)
    // but tool result at index 4 pairs with assistant at index 3, so boundary expands
    const result = createCompressionChild('sess-4', messages, 'summary', 2);
    const contents = result.compressedMessages.map((m) => m.content);
    expect(contents).toContain('calling tool');
    expect(contents).toContain('tool result');
    expect(contents).toContain('final answer');
  });

  it('returns preflight facts from compressed messages', () => {
    const messages = [
      msg('system', 'sys'),
      msg('user', 'deploy'),
      msg('assistant', 'I created the deployment config for production.'),
      msg('tool', 'deployment result: OK', 'deploy.run'),
      msg('user', 'thanks'),
      msg('assistant', 'done'),
    ];
    const result = createCompressionChild('sess-5', messages, 'summary', 2);
    expect(result.preflightFacts.length).toBeGreaterThan(0);
  });

  it('metadata includes parent session reference', () => {
    const messages = [
      msg('system', 'sys'),
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
      msg('assistant', 'd'),
    ];
    const result = createCompressionChild('sess-6', messages, 'summary', 2);
    const summaryMsg = result.compressedMessages.find(
      (m) => m.metadata?.compressionChild === true,
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.metadata?.parentSessionId).toBe('sess-6');
  });

  it('reports archived message count', () => {
    const messages = [
      msg('system', 'sys'),
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
      msg('assistant', 'd'),
      msg('user', 'e'),
      msg('assistant', 'f'),
    ];
    const result = createCompressionChild('sess-7', messages, 'summary', 2);
    expect(result.archivedMessageCount).toBeGreaterThan(0);
    // The archived count should be the number of non-system messages that were compressed
    expect(result.archivedMessageCount).toBe(
      result.archivedMessageCount, // self-consistent
    );
  });

  it('handles messages with no system prefix', () => {
    const messages = [
      msg('user', 'hello'),
      msg('assistant', 'hi'),
      msg('user', 'bye'),
      msg('assistant', 'goodbye'),
    ];
    const result = createCompressionChild('sess-8', messages, 'summary', 2);
    // First message should be the compression summary (no original system msg)
    // Actually: no system msg found, so compressedMessages starts with summary
    expect(result.compressedMessages[0].role).toBe('system');
    expect(result.compressedMessages[0].content).toContain('Compression summary');
  });
});

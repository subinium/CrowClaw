import { describe, it, expect } from 'vitest';
import {
  parseReasoningBlocks,
  StreamingReasoningParser,
  type StreamingReasoningEvent,
} from '@crowclaw/core/reasoning-blocks';

// ---------------------------------------------------------------------------
// parseReasoningBlocks (pure, non-streaming)
// ---------------------------------------------------------------------------

describe('parseReasoningBlocks', () => {
  it('extracts a single block and strips it from the output', () => {
    const text = 'Hello <plan>step 1\nstep 2</plan> done.';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].tag).toBe('plan');
    expect(result.blocks[0].content).toBe('step 1\nstep 2');
    expect(result.blocks[0].range).toEqual([6, 32]);
    expect(result.stripped).toBe('Hello  done.');
  });

  it('handles multiple blocks across mixed tags in document order', () => {
    const text = '<plan>P</plan>middle<reflection>R</reflection>tail';
    const result = parseReasoningBlocks(text);
    expect(result.blocks.map((b) => b.tag)).toEqual(['plan', 'reflection']);
    expect(result.blocks.map((b) => b.content)).toEqual(['P', 'R']);
    expect(result.stripped).toBe('middletail');
  });

  it('treats a nested known opener as text (Hermes flat contract)', () => {
    // `<reasoning>` inside an open `<reasoning>` block must NOT spawn a child.
    const text = '<reasoning>outer <reasoning>inner</reasoning> tail</reasoning>';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].tag).toBe('reasoning');
    // The first close wins, so the inner-close is what terminates the outer.
    expect(result.blocks[0].content).toBe('outer <reasoning>inner');
  });

  it('drops malformed / unclosed blocks but preserves their text in stripped', () => {
    const text = 'before <plan>never closed';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(0);
    expect(result.stripped).toBe('before never closed');
  });

  it('captures <tool_call> spans inside a reasoning block with insideTag', () => {
    const text =
      '<thinking>Let me check.<tool_call>{"name":"web.search","arguments":{"q":"x"}}</tool_call> done thinking.</thinking>';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(1);
    expect(result.toolCallSpans).toHaveLength(1);
    expect(result.toolCallSpans[0].insideTag).toBe('thinking');
    expect(result.toolCallSpans[0].json).toContain('web.search');
  });

  it('captures top-level <tool_call> spans without insideTag', () => {
    const text = 'preamble <tool_call>{"name":"x","arguments":{}}</tool_call> postamble';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(0);
    expect(result.toolCallSpans).toHaveLength(1);
    expect(result.toolCallSpans[0].insideTag).toBeUndefined();
  });

  it('returns no blocks when no tags are present', () => {
    const text = 'plain assistant turn with no tags';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toEqual([]);
    expect(result.toolCallSpans).toEqual([]);
    expect(result.stripped).toBe(text);
  });

  it('is case-insensitive (Hermes 3 uppercase + Hermes 4 lowercase)', () => {
    const text = '<PLAN>upper</PLAN> mid <think>lower</think>';
    const result = parseReasoningBlocks(text);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].tag).toBe('plan');
    expect(result.blocks[1].tag).toBe('think');
  });

  it('honours a custom allowedTags list', () => {
    const text = '<plan>kept</plan> <custom>also-kept</custom>';
    const result = parseReasoningBlocks(text, ['plan', 'custom']);
    expect(result.blocks.map((b) => b.tag)).toEqual(['plan', 'custom']);
  });
});

// ---------------------------------------------------------------------------
// StreamingReasoningParser
// ---------------------------------------------------------------------------

function feedAll(parser: StreamingReasoningParser, chunks: string[]): StreamingReasoningEvent[] {
  const out: StreamingReasoningEvent[] = [];
  for (const chunk of chunks) out.push(...parser.feed(chunk));
  out.push(...parser.flush());
  return out;
}

describe('StreamingReasoningParser', () => {
  it('emits text-only events for input with no reasoning tags', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['hello ', 'world']);
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { content: string }).content).join('');
    expect(text).toBe('hello world');
    expect(events.find((e) => e.type === 'reasoning_start')).toBeUndefined();
  });

  it('emits start/delta/end for a single block', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['<plan>', 'step 1', '</plan>']);
    const types = events.map((e) => e.type);
    expect(types).toContain('reasoning_start');
    expect(types).toContain('reasoning_delta');
    expect(types).toContain('reasoning_end');
    const start = events.find((e) => e.type === 'reasoning_start') as { tag: string };
    expect(start.tag).toBe('plan');
    const deltas = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { content: string }).content).join('');
    expect(deltas).toBe('step 1');
  });

  it('does not lose a tag boundary split across chunks', () => {
    const parser = new StreamingReasoningParser();
    // Split the opener `<plan>` across multiple chunks
    const events = feedAll(parser, ['<', 'pl', 'an', '>', 'body', '</plan>']);
    const startCount = events.filter((e) => e.type === 'reasoning_start').length;
    const endCount = events.filter((e) => e.type === 'reasoning_end').length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
    const deltas = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { content: string }).content).join('');
    expect(deltas).toBe('body');
  });

  it('handles a closer split across chunk boundaries', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['<plan>body</', 'plan>tail']);
    const endCount = events.filter((e) => e.type === 'reasoning_end').length;
    expect(endCount).toBe(1);
    const tail = events.filter((e) => e.type === 'text').map((e) => (e as { content: string }).content).join('');
    expect(tail).toBe('tail');
  });

  it('emits a tool_call_span when the block closes', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, [
      '<think>',
      'reason ',
      '<tool_call>',
      '{"name":"x","arguments":{}}',
      '</tool_call>',
      ' more',
      '</think>',
    ]);
    const span = events.find((e) => e.type === 'tool_call_span') as { json: string; insideTag: string };
    expect(span).toBeDefined();
    expect(span.insideTag).toBe('think');
    expect(span.json).toContain('"x"');
  });

  it('coalesces multiple deltas before emitting (text)', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['ab', 'cd', 'ef']);
    const textEvents = events.filter((e) => e.type === 'text');
    // We don't assert exactly one — the look-ahead may flush in pieces — but
    // the concatenated payload must equal the input.
    const text = textEvents.map((e) => (e as { content: string }).content).join('');
    expect(text).toBe('abcdef');
  });

  it('flushes an unclosed reasoning block on stream end', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['<plan>partial']);
    const endCount = events.filter((e) => e.type === 'reasoning_end').length;
    expect(endCount).toBe(1); // synthetic close emitted by flush()
    const deltas = events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { content: string }).content).join('');
    expect(deltas).toBe('partial');
  });

  it('treats nested known openers as text inside an open block', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, ['<reasoning>outer <reasoning>still-inner']);
    const startCount = events.filter((e) => e.type === 'reasoning_start').length;
    expect(startCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration sanity: <plan>...</plan> followed by <execution>...</execution>
// — verifies the chunk sequence the dashboard cares about.
// ---------------------------------------------------------------------------

describe('StreamingReasoningParser integration', () => {
  it('produces start→delta→end pairs in document order across two blocks', () => {
    const parser = new StreamingReasoningParser();
    const events = feedAll(parser, [
      '<plan>',
      'A',
      '</plan>',
      ' between ',
      '<execution>',
      'B',
      '</execution>',
    ]);
    const flow = events
      .filter((e) => e.type !== 'text' || (e as { content: string }).content !== '')
      .map((e) => {
        if (e.type === 'reasoning_start' || e.type === 'reasoning_end') return `${e.type}:${(e as { tag: string }).tag}`;
        if (e.type === 'reasoning_delta') return `delta:${(e as { content: string }).content}`;
        if (e.type === 'text') return `text:${(e as { content: string }).content}`;
        return e.type;
      });
    expect(flow.includes('reasoning_start:plan')).toBe(true);
    expect(flow.includes('reasoning_end:plan')).toBe(true);
    expect(flow.includes('reasoning_start:execution')).toBe(true);
    expect(flow.includes('reasoning_end:execution')).toBe(true);
    // plan must precede execution
    expect(flow.indexOf('reasoning_start:plan')).toBeLessThan(flow.indexOf('reasoning_start:execution'));
  });
});

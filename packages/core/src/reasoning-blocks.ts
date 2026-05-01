/**
 * v0.8.0 (#231) — Reasoning-block extraction.
 *
 * Hermes-style models emit structured reasoning inside tagged regions:
 *   <plan>...</plan>
 *   <reasoning>...</reasoning>
 *   <reflection>...</reflection>
 *   <thinking>...</thinking>           // Hermes 3
 *   <think>...</think>                 // Hermes 4
 *   <scratchpad>...</scratchpad>
 *   <inner_monologue>...</inner_monologue>
 *   <execution>...</execution>
 *   <solution>...</solution>
 *   <explanation>...</explanation>
 *   <unit_test>...</unit_test>
 *
 * #236 (Hermes 4 hybrid contract): a `<think>` block can contain interleaved
 * `<tool_call>...</tool_call>` JSON spans. The parser preserves those spans so
 * the provider can route them through the standard tool-call pipeline.
 *
 * Module augmentation: `ProviderResponse.reasoningBlocks` is declared here so
 * non-streaming providers can attach the parsed blocks without modifying the
 * core index.ts (which is owned by another agent in the v0.8.0 sweep).
 */

import type { ProviderResponse } from './index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReasoningTag =
  | 'plan'
  | 'reasoning'
  | 'reflection'
  | 'thinking'
  | 'think'
  | 'scratchpad'
  | 'inner_monologue'
  | 'execution'
  | 'solution'
  | 'explanation'
  | 'unit_test'
  // Allow custom tags via the `allowedTags` parameter without losing
  // autocomplete on the well-known set above.
  | (string & {});

export interface ReasoningBlock {
  /** Tag name as it appeared in the source (lower-cased). */
  tag: ReasoningTag;
  /** Inner content, with the surrounding tags stripped. */
  content: string;
  /** [start, end) byte offsets in the original input string. End is exclusive. */
  range: [number, number];
}

export interface ToolCallSpan {
  /** Start offset of the `<tool_call>` opener in the original input. */
  start: number;
  /** End offset (exclusive) of the closing `</tool_call>`. */
  end: number;
  /** Inner JSON payload (may be partial / malformed; that's the caller's problem). */
  json: string;
  /** When set, the span was found inside a reasoning block of this tag. */
  insideTag?: ReasoningTag;
}

export interface ParseResult {
  /** Original text with all reasoning blocks (and any tool_call spans within them) removed. */
  stripped: string;
  /** All extracted reasoning blocks in document order. */
  blocks: ReasoningBlock[];
  /**
   * Tool-call JSON spans (from #236). Includes both spans inside reasoning
   * regions (with `insideTag`) and spans found in plain text (without). The
   * provider's tool-call extractor consumes these as a fallback when no
   * native function-call slots are present in the response.
   */
  toolCallSpans: ToolCallSpan[];
}

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

export const DEFAULT_REASONING_TAGS: ReasoningTag[] = [
  'plan',
  'reasoning',
  'reflection',
  'thinking',
  'think',
  'scratchpad',
  'inner_monologue',
  'execution',
  'solution',
  'explanation',
  'unit_test',
];

const TOOL_CALL_TAG = 'tool_call';

// ---------------------------------------------------------------------------
// Pure parser (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Parse a complete (non-streaming) string. O(n) in the input length.
 *
 * Rules:
 * - Tag matching is case-insensitive (Hermes 3 used uppercase, Hermes 4 lower).
 * - Nested reasoning tags are NOT supported. If a known tag opens inside an
 *   already-open reasoning region, the inner opener is treated as text.
 * - Unclosed blocks are dropped from `blocks` but their textual content stays
 *   in `stripped` (we have no way to know where they should have ended).
 * - `<tool_call>...</tool_call>` spans are recorded; spans inside a reasoning
 *   block carry the enclosing tag name in `insideTag`.
 */
export function parseReasoningBlocks(
  text: string,
  allowedTags?: ReasoningTag[],
): ParseResult {
  const tagSet = buildTagSet(allowedTags);
  const blocks: ReasoningBlock[] = [];
  const toolCallSpans: ToolCallSpan[] = [];
  // Pieces of text that survive into the stripped output. We collect spans
  // and concat once at the end to keep it O(n).
  const strippedParts: string[] = [];
  let cursor = 0;
  const len = text.length;

  while (cursor < len) {
    const open = findNextOpener(text, cursor, tagSet);
    if (!open) {
      const tail = text.slice(cursor);
      strippedParts.push(tail);
      // Scan the trailing region for top-level tool_call spans too — Hermes
      // models occasionally emit a `<tool_call>` block outside any reasoning
      // tag (e.g. when no <think> is present at all).
      collectToolCallSpans(tail, cursor, undefined, toolCallSpans);
      break;
    }

    // Emit any text before the opener into `stripped`, scanning it for
    // outside-of-reasoning tool_call spans on the way through.
    if (open.start > cursor) {
      const slice = text.slice(cursor, open.start);
      strippedParts.push(slice);
      collectToolCallSpans(slice, cursor, undefined, toolCallSpans);
    }

    const close = findCloser(text, open.contentStart, open.tag);
    if (!close) {
      // Unclosed block — Hermes contract says treat as malformed. Drop the
      // opener tag itself but preserve everything after (it was likely cut
      // off mid-stream and the harness has no way to recover the close).
      const tail = text.slice(open.contentStart);
      strippedParts.push(tail);
      collectToolCallSpans(tail, open.contentStart, open.tag, toolCallSpans);
      break;
    }

    const innerStart = open.contentStart;
    const innerEnd = close.start;
    const blockEnd = close.end;

    // Strip nested same/known openers — they're treated as text per the spec
    // (Hermes' contract is flat). We DON'T recurse into them.
    const inner = text.slice(innerStart, innerEnd);
    blocks.push({
      tag: open.tag,
      content: inner,
      range: [open.start, blockEnd],
    });

    // Tool-call spans inside this reasoning block — track them with `insideTag`.
    collectToolCallSpans(inner, innerStart, open.tag, toolCallSpans);

    cursor = blockEnd;
  }

  return {
    stripped: strippedParts.join(''),
    blocks,
    toolCallSpans,
  };
}

// ---------------------------------------------------------------------------
// Streaming parser
// ---------------------------------------------------------------------------

export type StreamingReasoningEvent =
  | { type: 'text'; content: string }
  | { type: 'reasoning_start'; tag: ReasoningTag }
  | { type: 'reasoning_delta'; content: string }
  | { type: 'reasoning_end'; tag: ReasoningTag }
  | { type: 'tool_call_span'; json: string; insideTag?: ReasoningTag };

/**
 * Stateful streaming parser. Feed chunks in order; consume the events the
 * `feed` call returns. Call `flush` once the upstream stream ends.
 *
 * Implementation notes:
 * - Holds a "look-ahead buffer" sized to the longest known tag plus the
 *   `</` overhead, so a tag boundary split across chunks is never lost.
 * - Processes the buffer in a single forward sweep per `feed` call to keep
 *   total work O(input length).
 */
export class StreamingReasoningParser {
  private readonly tagSet: Map<string, ReasoningTag>;
  private readonly maxTagLen: number;
  /** Chars not yet emitted because they may start a tag opener/closer. */
  private buffer = '';
  /** When inside a reasoning block, the active tag name (lower-case). */
  private currentTag: ReasoningTag | null = null;
  /** Accumulator for the current `<tool_call>` payload (when active). */
  private toolCallBuf: string | null = null;

  constructor(allowedTags?: ReasoningTag[]) {
    this.tagSet = buildTagSet(allowedTags);
    let max = TOOL_CALL_TAG.length;
    for (const tag of this.tagSet.keys()) {
      if (tag.length > max) max = tag.length;
    }
    this.maxTagLen = max;
  }

  /** Feed a chunk of text. Returns the events produced. */
  feed(chunk: string): StreamingReasoningEvent[] {
    this.buffer += chunk;
    return this.drain(/* finalFlush */ false);
  }

  /** Flush at end of stream. Emits any pending text and unclosed-block contents. */
  flush(): StreamingReasoningEvent[] {
    return this.drain(/* finalFlush */ true);
  }

  // -------------------------------------------------------------------------
  // Internal: scan buffer left-to-right, emit events, retain a look-ahead tail.
  // -------------------------------------------------------------------------

  private drain(finalFlush: boolean): StreamingReasoningEvent[] {
    const events: StreamingReasoningEvent[] = [];
    // Non-`<` characters are always emitted immediately — they can't be part
    // of a partial tag. Each `<` triggers a probe: try every structural match;
    // if nothing matches, fall back to `couldBePartialTag` to decide whether
    // to wait for more bytes or emit the `<` as text. This keeps the single
    // forward sweep O(n) without freezing short streams that happen to be
    // shorter than the longest known tag length.
    let i = 0;
    const len = this.buffer.length;

    while (i < len) {
      const ch = this.buffer[i];
      if (ch !== '<') {
        // Ordinary character — route to text or current accumulator.
        i = this.emitChar(events, i);
        continue;
      }

      // `<` encountered. We attempt every applicable structural match first.
      // If none match AND we don't have enough bytes left to disambiguate a
      // partial tag, stop and wait for more bytes (unless this is the final
      // flush, in which case we emit `<` as text).

      // Try to match an opener / closer at this position.
      if (this.currentTag) {
        // Inside a reasoning block: look for the matching close, OR a
        // `<tool_call>` opener/close.
        const close = this.matchCloser(i, this.currentTag);
        if (close !== null) {
          this.flushToolCallIfActive(events, /* aborted */ true);
          events.push({ type: 'reasoning_end', tag: this.currentTag });
          this.currentTag = null;
          i = close;
          continue;
        }

        const tcOpen = this.matchTag(i, TOOL_CALL_TAG, /* close */ false);
        if (tcOpen !== null) {
          // Begin accumulating tool-call payload. The `<tool_call>` markers
          // themselves are NOT forwarded as reasoning_delta — they're
          // structural. Inner JSON is captured for the eventual span event.
          this.toolCallBuf = '';
          i = tcOpen;
          continue;
        }
        const tcClose = this.matchTag(i, TOOL_CALL_TAG, /* close */ true);
        if (tcClose !== null && this.toolCallBuf !== null) {
          events.push({
            type: 'tool_call_span',
            json: this.toolCallBuf,
            insideTag: this.currentTag,
          });
          this.toolCallBuf = null;
          i = tcClose;
          continue;
        }

        // No structural match at this `<`. Before emitting it as text, see
        // whether the remaining bytes COULD form a partial closer/tool_call —
        // in which case we wait for more input. (Only applies mid-stream;
        // on flush we always emit.)
        if (!finalFlush && this.couldBePartialTag(i, len)) {
          break;
        }

        // A nested known opener inside a reasoning block is treated as text
        // per the Hermes flat-contract rule. Same for any `<` that isn't a
        // recognised structural marker.
        i = this.emitChar(events, i);
        continue;
      }

      // Outside any reasoning block. When we're already accumulating a
      // top-level `<tool_call>` payload, skip the opener probe — anything
      // that isn't `</tool_call>` is part of the JSON body.
      if (this.toolCallBuf === null) {
        const opener = this.matchAnyOpener(i);
        if (opener !== null) {
          events.push({ type: 'reasoning_start', tag: opener.tag });
          this.currentTag = opener.tag;
          i = opener.contentStart;
          continue;
        }
      }

      // Top-level `<tool_call>` block (outside reasoning) — also tracked.
      const tcOpen = this.matchTag(i, TOOL_CALL_TAG, /* close */ false);
      if (tcOpen !== null && this.toolCallBuf === null) {
        this.toolCallBuf = '';
        i = tcOpen;
        continue;
      }
      const tcClose = this.matchTag(i, TOOL_CALL_TAG, /* close */ true);
      if (tcClose !== null && this.toolCallBuf !== null) {
        events.push({ type: 'tool_call_span', json: this.toolCallBuf });
        this.toolCallBuf = null;
        i = tcClose;
        continue;
      }

      // No structural match. If we might still be looking at a partial
      // opener (e.g. `<pl` waiting for `an>`), stop and wait for more bytes
      // unless this is the final flush.
      if (!finalFlush && this.couldBePartialTag(i, len)) {
        break;
      }

      // Plain `<` — emit as text.
      i = this.emitChar(events, i);
    }

    // Drop the consumed prefix; retain the tail look-ahead.
    this.buffer = this.buffer.slice(i);

    if (finalFlush) {
      // Emit anything left as text / reasoning content. Unclosed blocks just
      // tail-emit their accumulated content; we have no closer to anchor on.
      if (this.buffer.length > 0) {
        if (this.currentTag) {
          // Inside an unclosed reasoning region — flush as a delta then end.
          if (this.buffer) events.push({ type: 'reasoning_delta', content: this.buffer });
          events.push({ type: 'reasoning_end', tag: this.currentTag });
          this.currentTag = null;
        } else {
          events.push({ type: 'text', content: this.buffer });
        }
        this.buffer = '';
      } else if (this.currentTag) {
        events.push({ type: 'reasoning_end', tag: this.currentTag });
        this.currentTag = null;
      }
      // Discard any partial tool-call payload — not safe to emit.
      this.toolCallBuf = null;
    }

    return events;
  }

  /** Consume a single character at `i`, route it to text/reasoning/tool-call. */
  private emitChar(events: StreamingReasoningEvent[], i: number): number {
    const ch = this.buffer[i];
    if (this.toolCallBuf !== null) {
      this.toolCallBuf += ch;
    } else if (this.currentTag) {
      // Coalesce contiguous reasoning chars into a single delta event.
      const last = events[events.length - 1];
      if (last && last.type === 'reasoning_delta') {
        last.content += ch;
      } else {
        events.push({ type: 'reasoning_delta', content: ch });
      }
    } else {
      const last = events[events.length - 1];
      if (last && last.type === 'text') {
        last.content += ch;
      } else {
        events.push({ type: 'text', content: ch });
      }
    }
    return i + 1;
  }

  private flushToolCallIfActive(_events: StreamingReasoningEvent[], _aborted: boolean): void {
    // If the reasoning block closes mid-tool_call, drop the partial payload
    // — it's not safe to emit malformed JSON as a span.
    this.toolCallBuf = null;
  }

  /**
   * Could the buffer slice starting at `i` be a partial (incomplete) opener
   * or closer for any known tag (or `<tool_call>`)? Returns true when the
   * slice is a strict prefix of `<TAG>` or `</TAG>` for some known TAG.
   * Used to decide whether to stop and wait for more bytes.
   */
  private couldBePartialTag(i: number, len: number): boolean {
    // Available bytes including the leading `<`.
    const avail = len - i;
    // Build the candidate slice (lower-cased) once.
    const slice = this.buffer.slice(i, len).toLowerCase();
    // Every candidate is `<` then optional `/` then a tag name then `>`.
    // We need: avail < (1 + (close?1:0) + tagName.length + 1) AND `slice` is
    // a prefix of one of those forms. A two-char `</` is also a valid prefix
    // for any closer.
    if (slice === '<' || slice === '</') return true;
    const allTags = [...this.tagSet.keys(), TOOL_CALL_TAG];
    for (const tag of allTags) {
      // Opener form `<tag>` — full length 1 + tag.length + 1.
      const openFull = `<${tag}>`;
      const closeFull = `</${tag}>`;
      if (avail < openFull.length && openFull.startsWith(slice)) return true;
      if (avail < closeFull.length && closeFull.startsWith(slice)) return true;
    }
    return false;
  }

  /**
   * Try to match `<tagName>` (or `</tagName>`) at position `i`. Returns the
   * index AFTER the `>` on success, or null on no match. Case-insensitive.
   */
  private matchTag(i: number, tagName: string, close: boolean): number | null {
    const buf = this.buffer;
    if (buf[i] !== '<') return null;
    let j = i + 1;
    if (close) {
      if (buf[j] !== '/') return null;
      j += 1;
    }
    if (j + tagName.length > buf.length) return null;
    const candidate = buf.slice(j, j + tagName.length).toLowerCase();
    if (candidate !== tagName) return null;
    j += tagName.length;
    if (buf[j] !== '>') return null;
    return j + 1;
  }

  /** Try every known opener at position `i`. */
  private matchAnyOpener(i: number): { tag: ReasoningTag; contentStart: number } | null {
    for (const [lcTag] of this.tagSet) {
      const end = this.matchTag(i, lcTag, /* close */ false);
      if (end !== null) {
        return { tag: lcTag, contentStart: end };
      }
    }
    return null;
  }

  private matchCloser(i: number, tag: ReasoningTag): number | null {
    return this.matchTag(i, tag, /* close */ true);
  }
}

// ---------------------------------------------------------------------------
// Helpers (shared between pure + streaming parsers)
// ---------------------------------------------------------------------------

function buildTagSet(allowed?: ReasoningTag[]): Map<string, ReasoningTag> {
  const tags = (allowed && allowed.length > 0) ? allowed : DEFAULT_REASONING_TAGS;
  const map = new Map<string, ReasoningTag>();
  for (const tag of tags) {
    map.set(tag.toLowerCase(), tag.toLowerCase());
  }
  return map;
}

interface OpenerMatch {
  start: number;
  contentStart: number;
  tag: ReasoningTag;
}

/**
 * Scan forward from `from` for the next opener of any allowed tag. O(n) over
 * the slice; tag set is small and bounded so the inner `for` loop is constant.
 */
function findNextOpener(
  text: string,
  from: number,
  tagSet: Map<string, ReasoningTag>,
): OpenerMatch | null {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '<') continue;
    for (const [lcTag] of tagSet) {
      const contentStart = matchTagAt(text, i, lcTag, /* close */ false);
      if (contentStart !== null) {
        return { start: i, contentStart, tag: lcTag };
      }
    }
  }
  return null;
}

function findCloser(text: string, from: number, tag: ReasoningTag): { start: number; end: number } | null {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '<') continue;
    const end = matchTagAt(text, i, tag, /* close */ true);
    if (end !== null) {
      return { start: i, end };
    }
  }
  return null;
}

function matchTagAt(text: string, i: number, tagName: string, close: boolean): number | null {
  if (text[i] !== '<') return null;
  let j = i + 1;
  if (close) {
    if (text[j] !== '/') return null;
    j += 1;
  }
  if (j + tagName.length > text.length) return null;
  const candidate = text.slice(j, j + tagName.length).toLowerCase();
  if (candidate !== tagName) return null;
  j += tagName.length;
  if (text[j] !== '>') return null;
  return j + 1;
}

/**
 * Walk a text slice and append every `<tool_call>...</tool_call>` to `out`.
 * `baseOffset` is the offset of `slice[0]` in the original input so the
 * returned spans use absolute positions.
 */
function collectToolCallSpans(
  slice: string,
  baseOffset: number,
  insideTag: ReasoningTag | undefined,
  out: ToolCallSpan[],
): void {
  let i = 0;
  while (i < slice.length) {
    if (slice[i] !== '<') { i++; continue; }
    const openEnd = matchTagAt(slice, i, TOOL_CALL_TAG, /* close */ false);
    if (openEnd === null) { i++; continue; }
    // Look for the matching closer.
    let j = openEnd;
    while (j < slice.length) {
      if (slice[j] === '<') {
        const closeEnd = matchTagAt(slice, j, TOOL_CALL_TAG, /* close */ true);
        if (closeEnd !== null) {
          out.push({
            start: baseOffset + i,
            end: baseOffset + closeEnd,
            json: slice.slice(openEnd, j),
            ...(insideTag !== undefined ? { insideTag } : {}),
          });
          i = closeEnd;
          break;
        }
      }
      j++;
    }
    if (j >= slice.length) {
      // Unclosed `<tool_call>` — skip past the opener and keep scanning.
      i = openEnd;
    }
  }
}

// ---------------------------------------------------------------------------
// Module augmentation: expose `reasoningBlocks` on ProviderResponse.
// Lets non-streaming providers attach parsed blocks without touching the
// core index.ts (which is owned by another agent in v0.8.0).
// ---------------------------------------------------------------------------

declare module './index.js' {
  interface ProviderResponse {
    /**
     * #231: Hermes-style reasoning blocks parsed from the assistant message.
     * Populated by providers when present in the completion. Optional — older
     * providers and non-Hermes models leave it undefined.
     */
    reasoningBlocks?: ReasoningBlock[];
  }
}

// Keep the augmentation type-only — the import above is needed so the
// module reference resolves at compile time.
export type { ProviderResponse };

/**
 * v0.8.4 (#274) — gpt-tokenizer precision equivalence guard.
 *
 * Issue #274 swapped the providers package's char/4 token heuristic for a
 * real BPE tokenizer (`gpt-tokenizer`, pure-JS) so OpenAI-compatible
 * `countTokens()` lands within ±5% of tiktoken's reference output.
 *
 * This file exists to *guard against drift*: if a future refactor reverts the
 * heuristic, swaps `o200k_base` for the wrong encoding, miswires the
 * model-family lookup, or otherwise loses precision, this test must fail.
 *
 * Reference token counts below were computed once against
 * `gpt-tokenizer@3.4.0`'s `cl100k_base` and `o200k_base` encoders directly
 * (mirroring tiktoken's reference implementation — `gpt-tokenizer` is the
 * pure-JS port of the same BPE tables) and baked in as constants. The
 * provider-level expectation sits on top of those raw counts, plus the
 * +3-per-message OpenAI chat framing overhead and the role/name token
 * contributions, so we exercise the whole `countTokens()` pipeline rather
 * than just re-running the underlying encoder.
 *
 * Tolerance: 5% per AC. Empty / very-short strings can break a strict 5%
 * tolerance because the absolute delta dominates relative error, so this
 * file's corpus deliberately picks 5+ token strings.
 */

import { describe, it, expect } from 'vitest';
import { OpenAICompatibleProvider } from '@crowclaw/providers';
import type { ConversationMessage } from '@crowclaw/core';

const TOLERANCE = 0.05;
const NOW = new Date().toISOString();

interface CorpusEntry {
  /** Human label for failure diagnostics. */
  readonly label: string;
  /** The string to count. */
  readonly text: string;
  /** Reference token count under cl100k_base (gpt-3.5/4 family). */
  readonly cl100kReference: number;
  /** Reference token count under o200k_base (gpt-4o/gpt-5/o-series). */
  readonly o200kReference: number;
}

/**
 * Pinned fixture corpus. Each entry's reference counts come from
 * `gpt-tokenizer@3.4.0` per-encoding `encode().length`. If you legitimately
 * need to update these (e.g. on a tokenizer-major bump that changes the BPE
 * table), recompute them by running the encoder against the same string.
 */
const CORPUS: readonly CorpusEntry[] = [
  {
    label: 'README tagline',
    text: 'CrowClaw is a self-improving TypeScript agent framework that learns from every conversation.',
    cl100kReference: 18,
    o200kReference: 19,
  },
  {
    label: 'README chat example',
    text: 'A moderately long message to compare token estimation across providers.',
    cl100kReference: 11,
    o200kReference: 11,
  },
  {
    label: 'pangram with digits',
    text: 'The quick brown fox jumps over the lazy dog. 1234567890.',
    cl100kReference: 16,
    o200kReference: 16,
  },
  {
    label: 'TS code snippet',
    text: 'function add(a: number, b: number): number { return a + b; }',
    cl100kReference: 18,
    o200kReference: 18,
  },
  {
    label: 'rare English word',
    text: 'antidisestablishmentarianism',
    cl100kReference: 6,
    o200kReference: 6,
  },
  {
    label: 'Korean sentence',
    text: '안녕하세요, 반갑습니다. 오늘 날씨가 좋네요.',
    cl100kReference: 26,
    o200kReference: 14,
  },
];

const FRAMING_PER_MESSAGE = 3; // +3 role/message framing tokens (OpenAI chat).

/**
 * Wrap a single text in the simplest possible message and measure the
 * provider's countTokens output. We then strip the known framing so we can
 * compare directly to the encoder's raw output for that text.
 */
function providerRawTextTokens(provider: OpenAICompatibleProvider, text: string, role: 'user' | 'assistant' = 'user'): number {
  const messages: ConversationMessage[] = [{ role, content: text, createdAt: NOW }];
  const total = provider.countTokens(messages);
  // Subtract framing (3) plus the role token (1 token for both 'user' and 'assistant'
  // under both cl100k_base and o200k_base).
  return total - FRAMING_PER_MESSAGE - 1;
}

function within(actual: number, expected: number, tolerance: number): boolean {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / expected < tolerance;
}

describe('countTokens precision (#274) — cl100k_base family', () => {
  // gpt-3.5-turbo selects cl100k_base under getOpenAIEncodingFamily.
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-3.5-turbo',
  });

  for (const entry of CORPUS) {
    it(`stays within 5% of cl100k reference for "${entry.label}"`, () => {
      const measured = providerRawTextTokens(provider, entry.text);
      expect(
        within(measured, entry.cl100kReference, TOLERANCE),
        `cl100k "${entry.label}": measured=${measured} expected=${entry.cl100kReference} delta=${Math.abs(measured - entry.cl100kReference)} (${entry.text})`,
      ).toBe(true);
    });
  }
});

describe('countTokens precision (#274) — o200k_base family', () => {
  // gpt-4o selects o200k_base under getOpenAIEncodingFamily.
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
  });

  for (const entry of CORPUS) {
    it(`stays within 5% of o200k reference for "${entry.label}"`, () => {
      const measured = providerRawTextTokens(provider, entry.text);
      expect(
        within(measured, entry.o200kReference, TOLERANCE),
        `o200k "${entry.label}": measured=${measured} expected=${entry.o200kReference} delta=${Math.abs(measured - entry.o200kReference)} (${entry.text})`,
      ).toBe(true);
    });
  }
});

describe('countTokens precision (#274) — model family routing', () => {
  // The whole point of #274 is that gpt-4o / gpt-5 / o-series / codex models
  // route to o200k_base, not cl100k_base. Without this routing, Korean text
  // would be counted at the cl100k rate (26 tokens for our fixture) instead
  // of the o200k rate (14 tokens) — a 1.86x overcount.
  const KOREAN = '안녕하세요, 반갑습니다. 오늘 날씨가 좋네요.';
  const KOREAN_CL100K = 26;
  const KOREAN_O200K = 14;

  const cases: Array<{ model: string; expected: number }> = [
    { model: 'gpt-4o', expected: KOREAN_O200K },
    { model: 'gpt-4o-mini', expected: KOREAN_O200K },
    { model: 'gpt-5', expected: KOREAN_O200K },
    { model: 'o3-mini', expected: KOREAN_O200K },
    { model: 'o4-mini', expected: KOREAN_O200K },
    { model: 'codex-mini-latest', expected: KOREAN_O200K },
    { model: 'gpt-3.5-turbo', expected: KOREAN_CL100K },
    { model: 'gpt-4', expected: KOREAN_CL100K },
    { model: 'gpt-4-turbo', expected: KOREAN_CL100K },
  ];

  for (const { model, expected } of cases) {
    it(`routes ${model} to the correct encoding family`, () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com/v1',
        model,
      });
      const measured = providerRawTextTokens(provider, KOREAN);
      expect(
        within(measured, expected, TOLERANCE),
        `${model} on Korean: measured=${measured} expected=${expected}`,
      ).toBe(true);
    });
  }
});

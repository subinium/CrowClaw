import { describe, it, expect } from 'vitest';
import {
  resolveApiMode,
  modelSupports,
  getEndpointForModel,
  listApiModes,
  getRequestShape,
} from '../packages/providers/src/api-mode.js';
import { FALLBACK_MANIFEST } from '../packages/providers/src/model-catalog.js';
import type { ApiModeCapabilities } from '../packages/providers/src/api-mode.js';

// ---------------------------------------------------------------------------
// resolveApiMode — pattern matching
// ---------------------------------------------------------------------------

describe('resolveApiMode', () => {
  it('returns anthropic_messages for claude-sonnet-4-20250514', () => {
    const result = resolveApiMode('claude-sonnet-4-20250514');
    expect(result.mode).toBe('anthropic_messages');
    expect(result.family).toBe('anthropic');
  });

  it('returns anthropic_messages for claude-3-haiku', () => {
    const result = resolveApiMode('claude-3-haiku');
    expect(result.mode).toBe('anthropic_messages');
    expect(result.endpoint).toBe('/v1/messages');
  });

  it('returns openai_responses for o1-mini', () => {
    const result = resolveApiMode('o1-mini');
    expect(result.mode).toBe('openai_responses');
    expect(result.family).toBe('openai');
  });

  it('returns openai_responses for o3-pro', () => {
    const result = resolveApiMode('o3-pro');
    expect(result.mode).toBe('openai_responses');
    expect(result.endpoint).toBe('/v1/responses');
  });

  it('returns openai_responses for codex-mini', () => {
    const result = resolveApiMode('codex-mini');
    expect(result.mode).toBe('openai_responses');
  });

  it('returns openai_chat for gpt-4o', () => {
    const result = resolveApiMode('gpt-4o');
    expect(result.mode).toBe('openai_chat');
    expect(result.family).toBe('openai');
  });

  it('returns openai_chat for gpt-4o-mini', () => {
    const result = resolveApiMode('gpt-4o-mini');
    expect(result.mode).toBe('openai_chat');
    expect(result.endpoint).toBe('/v1/chat/completions');
  });

  it('returns google_gemini for gemini-2.5-flash', () => {
    const result = resolveApiMode('gemini-2.5-flash');
    expect(result.mode).toBe('google_gemini');
    expect(result.family).toBe('google');
  });

  it('returns openai_chat for unknown model names', () => {
    const result = resolveApiMode('some-random-model');
    expect(result.mode).toBe('openai_chat');
    expect(result.family).toBe('openai');
  });

  it('respects providerHint over pattern matching', () => {
    // gpt-4o would normally resolve to openai_chat,
    // but providerHint forces anthropic
    const result = resolveApiMode('gpt-4o', 'anthropic');
    expect(result.mode).toBe('anthropic_messages');
    expect(result.family).toBe('anthropic');
  });

  it('resolves openai_responses when providerHint is openai_responses', () => {
    const result = resolveApiMode('custom-model', 'openai_responses');
    expect(result.mode).toBe('openai_responses');
  });

  it('resolves google_gemini when providerHint is google', () => {
    const result = resolveApiMode('custom-model', 'google');
    expect(result.mode).toBe('google_gemini');
  });

  it('resolves echo mode for echo model name', () => {
    const result = resolveApiMode('echo');
    expect(result.mode).toBe('echo');
    expect(result.family).toBe('echo');
  });

  it('resolves anthropic_bedrock when providerHint is anthropic_bedrock', () => {
    const result = resolveApiMode('claude-sonnet-4-20250514', 'anthropic_bedrock');
    expect(result.mode).toBe('anthropic_bedrock');
    expect(result.family).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// modelSupports
// ---------------------------------------------------------------------------

describe('modelSupports', () => {
  it('returns true for Claude + reasoning', () => {
    expect(modelSupports('claude-sonnet-4-20250514', 'reasoning')).toBe(true);
  });

  it('returns true for Claude + vision', () => {
    expect(modelSupports('claude-3-haiku', 'vision')).toBe(true);
  });

  it('returns true for Claude + caching', () => {
    expect(modelSupports('claude-sonnet-4-20250514', 'caching')).toBe(true);
  });

  it('returns true for OpenAI Chat/Responses prompt caching', () => {
    expect(modelSupports('gpt-4o', 'caching')).toBe(true);
    expect(modelSupports('o1-mini', 'caching')).toBe(true);
  });

  it('returns false for GPT-4o + reasoning', () => {
    expect(modelSupports('gpt-4o', 'reasoning')).toBe(false);
  });

  it('returns true for o1-mini + reasoning', () => {
    expect(modelSupports('o1-mini', 'reasoning')).toBe(true);
  });

  it('returns false for echo + toolUse', () => {
    expect(modelSupports('echo', 'toolUse')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEndpointForModel
// ---------------------------------------------------------------------------

describe('getEndpointForModel', () => {
  it('returns /v1/messages for claude models', () => {
    expect(getEndpointForModel('claude-sonnet-4-20250514')).toBe('/v1/messages');
  });

  it('returns /v1/responses for o-series models', () => {
    expect(getEndpointForModel('o3-pro')).toBe('/v1/responses');
  });

  it('returns /v1/chat/completions for gpt models', () => {
    expect(getEndpointForModel('gpt-4o')).toBe('/v1/chat/completions');
  });

  it('returns /v1/chat/completions for gemini models', () => {
    expect(getEndpointForModel('gemini-2.5-flash')).toBe('/v1/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// listApiModes
// ---------------------------------------------------------------------------

describe('listApiModes', () => {
  it('returns all 6 modes', () => {
    const modes = listApiModes();
    expect(modes).toHaveLength(6);
  });

  it('contains all expected mode identifiers', () => {
    const modes = listApiModes();
    const modeNames = modes.map((m) => m.mode);
    expect(modeNames).toContain('openai_chat');
    expect(modeNames).toContain('openai_responses');
    expect(modeNames).toContain('anthropic_messages');
    expect(modeNames).toContain('anthropic_bedrock');
    expect(modeNames).toContain('google_gemini');
    expect(modeNames).toContain('echo');
  });

  it('each mode has a description and family', () => {
    const modes = listApiModes();
    for (const m of modes) {
      expect(m.description).toBeTruthy();
      expect(m.family).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// getRequestShape
// ---------------------------------------------------------------------------

describe('getRequestShape', () => {
  it('returns input messageFormat for openai_responses', () => {
    const shape = getRequestShape('openai_responses');
    expect(shape.messageFormat).toBe('input');
  });

  it('returns developer systemRole for openai_responses', () => {
    const shape = getRequestShape('openai_responses');
    expect(shape.systemRole).toBe('developer');
  });

  it('returns messages messageFormat for openai_chat', () => {
    const shape = getRequestShape('openai_chat');
    expect(shape.messageFormat).toBe('messages');
  });

  it('returns system systemRole for openai_chat', () => {
    const shape = getRequestShape('openai_chat');
    expect(shape.systemRole).toBe('system');
  });

  it('returns messages messageFormat for anthropic_messages', () => {
    const shape = getRequestShape('anthropic_messages');
    expect(shape.messageFormat).toBe('messages');
    expect(shape.toolFormat).toBe('tools');
  });

  it('returns none toolFormat for echo', () => {
    const shape = getRequestShape('echo');
    expect(shape.toolFormat).toBe('none');
  });

  it('returns messages messageFormat for google_gemini', () => {
    const shape = getRequestShape('google_gemini');
    expect(shape.messageFormat).toBe('messages');
  });
});

// ---------------------------------------------------------------------------
// Capabilities object structure
// ---------------------------------------------------------------------------

describe('capabilities structure', () => {
  const requiredFields: Array<keyof ApiModeCapabilities> = [
    'streaming',
    'toolUse',
    'vision',
    'reasoning',
    'caching',
    'batchApi',
  ];

  it('has all required fields for anthropic_messages', () => {
    const { capabilities } = resolveApiMode('claude-sonnet-4-20250514');
    for (const field of requiredFields) {
      expect(typeof capabilities[field]).toBe('boolean');
    }
  });

  it('has all required fields for openai_chat', () => {
    const { capabilities } = resolveApiMode('gpt-4o');
    for (const field of requiredFields) {
      expect(typeof capabilities[field]).toBe('boolean');
    }
  });

  it('has all required fields for openai_responses', () => {
    const { capabilities } = resolveApiMode('o1-mini');
    for (const field of requiredFields) {
      expect(typeof capabilities[field]).toBe('boolean');
    }
  });

  it('has all required fields for google_gemini', () => {
    const { capabilities } = resolveApiMode('gemini-2.5-flash');
    for (const field of requiredFields) {
      expect(typeof capabilities[field]).toBe('boolean');
    }
  });

  it('has all required fields for echo', () => {
    const { capabilities } = resolveApiMode('echo');
    for (const field of requiredFields) {
      expect(typeof capabilities[field]).toBe('boolean');
    }
  });

  it('capabilities are not shared references between calls', () => {
    const a = resolveApiMode('claude-sonnet-4-20250514');
    const b = resolveApiMode('claude-3-haiku');
    a.capabilities.streaming = false;
    expect(b.capabilities.streaming).toBe(true);
  });
});

describe('fallback model catalog', () => {
  it('includes gpt-5 family models for offline context lookup', () => {
    const ids = FALLBACK_MANIFEST.models.map((model) => model.id);
    expect(ids).toContain('gpt-5');
    expect(ids).toContain('gpt-5.5');
  });
});

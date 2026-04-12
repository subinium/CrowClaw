import { describe, expect, it } from 'vitest';
import { getModelMetadata, listKnownModelMetadata } from '@crowclaw/providers';

describe('model metadata', () => {
  it('returns metadata for known OpenAI-compatible and Anthropic models', () => {
    expect(getModelMetadata('gpt-4o')).toMatchObject({
      family: 'openai-compatible',
      supportsTools: true
    });
    expect(getModelMetadata('claude-sonnet-4')).toMatchObject({
      family: 'anthropic',
      supportsPromptCaching: true
    });
  });

  it('lists known model metadata entries and returns null for unknown models', () => {
    const ids = listKnownModelMetadata().map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'gpt-4o',
      'claude-sonnet-4'
    ]));
    expect(ids.length).toBeGreaterThanOrEqual(40);
    expect(getModelMetadata('unknown-model')).toBeNull();
  });
});

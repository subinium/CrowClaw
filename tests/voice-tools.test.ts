import { describe, expect, it } from 'vitest';
import { createTtsTool, createTranscriptionTool } from '@crowclaw/tools';

describe('voice tools', () => {
  it('voice.tts requires text parameter', async () => {
    const tool = createTtsTool();
    const result = await tool.execute({}, { agentId: 'a', sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing text');
  });

  it('voice.tts returns informative error without backend', async () => {
    const tool = createTtsTool();
    const result = await tool.execute({ text: 'Hello world' }, { agentId: 'a', sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('TTS requires');
  });

  it('voice.tts has correct manifest', () => {
    const tool = createTtsTool();
    expect(tool.manifest.name).toBe('voice.tts');
    expect(tool.manifest.dangerLevel).toBe('low');
  });

  it('voice.transcribe requires filePath or url', async () => {
    const tool = createTranscriptionTool();
    const result = await tool.execute({}, { agentId: 'a', sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing filePath or url');
  });

  it('voice.transcribe requires API key', async () => {
    const tool = createTranscriptionTool();
    const result = await tool.execute({ filePath: '/tmp/audio.mp3' }, { agentId: 'a', sessionId: 's' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('API key');
  });

  it('voice.transcribe has correct manifest', () => {
    const tool = createTranscriptionTool();
    expect(tool.manifest.name).toBe('voice.transcribe');
  });
});

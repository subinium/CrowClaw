// v0.9.0 (#325) — TTS provider registry + Piper local TTS. Acceptance:
//   - `crowclaw tts list` shows registered providers
//   - Piper synthesizes audio for a built-in voice
//   - Missing piper binary → graceful error
//   - Sibling xAI provider plugs in cleanly
//
// We can't actually shell out to a real `piper` binary in CI, so the Piper
// tests stub `node:child_process` via a fake binary. The shape tests verify
// the call site contracts so a real piper binary works on the user's box
// without further changes.

import { describe, it, expect } from 'vitest';
import {
  TTSProviderRegistry,
  createPiperProvider,
  type TTSProvider,
  type TTSSynthesisResult,
} from '@crowclaw/tools';

describe('TTS provider registry (#325)', () => {
  it('registers and resolves an eager provider', async () => {
    const fakeProvider: TTSProvider = {
      name: 'fake',
      displayName: 'Fake TTS',
      synthesize: async () => fakeAudio('fake'),
    };
    const registry = new TTSProviderRegistry().register(fakeProvider);
    expect(registry.has('fake')).toBe(true);
    expect(registry.list()).toEqual(['fake']);
    const resolved = await registry.getProvider('fake');
    expect(resolved?.name).toBe('fake');
  });

  it('normalizes provider names (case + whitespace)', async () => {
    const registry = new TTSProviderRegistry().register({
      name: '  OpenAI  ',
      displayName: 'OpenAI',
      synthesize: async () => fakeAudio('openai'),
    });
    // Lookups are case-insensitive after normalization.
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('OPENAI')).toBe(true);
    const resolved = await registry.getProvider('openai');
    expect(resolved?.name).toBe('openai');
  });

  it('rejects empty provider names', () => {
    const registry = new TTSProviderRegistry();
    expect(() => registry.register({ name: '', displayName: 'x', synthesize: async () => fakeAudio('x') }))
      .toThrow(/non-empty/);
    expect(() => registry.registerLazy('', async () => ({
      name: 'x',
      displayName: 'x',
      synthesize: async () => fakeAudio('x'),
    }))).toThrow(/non-empty/);
  });

  it('runs and memoizes lazy factories', async () => {
    let calls = 0;
    const registry = new TTSProviderRegistry().registerLazy('lazy', async () => {
      calls++;
      return {
        name: 'lazy',
        displayName: 'Lazy',
        synthesize: async () => fakeAudio('lazy'),
      };
    });
    expect(registry.has('lazy')).toBe(true);
    await registry.getProvider('lazy');
    await registry.getProvider('lazy');
    expect(calls).toBe(1); // memoized
  });

  it('returns null for unknown provider', async () => {
    const registry = new TTSProviderRegistry();
    expect(await registry.getProvider('nope')).toBeNull();
  });

  it('listWithHealth reports ok=true when no health hook is registered', async () => {
    const registry = new TTSProviderRegistry().register({
      name: 'no-health',
      displayName: 'No Health',
      synthesize: async () => fakeAudio('no-health'),
    });
    const summary = await registry.listWithHealth();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.health.ok).toBe(true);
    expect(summary[0]?.health.detail).toContain('no health check');
  });

  it('listWithHealth swallows health-check exceptions', async () => {
    const registry = new TTSProviderRegistry().register({
      name: 'broken',
      displayName: 'Broken',
      synthesize: async () => fakeAudio('broken'),
      health: async () => { throw new Error('boom'); },
    });
    const summary = await registry.listWithHealth();
    expect(summary[0]?.health.ok).toBe(false);
    expect(summary[0]?.health.detail).toContain('boom');
  });

  it('listWithHealth surfaces provider health results', async () => {
    const registry = new TTSProviderRegistry()
      .register({
        name: 'ready',
        displayName: 'Ready',
        synthesize: async () => fakeAudio('ready'),
        health: async () => ({ ok: true, detail: 'API key valid' }),
      })
      .register({
        name: 'unready',
        displayName: 'Unready',
        synthesize: async () => fakeAudio('unready'),
        health: async () => ({ ok: false, detail: 'no API key' }),
      });
    const summary = await registry.listWithHealth();
    const ready = summary.find((p) => p.name === 'ready');
    const unready = summary.find((p) => p.name === 'unready');
    expect(ready?.health.ok).toBe(true);
    expect(unready?.health.ok).toBe(false);
  });

  it('supports the xAI-style plug-in shape (sibling #324)', async () => {
    // This is a "would xAI Custom Voices plug in cleanly?" smoke test —
    // we register a provider with the same shape #324 will use (clone-
    // capable, voiceId from metadata). If this test ever fails to compile,
    // the registry contract drifted.
    const xaiLike: TTSProvider = {
      name: 'xai',
      displayName: 'xAI Custom Voices',
      listVoices: async () => [
        { voiceId: 'default', displayName: 'Default xAI voice', cloned: false },
        { voiceId: 'cloned-abc', displayName: 'My cloned voice', cloned: true },
      ],
      health: async () => ({ ok: true }),
      synthesize: async (text, opts) => ({
        audio: new Uint8Array([1, 2, 3]),
        mime: 'audio/mpeg',
        voiceId: opts.voiceId ?? 'default',
        model: 'grok-tts-1',
        provider: 'xai',
        metadata: { text },
      }),
    };
    const registry = new TTSProviderRegistry().register(xaiLike);
    const resolved = await registry.getProvider('xai');
    expect(resolved).not.toBeNull();
    const voices = (await resolved!.listVoices?.()) ?? [];
    expect(voices.some((v) => v.cloned)).toBe(true);
    const result = await resolved!.synthesize('hello', { voiceId: 'cloned-abc' });
    expect(result.voiceId).toBe('cloned-abc');
    expect(result.provider).toBe('xai');
  });
});

describe('Piper provider (#325)', () => {
  it('requires modelPath at construction', () => {
    expect(() => createPiperProvider({ modelPath: '' as string })).toThrow(/modelPath/);
  });

  it('derives voiceId from the model filename', async () => {
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      // Point at a non-existent binary so we don't actually shell out.
      binaryPath: '/__nonexistent__/piper',
    });
    const voices = await provider.listVoices?.();
    expect(voices?.[0]?.voiceId).toBe('en_US-amy-low');
  });

  it('health returns ok=false with a clear reason when the binary is missing', async () => {
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: '/this/path/does/not/exist/piper',
    });
    const health = await provider.health!();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/piper binary not found|piper --help failed/);
  });

  it('synthesize throws ENOENT-style error when the binary is missing', async () => {
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: '/__nonexistent__/piper',
    });
    await expect(provider.synthesize('hello', {})).rejects.toThrow(/Piper binary not found/);
  });

  it('synthesize rejects empty text', async () => {
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: '/__nonexistent__/piper',
    });
    await expect(provider.synthesize('', {})).rejects.toThrow(/non-empty text/);
  });

  it('synthesize uses opts.voiceId when provided (fake piper via /bin/sh)', async () => {
    // We can't shell out to real piper in CI. Stub the "binary" with
    // /bin/sh and a one-shot script that ignores the --model/--output_file
    // args and echoes stdin to stdout. This proves:
    //   1. The provider passes text via stdin (not args — important for
    //      security: agent-generated text must not become shell args).
    //   2. The provider reads stdout into result.audio.
    //   3. opts.voiceId overrides the model-derived default.
    // A real piper run looks identical from the caller's perspective.
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: '/bin/sh',
    });
    // Re-shape args via `binaryPath: '/bin/sh'` doesn't work directly
    // because we can't inject `-c` script in this API. Skip the echo
    // assertion — instead, install a tiny shell script on disk that
    // ignores its args and cats stdin.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-piper-test-'));
    const fakePiper = path.join(dir, 'fake-piper.sh');
    await fs.writeFile(fakePiper, '#!/bin/sh\ncat\n', { mode: 0o755 });

    const stubbed = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: fakePiper,
    });
    try {
      const result: TTSSynthesisResult = await stubbed.synthesize('audio bytes', {
        voiceId: 'override-voice',
      });
      expect(result.provider).toBe('piper');
      expect(result.voiceId).toBe('override-voice');
      expect(result.mime).toBe('audio/wav');
      const echoed = new TextDecoder().decode(result.audio);
      expect(echoed).toBe('audio bytes');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    // Reference to keep tsc happy; the real assertion is on `stubbed`.
    expect(provider.name).toBe('piper');
  });

  it('synthesize surfaces non-zero exit with stderr', async () => {
    // Tiny shell script that prints to stderr and exits 1 — same shape
    // as a real piper failure (missing voice model, malformed input).
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-piper-fail-'));
    const fakePiper = path.join(dir, 'fake-piper.sh');
    await fs.writeFile(fakePiper, '#!/bin/sh\necho "bad model" >&2\nexit 1\n', { mode: 0o755 });
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: fakePiper,
    });
    try {
      await expect(provider.synthesize('hello', {})).rejects.toThrow(/Piper exited 1.*bad model/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('synthesize surfaces "empty audio" when piper exits 0 with no stdout', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-piper-empty-'));
    const fakePiper = path.join(dir, 'fake-piper.sh');
    await fs.writeFile(fakePiper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const provider = createPiperProvider({
      modelPath: '/voices/en_US-amy-low.onnx',
      binaryPath: fakePiper,
    });
    try {
      await expect(provider.synthesize('hello', {})).rejects.toThrow(/empty audio/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function fakeAudio(name: string): TTSSynthesisResult {
  return {
    audio: new TextEncoder().encode(name),
    mime: 'audio/mpeg',
    voiceId: 'fake',
    model: '',
    provider: name,
  };
}

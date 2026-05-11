// v0.9.0 (#324) — xAI Custom Voices TTS + voice cloning. Acceptance criteria:
//   - voice.tts returns audio for valid voiceId
//   - voice.clone uploads sample, returns voiceId
//   - Audit event recorded with sample hash
//   - Multi-provider: switching `provider` param yields different audio
//
// All network is stubbed via vi.stubGlobal('fetch'). No real xAI calls.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TTSProviderRegistry,
  createXaiTtsProvider,
  createMultiProviderTtsTool,
  createXaiVoiceCloneProvider,
  createVoiceCloneTool,
  ToolRegistry,
  type TTSProvider,
} from '@crowclaw/tools';

describe('xAI TTS provider (#324)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects construction without an apiKey', () => {
    expect(() => createXaiTtsProvider({ apiKey: '' })).toThrow(/apiKey/);
  });

  it('synthesize POSTs to /v1/audio/speech with Bearer token', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createXaiTtsProvider({ apiKey: 'xai-test-key' });
    const result = await provider.synthesize('hello', { voiceId: 'cloned-abc', format: 'mp3' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/audio/speech');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xai-test-key');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body.voice).toBe('cloned-abc');
    expect(body.input).toBe('hello');
    expect(body.response_format).toBe('mp3');

    expect(result.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(result.mime).toBe('audio/mpeg');
    expect(result.voiceId).toBe('cloned-abc');
    expect(result.provider).toBe('xai');
  });

  it('synthesize throws with status detail on API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    const provider = createXaiTtsProvider({ apiKey: 'k' });
    await expect(provider.synthesize('hello', {})).rejects.toThrow(/429.*quota exceeded/);
  });

  it('listVoices flags cloned voices via the `cloned` field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      voices: [
        { id: 'default', name: 'Default', language: 'en' },
        { id: 'clone-xyz', name: 'My voice', cloned: true },
        { id: 'clone-zzz', kind: 'cloned' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const provider = createXaiTtsProvider({ apiKey: 'k' });
    const voices = await provider.listVoices!();
    expect(voices).toHaveLength(3);
    expect(voices.find((v) => v.voiceId === 'default')?.cloned).toBe(false);
    expect(voices.find((v) => v.voiceId === 'clone-xyz')?.cloned).toBe(true);
    expect(voices.find((v) => v.voiceId === 'clone-zzz')?.cloned).toBe(true);
  });

  it('health reports 401 as not-ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const provider = createXaiTtsProvider({ apiKey: 'wrong' });
    const health = await provider.health!();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('401');
  });

  it('health is ok on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const provider = createXaiTtsProvider({ apiKey: 'k' });
    const health = await provider.health!();
    expect(health.ok).toBe(true);
  });
});

describe('multi-provider voice.tts tool (#324, AC4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('dispatches to the requested provider', async () => {
    // Two stub providers that emit different bytes — verify the tool picks
    // the right one and surfaces each provider's output.
    const a = makeStubProvider('alpha', new Uint8Array([0xAA]));
    const b = makeStubProvider('beta', new Uint8Array([0xBB]));
    const registry = new TTSProviderRegistry().register(a).register(b);
    const tool = createMultiProviderTtsTool({ registry });
    const toolReg = new ToolRegistry().register(tool);

    const resA = await toolReg.execute('voice.tts',
      { text: 'hi', provider: 'alpha' },
      { agentId: 'crowclaw', sessionId: 'tts-a' });
    expect(resA.ok).toBe(true);
    expect((resA.metadata as { provider: string }).provider).toBe('alpha');

    const resB = await toolReg.execute('voice.tts',
      { text: 'hi', provider: 'beta' },
      { agentId: 'crowclaw', sessionId: 'tts-b' });
    expect(resB.ok).toBe(true);
    expect((resB.metadata as { provider: string }).provider).toBe('beta');
    // Switching provider yields different audio — AC4.
    expect((resA.metadata as { audioBase64: string }).audioBase64)
      .not.toBe((resB.metadata as { audioBase64: string }).audioBase64);
  });

  it('returns a clear error for unknown provider', async () => {
    const registry = new TTSProviderRegistry().register(makeStubProvider('only-this', new Uint8Array([1])));
    const tool = createMultiProviderTtsTool({ registry });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.tts',
      { text: 'hi', provider: 'nope' },
      { agentId: 'crowclaw', sessionId: 'tts-bad' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Unknown TTS provider');
    expect((result.metadata as { available: string[] }).available).toContain('only-this');
  });

  it('uses defaultProvider when input.provider omitted', async () => {
    const registry = new TTSProviderRegistry().register(makeStubProvider('dflt', new Uint8Array([42])));
    const tool = createMultiProviderTtsTool({ registry, defaultProvider: 'dflt' });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.tts',
      { text: 'hi' },
      { agentId: 'crowclaw', sessionId: 'tts-dflt' });
    expect(result.ok).toBe(true);
    expect((result.metadata as { provider: string }).provider).toBe('dflt');
  });

  it('errors when neither input.provider nor defaultProvider is set', async () => {
    const registry = new TTSProviderRegistry();
    const tool = createMultiProviderTtsTool({ registry });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.tts',
      { text: 'hi' },
      { agentId: 'crowclaw', sessionId: 'tts-noprov' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing provider parameter');
  });

  it('writes audio to outputPath when provided', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-tts-out-'));
    const out = path.join(dir, 'speech.bin');

    const registry = new TTSProviderRegistry().register(makeStubProvider('p', new Uint8Array([1, 2, 3])));
    const tool = createMultiProviderTtsTool({ registry, defaultProvider: 'p' });
    const toolReg = new ToolRegistry().register(tool);
    try {
      const result = await toolReg.execute('voice.tts',
        { text: 'hi', outputPath: out },
        { agentId: 'crowclaw', sessionId: 'tts-write' });
      expect(result.ok).toBe(true);
      const written = await fs.readFile(out);
      expect(written.length).toBe(3);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces synthesizer errors as ok:false', async () => {
    const failing: TTSProvider = {
      name: 'fail',
      displayName: 'Failing',
      synthesize: async () => { throw new Error('rate limited'); },
    };
    const registry = new TTSProviderRegistry().register(failing);
    const tool = createMultiProviderTtsTool({ registry, defaultProvider: 'fail' });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.tts',
      { text: 'hi' },
      { agentId: 'crowclaw', sessionId: 'tts-fail' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('rate limited');
  });
});

describe('voice.clone tool (#324, AC2/AC3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('xAI clone provider POSTs multipart and returns voiceId', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'voice_abc123',
      name: 'My voice',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createXaiVoiceCloneProvider({ apiKey: 'k' });
    const result = await provider.cloneVoice({
      sample: new Uint8Array([1, 2, 3, 4]),
      mime: 'audio/mpeg',
      name: 'My voice',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.ai/v1/audio/voices/clone');
    expect((init as RequestInit).method).toBe('POST');
    // multipart body — assert we passed FormData, not JSON.
    expect((init as RequestInit).body).toBeInstanceOf(FormData);

    expect(result.voiceId).toBe('voice_abc123');
    expect(result.name).toBe('My voice');
  });

  it('voice.clone tool computes a SHA-256 hash of the sample (AC3)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'voice_x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    // Write a small sample file the tool can read.
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-clone-'));
    const samplePath = path.join(dir, 'sample.mp3');
    await fs.writeFile(samplePath, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

    const xai = createXaiVoiceCloneProvider({ apiKey: 'k' });
    const tool = createVoiceCloneTool({ providers: { xai }, defaultProvider: 'xai' });
    const toolReg = new ToolRegistry().register(tool);
    try {
      const result = await toolReg.execute('voice.clone', {
        name: 'My voice',
        samplePath,
      }, { agentId: 'crowclaw', sessionId: 'clone-1' });

      expect(result.ok).toBe(true);
      const meta = result.metadata as Record<string, unknown>;
      expect(meta.voiceId).toBe('voice_x');
      expect(meta.provider).toBe('xai');
      // SHA-256 of [0xDE, 0xAD, 0xBE, 0xEF]:
      //   5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953
      expect(meta.sampleSha256).toBe('5f78c33274e43fa9de5659265c1d917e25c03722dcb0b8d27db8d5feaa813953');
      expect(meta.sampleBytes).toBe(4);
      expect(meta.sampleMime).toBe('audio/mpeg');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('voice.clone blocks cloud-metadata sample URLs via SSRF floor', async () => {
    // Cross-cut: voice.clone routes its sampleUrl through #298's
    // assertSafeUrl. Cloud-metadata hosts must be denied before any fetch.
    const fetchMock = vi.fn(async () => new Response('should not be called'));
    vi.stubGlobal('fetch', fetchMock);

    const xai = createXaiVoiceCloneProvider({ apiKey: 'k' });
    const tool = createVoiceCloneTool({ providers: { xai }, defaultProvider: 'xai' });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.clone', {
      name: 'evil',
      sampleUrl: 'http://metadata.google.internal/computeMetadata/v1/instance/',
    }, { agentId: 'crowclaw', sessionId: 'clone-ssrf' });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('URL blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('voice.clone surfaces unknown provider', async () => {
    const tool = createVoiceCloneTool({ providers: {} });
    const toolReg = new ToolRegistry().register(tool);
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crowclaw-clone-'));
    const samplePath = path.join(dir, 'sample.mp3');
    await fs.writeFile(samplePath, Buffer.from([1, 2, 3]));
    try {
      const result = await toolReg.execute('voice.clone', {
        name: 'x',
        samplePath,
        provider: 'nope',
      }, { agentId: 'crowclaw', sessionId: 'clone-noprov' });
      expect(result.ok).toBe(false);
      expect(result.output).toContain('Unknown voice-clone provider');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('voice.clone requires either samplePath or sampleUrl', async () => {
    const xai = createXaiVoiceCloneProvider({ apiKey: 'k' });
    const tool = createVoiceCloneTool({ providers: { xai }, defaultProvider: 'xai' });
    const toolReg = new ToolRegistry().register(tool);
    const result = await toolReg.execute('voice.clone', {
      name: 'x',
    }, { agentId: 'crowclaw', sessionId: 'clone-no-sample' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('samplePath or sampleUrl');
  });
});

function makeStubProvider(name: string, audio: Uint8Array): TTSProvider {
  return {
    name,
    displayName: name,
    synthesize: async (text, opts) => ({
      audio,
      mime: 'audio/mpeg',
      voiceId: opts.voiceId ?? 'default',
      model: opts.model ?? '',
      provider: name,
      metadata: { text },
    }),
  };
}

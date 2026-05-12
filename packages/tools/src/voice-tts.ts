/**
 * v0.9.0 (#324) — xAI Custom Voices TTS provider + the `voice.tts` tool
 * shape that selects across providers via the #325 registry.
 *
 * xAI Custom Voices is documented in Hermes v0.13 #18776. The relevant API
 * surface (as of late 2025):
 *   POST {baseUrl}/v1/audio/speech    — body { model, voice, input, format? }
 *   GET  {baseUrl}/v1/audio/voices    — list voices, includes cloned ones
 *
 * We treat xAI like any other OpenAI-compatible TTS endpoint. The voice ID
 * is either one of xAI's stock voices or a clone ID returned by
 * `voice.clone` (see voice-clone.ts).
 *
 * Provider-dispatch tool: `voice.tts({ text, voiceId, provider? })`. When
 * `provider` is omitted the registry's first ready provider wins. This is
 * the surface #324's AC1 ("voice.tts returns audio for valid voiceId") and
 * AC4 ("multi-provider: switching provider yields different audio") target.
 */

import type { ToolDefinition, ToolExecutionResult, ToolExecutionContext } from '@crowclaw/core';
import type {
  TTSProvider,
  TTSProviderRegistry,
  TTSSynthesisOptions,
  TTSSynthesisResult,
  TTSVoiceDescriptor,
} from './tts-registry.js';

// ---------------------------------------------------------------------------
// xAI Custom Voices provider
// ---------------------------------------------------------------------------

export interface XaiTtsProviderOptions {
  /** xAI Grok API key. Required — surfaces a clear health error if missing. */
  apiKey: string;
  /** Override the base URL. Defaults to xAI's production endpoint. The
   * structure mirrors OpenAI so swapping baseUrls for tests is trivial. */
  baseUrl?: string;
  /** Default model identifier. Defaults to `'grok-tts-1'` per xAI's docs. */
  defaultModel?: string;
  /** Default voice ID when the caller doesn't pass one. */
  defaultVoiceId?: string;
}

export function createXaiTtsProvider(options: XaiTtsProviderOptions): TTSProvider {
  if (!options.apiKey) {
    // Construction-time validation: missing apiKey is a config bug, not a
    // runtime fallback. Make it loud at register-time, not on first synth.
    throw new Error('createXaiTtsProvider requires `apiKey`');
  }
  const baseUrl = (options.baseUrl ?? 'https://api.x.ai').replace(/\/$/, '');
  const defaultModel = options.defaultModel ?? 'grok-tts-1';
  const defaultVoiceId = options.defaultVoiceId ?? 'default';

  return {
    name: 'xai',
    displayName: 'xAI Custom Voices',

    listVoices: async (): Promise<TTSVoiceDescriptor[]> => {
      const response = await fetch(`${baseUrl}/v1/audio/voices`, {
        headers: { Authorization: `Bearer ${options.apiKey}` },
      });
      if (!response.ok) {
        // Don't throw — `crowclaw tts voices` should still print *something*
        // useful. Return an empty list; health() carries the error detail.
        return [];
      }
      const payload = (await response.json()) as { voices?: unknown };
      if (!Array.isArray(payload.voices)) return [];
      return payload.voices
        .map((entry): TTSVoiceDescriptor | null => {
          if (!entry || typeof entry !== 'object') return null;
          const obj = entry as Record<string, unknown>;
          const voiceId = typeof obj.id === 'string'
            ? obj.id
            : typeof obj.voice_id === 'string'
              ? obj.voice_id
              : null;
          if (!voiceId) return null;
          return {
            voiceId,
            displayName: typeof obj.name === 'string' ? obj.name : undefined,
            language: typeof obj.language === 'string' ? obj.language : undefined,
            // xAI tags clones with `kind: 'cloned'` or `cloned: true`.
            cloned: obj.cloned === true || obj.kind === 'cloned',
          };
        })
        .filter((v): v is TTSVoiceDescriptor => v !== null);
    },

    health: async () => {
      // A 401 from /v1/audio/voices is the canonical "bad API key" signal.
      // We don't make a synthesis call here because that would burn quota.
      try {
        const response = await fetch(`${baseUrl}/v1/audio/voices`, {
          headers: { Authorization: `Bearer ${options.apiKey}` },
        });
        if (response.ok) return { ok: true, detail: `xAI reachable (model: ${defaultModel})` };
        if (response.status === 401) {
          return { ok: false, detail: 'xAI API key rejected (401)' };
        }
        return { ok: false, detail: `xAI returned ${response.status}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, detail: `xAI health check failed: ${msg}` };
      }
    },

    synthesize: async (text: string, opts: TTSSynthesisOptions): Promise<TTSSynthesisResult> => {
      if (!text) throw new Error('xAI synthesize() requires non-empty text');
      const voiceId = opts.voiceId ?? defaultVoiceId;
      const model = opts.model ?? defaultModel;
      const format = opts.format ?? 'mp3';
      const response = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, voice: voiceId, input: text, response_format: format }),
        signal: opts.signal,
      });
      if (!response.ok) {
        const detail = await safeReadBody(response);
        throw new Error(`xAI TTS failed: ${response.status} ${response.statusText} ${detail ? `— ${detail}` : ''}`.trim());
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      return {
        audio: buffer,
        mime: formatToMime(format),
        voiceId,
        model,
        provider: 'xai',
        metadata: { bytes: buffer.length, format },
      };
    },
  };
}

function formatToMime(format: NonNullable<TTSSynthesisOptions['format']>): string {
  switch (format) {
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'ogg': return 'audio/ogg';
    case 'opus': return 'audio/opus';
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Multi-provider voice.tts tool (registry-aware)
// ---------------------------------------------------------------------------

export interface MultiProviderTtsToolOptions {
  /** The provider registry to dispatch through. Must be pre-populated. */
  registry: TTSProviderRegistry;
  /** Default provider name when the caller doesn't specify one. */
  defaultProvider?: string;
  /** Tool name override. Defaults to `'voice.tts'`. Set this when wiring
   * alongside the legacy `voice.tts` from voice.ts to avoid a collision. */
  toolName?: string;
}

/**
 * Create a multi-provider `voice.tts` tool. The tool's input shape:
 *   { text, voiceId?, provider?, model?, format?, outputPath? }
 *
 * The tool resolves `provider` against the registry, calls `synthesize`,
 * and either returns the bytes encoded as base64 in the metadata, or
 * writes them to `outputPath` and returns the path. Defaults match
 * `voice.tts` from voice.ts so callers can swap implementations.
 */
export function createMultiProviderTtsTool(options: MultiProviderTtsToolOptions): ToolDefinition {
  const toolName = options.toolName ?? 'voice.tts';
  return {
    manifest: {
      name: toolName,
      description: 'Multi-provider text-to-speech. Dispatches across registered TTS providers.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to synthesize.' },
          provider: { type: 'string', description: 'TTS provider name (e.g. "piper", "xai", "openai").' },
          voiceId: { type: 'string', description: 'Provider-specific voice identifier.' },
          model: { type: 'string', description: 'Provider-specific model override.' },
          format: { type: 'string', description: 'Output format: mp3 / wav / ogg / opus.' },
          outputPath: { type: 'string', description: 'When set, write audio to this path and return it.' },
        },
        required: ['text'],
      },
    },
    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const text = typeof input.text === 'string' ? input.text : '';
      const providerName = typeof input.provider === 'string'
        ? input.provider
        : options.defaultProvider;
      const voiceId = typeof input.voiceId === 'string' ? input.voiceId : undefined;
      const model = typeof input.model === 'string' ? input.model : undefined;
      const format = (typeof input.format === 'string' && /^(mp3|wav|ogg|opus)$/.test(input.format))
        ? (input.format as TTSSynthesisOptions['format'])
        : undefined;
      const outputPath = typeof input.outputPath === 'string' ? input.outputPath : undefined;

      if (!text) {
        return { toolName, runtime: 'worker', ok: false, output: 'Missing text parameter.' };
      }
      if (!providerName) {
        const available = options.registry.list();
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `Missing provider parameter (no defaultProvider configured). Available: ${available.join(', ') || 'none'}.`,
          metadata: { available },
        };
      }
      const provider = await options.registry.getProvider(providerName);
      if (!provider) {
        const available = options.registry.list();
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `Unknown TTS provider '${providerName}'. Available: ${available.join(', ') || 'none'}.`,
          metadata: { available, requested: providerName },
        };
      }
      try {
        const result = await provider.synthesize(text, { voiceId, model, format, signal: context.signal });
        if (outputPath) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(outputPath, result.audio);
          return {
            toolName,
            runtime: 'worker',
            ok: true,
            output: `Audio saved to ${outputPath} (${result.audio.length} bytes)`,
            metadata: {
              provider: result.provider,
              voiceId: result.voiceId,
              model: result.model,
              mime: result.mime,
              path: outputPath,
              sizeBytes: result.audio.length,
              ...(result.metadata ?? {}),
            },
          };
        }
        const base64 = bytesToBase64(result.audio);
        return {
          toolName,
          runtime: 'worker',
          ok: true,
          output: `Generated ${result.audio.length} bytes of ${result.mime} (provider: ${result.provider}, voice: ${result.voiceId})`,
          metadata: {
            provider: result.provider,
            voiceId: result.voiceId,
            model: result.model,
            mime: result.mime,
            sizeBytes: result.audio.length,
            audioBase64: base64,
            ...(result.metadata ?? {}),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `TTS failed (${provider.name}): ${msg}`,
          metadata: { provider: provider.name },
        };
      }
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Node has Buffer; on Cloudflare Workers we fall through to atob/btoa.
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return (globalThis as unknown as { btoa(s: string): string }).btoa(binary);
}

/**
 * v0.9.0 (#324) — voice.clone tool. Uploads a sample audio clip to xAI
 * (or any compatible provider) and returns a voice ID that subsequent
 * `voice.tts` calls can use. Hermes v0.13 #18776 ships this as part of
 * the xAI Custom Voices feature.
 *
 * Provider abstraction:
 *  - For the v0.9.0 scope only xAI implements cloning. We define a
 *    `VoiceCloneProvider` interface anyway so future providers (ElevenLabs,
 *    Resemble) drop in without changing the tool surface.
 *  - The tool computes a SHA-256 of the sample bytes and threads it into
 *    the audit log via the result metadata. The issue's AC explicitly
 *    requires `Audit event recorded with sample hash`.
 *
 * Sample input:
 *  - `samplePath` (string) — local path on the agent's filesystem
 *  - `sampleUrl` (string)  — HTTP(S) URL. Validated through #298's
 *    `assertSafeUrl({ kind: 'image' })` (v0.9.1 migration) so a cloud-metadata
 *    host can't be coerced into the upload. Per the cross-cut in the recovery
 *    prompt, this is a downstream consumer of the central SSRF floor and now
 *    reports the central SSRF_CLOUD_METADATA / SSRF_PRIVATE_NETWORK forensic
 *    codes instead of a local stopgap check.
 */

import type { ToolDefinition, ToolExecutionResult, ToolExecutionContext } from '@crowclaw/core';
import { assertSafeUrl } from './ssrf-blocklist.js';

export interface VoiceCloneProvider {
  /** Provider identifier. Echoed into the result metadata. */
  name: string;
  /** Upload sample audio and return the voice ID assigned to it. */
  cloneVoice: (input: VoiceCloneInput) => Promise<VoiceCloneResult>;
}

export interface VoiceCloneInput {
  /** Sample audio bytes. */
  sample: Uint8Array;
  /** Mime type of the sample (audio/mpeg, audio/wav, audio/ogg, etc.). */
  mime: string;
  /** User-supplied friendly name for the cloned voice. */
  name: string;
  /** Free-form description shown in provider dashboards. */
  description?: string;
  /** Cancellation signal threaded from `ToolExecutionContext.signal`. */
  signal?: AbortSignal;
}

export interface VoiceCloneResult {
  voiceId: string;
  /** Optional name echoed back by the provider (may differ from input). */
  name?: string;
  /** Provider-specific extras (URL to dashboard, training duration, ...). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// xAI Custom Voices cloning provider
// ---------------------------------------------------------------------------

export interface XaiVoiceCloneProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createXaiVoiceCloneProvider(options: XaiVoiceCloneProviderOptions): VoiceCloneProvider {
  if (!options.apiKey) throw new Error('createXaiVoiceCloneProvider requires `apiKey`');
  const baseUrl = (options.baseUrl ?? 'https://api.x.ai').replace(/\/$/, '');

  return {
    name: 'xai',
    cloneVoice: async (input: VoiceCloneInput): Promise<VoiceCloneResult> => {
      // xAI's voice-clone surface (mirroring ElevenLabs / Resemble shape):
      //   POST {baseUrl}/v1/audio/voices/clone
      //   multipart/form-data: file (sample), name, description?
      // Returns: { id: "voice_abc123", name, ... }
      const formData = new FormData();
      // Detached ArrayBuffer slice so the Blob ctor accepts it under strict
      // SharedArrayBuffer-aware lib types. Same bytes, just narrows the type.
      const sampleBuffer = input.sample.buffer.slice(
        input.sample.byteOffset,
        input.sample.byteOffset + input.sample.byteLength,
      ) as ArrayBuffer;
      formData.append('file', new Blob([sampleBuffer], { type: input.mime }), `sample.${mimeToExt(input.mime)}`);
      formData.append('name', input.name);
      if (input.description) formData.append('description', input.description);

      const response = await fetch(`${baseUrl}/v1/audio/voices/clone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: formData,
        signal: input.signal,
      });
      if (!response.ok) {
        const detail = await safeReadBody(response);
        throw new Error(`xAI voice clone failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const voiceId = typeof payload.id === 'string'
        ? payload.id
        : typeof payload.voice_id === 'string'
          ? payload.voice_id
          : null;
      if (!voiceId) throw new Error('xAI voice clone response missing voice ID');
      return {
        voiceId,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        metadata: payload,
      };
    },
  };
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'audio/mpeg': return 'mp3';
    case 'audio/wav': return 'wav';
    case 'audio/x-wav': return 'wav';
    case 'audio/ogg': return 'ogg';
    case 'audio/flac': return 'flac';
    default: return 'bin';
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
// voice.clone tool surface
// ---------------------------------------------------------------------------

export interface VoiceCloneToolOptions {
  /** Map of provider name → provider implementation. Caller controls which
   * providers are available; the tool dispatches via `input.provider`. */
  providers: Record<string, VoiceCloneProvider>;
  /** Default provider name when `input.provider` is omitted. */
  defaultProvider?: string;
  /** Tool name override. Defaults to `'voice.clone'`. */
  toolName?: string;
}

export function createVoiceCloneTool(options: VoiceCloneToolOptions): ToolDefinition {
  const toolName = options.toolName ?? 'voice.clone';
  return {
    manifest: {
      name: toolName,
      description: 'Clone a voice from a sample audio clip. Returns a voiceId usable by voice.tts.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      // Voice cloning has both privacy and impersonation implications; we
      // flag it medium so the approval-gate skill can prompt the operator
      // before the upload goes out.
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Friendly name for the cloned voice.' },
          description: { type: 'string', description: 'Optional description shown in provider dashboards.' },
          provider: { type: 'string', description: 'Provider name (e.g. "xai").' },
          samplePath: { type: 'string', description: 'Local filesystem path to the audio sample.' },
          sampleUrl: { type: 'string', description: 'HTTP(S) URL of the audio sample (SSRF-checked).' },
        },
        required: ['name'],
      },
    },
    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const description = typeof input.description === 'string' ? input.description : undefined;
      const samplePath = typeof input.samplePath === 'string' ? input.samplePath : '';
      const sampleUrl = typeof input.sampleUrl === 'string' ? input.sampleUrl : '';
      const providerName = typeof input.provider === 'string'
        ? input.provider
        : options.defaultProvider;

      if (!name) {
        return { toolName, runtime: 'worker', ok: false, output: 'Missing required parameter: name.' };
      }
      if (!samplePath && !sampleUrl) {
        return { toolName, runtime: 'worker', ok: false, output: 'Provide either samplePath or sampleUrl.' };
      }
      if (!providerName) {
        const available = Object.keys(options.providers);
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `Missing provider parameter (no defaultProvider). Available: ${available.join(', ') || 'none'}.`,
          metadata: { available },
        };
      }
      const provider = options.providers[providerName.trim().toLowerCase()]
        ?? options.providers[providerName];
      if (!provider) {
        const available = Object.keys(options.providers);
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `Unknown voice-clone provider '${providerName}'. Available: ${available.join(', ') || 'none'}.`,
          metadata: { available, requested: providerName },
        };
      }

      let sampleBytes: Uint8Array;
      let mime: string;
      try {
        if (samplePath) {
          const fs = await import('node:fs/promises');
          const data = await fs.readFile(samplePath);
          sampleBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          mime = guessMimeFromPath(samplePath);
        } else {
          // v0.9.1 (#298 migration) — SSRF preflight through the canonical
          // `assertSafeUrl` helper with `kind: 'image'`. The sample is media
          // fetched on the agent's behalf, so it routes through the same media
          // SSRF discriminator as vision/image tools; this gets the central
          // SSRF_CLOUD_METADATA / SSRF_PRIVATE_NETWORK forensic codes (no more
          // local stopgap validateFetchUrl). Cloud-metadata hosts and private
          // networks must not be reachable via voice.clone's sample fetch.
          const safety = await assertSafeUrl(sampleUrl, { kind: 'image' });
          if (!safety.safe) {
            return {
              toolName,
              runtime: 'worker',
              ok: false,
              output: `URL blocked: ${safety.reason}`,
              metadata: { ssrfDeniedKind: safety.kind, ssrfCode: safety.code },
            };
          }
          const response = await fetch(sampleUrl, { signal: context.signal, redirect: 'manual' });
          if (!response.ok) {
            return {
              toolName,
              runtime: 'worker',
              ok: false,
              output: `Sample download failed: ${response.status} ${response.statusText}`,
            };
          }
          sampleBytes = new Uint8Array(await response.arrayBuffer());
          mime = response.headers.get('content-type')?.split(';')[0]?.trim() || guessMimeFromPath(sampleUrl);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolName, runtime: 'worker', ok: false, output: `Sample read failed: ${msg}` };
      }

      // Audit hash: SHA-256 of the sample bytes. AC: "Audit event recorded
      // with sample hash". The hash is exposed in metadata so the gateway's
      // audit logger picks it up; we don't gate on `context.securityAuditLog`
      // here because the tool layer doesn't own that handle.
      const sampleHash = await sha256Hex(sampleBytes);

      try {
        const result = await provider.cloneVoice({
          sample: sampleBytes,
          mime,
          name,
          description,
          signal: context.signal,
        });
        return {
          toolName,
          runtime: 'worker',
          ok: true,
          output: `Cloned voice '${name}' as ${result.voiceId} (provider: ${provider.name})`,
          metadata: {
            provider: provider.name,
            voiceId: result.voiceId,
            voiceName: result.name ?? name,
            sampleSha256: sampleHash,
            sampleBytes: sampleBytes.length,
            sampleMime: mime,
            ...(result.metadata ?? {}),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          toolName,
          runtime: 'worker',
          ok: false,
          output: `Voice clone failed (${provider.name}): ${msg}`,
          metadata: { provider: provider.name, sampleSha256: sampleHash },
        };
      }
    },
  };
}

function guessMimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'ogg': case 'oga': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'm4a': case 'mp4': return 'audio/mp4';
    default: return 'audio/mpeg';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Prefer the Web Crypto API — available in Node 19+ and Cloudflare Workers.
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback: node:crypto. Not async in older versions; wrap in Promise.resolve.
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

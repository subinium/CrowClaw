/**
 * v0.9.0 (#325) — pluggable TTS provider registry. Hermes v0.12 #17843 / #17885
 * shipped a primitive that decouples the `voice.tts` call site from the
 * concrete synthesizer (OpenAI, ElevenLabs, Piper, xAI Custom Voices, ...).
 * The xAI Custom Voices issue (#324) plugs into the same registry.
 *
 * Design:
 *  - `TTSProvider` is a small interface: `{ name, displayName, synthesize }`.
 *  - `synthesize(text, opts)` returns `TTSSynthesisResult` — audio bytes plus
 *    metadata (mime, voiceId, model). Returning bytes (not a stream) keeps
 *    the call site simple and matches what every adapter we'll ever ship
 *    needs to hand off to the channel (file upload, base64 data URI, etc.).
 *  - The registry is a tiny `Map` wrapper, not a class hierarchy. The goal
 *    is to swap providers, not to invent a framework.
 *  - Providers can be *async-constructed*: `register(provider)` accepts an
 *    eagerly-created provider, and `registerLazy(name, factory)` accepts a
 *    factory for cases like Piper where binary discovery is async.
 */

export interface TTSSynthesisResult {
  /** Audio bytes. Caller decides whether to write to disk, base64-encode for
   * inline delivery, or stream onward. */
  audio: Uint8Array;
  /** MIME type of `audio` — typically 'audio/mpeg' (mp3), 'audio/wav', or
   * 'audio/ogg'. Used by gateway adapters when uploading. */
  mime: string;
  /** Resolved voice ID actually used (provider may map a friendly name). */
  voiceId: string;
  /** Model identifier when applicable (OpenAI: 'tts-1' / 'tts-1-hd'; Piper:
   * the .onnx model basename). Empty string when the provider has no model
   * concept. */
  model: string;
  /** Provider name that produced the audio. Echo of `provider.name`. */
  provider: string;
  /** Any provider-specific extras (e.g. requestId, durationMs). */
  metadata?: Record<string, unknown>;
}

export interface TTSSynthesisOptions {
  /** Voice identifier. Provider-specific format. */
  voiceId?: string;
  /** Provider-specific model override. */
  model?: string;
  /** Output format hint. Some providers (Piper) only emit one format and
   * will ignore this. Defaults to 'mp3' where the provider supports it. */
  format?: 'mp3' | 'wav' | 'ogg' | 'opus';
  /** Abort signal threaded from `ToolExecutionContext.signal`. */
  signal?: AbortSignal;
  /** Free-form metadata passed to the provider — useful for xAI clone IDs,
   * ElevenLabs voice settings, etc. */
  metadata?: Record<string, unknown>;
}

export interface TTSProvider {
  /** Stable identifier — used as the registry key. Lowercase, kebab-case. */
  name: string;
  /** Human-readable label for UI / `crowclaw tts list`. */
  displayName: string;
  /** Optional: returns the set of voice IDs the provider currently knows about.
   * Surfaced by `crowclaw tts voices`. Missing → caller should treat the voice
   * list as opaque/unknown. */
  listVoices?: () => Promise<TTSVoiceDescriptor[]>;
  /** Synthesize `text` into audio bytes. Throws on permanent failures; for
   * recoverable errors return a result with empty `audio` is *not* allowed —
   * callers always assume `audio.length > 0` on success. */
  synthesize: (text: string, options: TTSSynthesisOptions) => Promise<TTSSynthesisResult>;
  /** Optional: check whether the provider is callable in the current runtime
   * (e.g. Piper binary present on PATH, xAI API key set). When this returns
   * `{ ok: false }`, `crowclaw tts list` shows the provider but flags it as
   * not-ready, and `synthesize` will be expected to throw with a clear
   * message. Implementing this is what unlocks the AC "Missing piper binary
   * → graceful error". */
  health?: () => Promise<TTSProviderHealth>;
}

export interface TTSVoiceDescriptor {
  voiceId: string;
  displayName?: string;
  language?: string;
  /** Whether this voice was cloned from a sample (#324 surface). */
  cloned?: boolean;
}

export interface TTSProviderHealth {
  ok: boolean;
  /** Human-readable status string surfaced in `tts list` output. */
  detail?: string;
}

/**
 * Lightweight registry. We intentionally keep this a plain object with a Map
 * inside — there's no global singleton, callers instantiate as needed (CLI
 * builds one at startup, tests build one per case).
 *
 * Why a class (not a Map directly): the lazy-factory branch needs to memoize
 * the resolved provider so `getProvider` is idempotent. A bare Map would
 * leak the un-memoized factory.
 */
export class TTSProviderRegistry {
  private readonly providers = new Map<string, TTSProvider>();
  private readonly factories = new Map<string, () => Promise<TTSProvider>>();

  /** Register an eagerly-constructed provider. */
  register(provider: TTSProvider): this {
    const name = normalizeProviderName(provider.name);
    if (!name) throw new Error('TTS provider name must be a non-empty string');
    this.providers.set(name, { ...provider, name });
    // If both a factory and an eager provider exist for the same name, the
    // eager one wins. Drop the factory so getProvider doesn't double-resolve.
    this.factories.delete(name);
    return this;
  }

  /**
   * Register a factory that constructs the provider on first use. The
   * factory result is memoized after the first call.
   *
   * Use for providers whose construction is async or expensive: Piper has
   * to probe `piper --version`, xAI has to validate the API key against
   * `/v1/voices`. Doing that at registry-build time would slow startup.
   */
  registerLazy(name: string, factory: () => Promise<TTSProvider>): this {
    const normalized = normalizeProviderName(name);
    if (!normalized) throw new Error('TTS provider name must be a non-empty string');
    this.factories.set(normalized, factory);
    return this;
  }

  /** True when *some* provider is registered under this name (eager or lazy). */
  has(name: string): boolean {
    const normalized = normalizeProviderName(name);
    return this.providers.has(normalized) || this.factories.has(normalized);
  }

  /** Returns the names of every registered provider. Sorted for stable
   * test output. */
  list(): string[] {
    return Array.from(new Set([...this.providers.keys(), ...this.factories.keys()])).sort();
  }

  /** Resolve `name` to a concrete provider, running the factory if needed.
   * Returns `null` when nothing is registered for `name`. */
  async getProvider(name: string): Promise<TTSProvider | null> {
    const normalized = normalizeProviderName(name);
    if (!normalized) return null;
    const eager = this.providers.get(normalized);
    if (eager) return eager;
    const factory = this.factories.get(normalized);
    if (!factory) return null;
    const resolved = await factory();
    // Memoize: subsequent calls skip the factory.
    this.providers.set(normalized, resolved);
    this.factories.delete(normalized);
    return resolved;
  }

  /** Convenience: list providers with their health status. Surfaces what
   * `crowclaw tts list` should print — name, displayName, ready/error. */
  async listWithHealth(): Promise<Array<{ name: string; displayName: string; health: TTSProviderHealth }>> {
    const out: Array<{ name: string; displayName: string; health: TTSProviderHealth }> = [];
    for (const name of this.list()) {
      const provider = await this.getProvider(name);
      if (!provider) continue;
      const health = provider.health
        ? await safeHealth(provider)
        : { ok: true, detail: 'no health check registered (assumed ready)' };
      out.push({ name: provider.name, displayName: provider.displayName, health });
    }
    return out;
  }
}

async function safeHealth(provider: TTSProvider): Promise<TTSProviderHealth> {
  try {
    return await provider.health!();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `health check threw: ${msg}` };
  }
}

function normalizeProviderName(name: string): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Local embedding provider that targets Ollama-compatible HTTP endpoints.
 *
 * Issue #61: Exposes a tunable `contextSize` so operators can trade embedding
 * density against host memory pressure. Mirrors OpenClaw 2026.4.23-beta.4's
 * `memorySearch.local.contextSize` knob.
 *
 * Structurally compatible with `EmbeddingProvider` from `@crowclaw/memory`
 * — kept duck-typed (no import) to avoid a packages/providers → packages/memory
 * dependency cycle.
 */
export interface LocalEmbeddingProviderConfig {
  /** HTTP endpoint base URL — Ollama-compatible (`/api/embeddings`) by default. Defaults to `http://localhost:11434`. */
  baseUrl?: string;
  /** Embedding model id (e.g. `nomic-embed-text`, `mxbai-embed-large`). */
  model: string;
  /**
   * Maximum token context for the embedding call (Ollama `options.num_ctx`).
   * Larger = denser per-chunk semantics, more host memory. Defaults to `4096`.
   * Must be a positive integer if specified.
   */
  contextSize?: number;
  /** Custom fetch implementation (primarily for testing). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Defaults to `30_000`. */
  timeoutMs?: number;
}

interface OllamaEmbeddingsResponse {
  embedding?: number[];
}

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_CONTEXT_SIZE = 4096;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Embedding provider for self-hosted Ollama-compatible endpoints.
 *
 * Per-text requests are issued sequentially: Ollama's `/api/embeddings` is a
 * single-prompt endpoint, so batch fan-out happens client side. For high-throughput
 * workloads pair this with an external embedding service or implement a parallel
 * variant.
 *
 * @example
 * ```ts
 * const provider = new LocalEmbeddingProvider({
 *   model: 'nomic-embed-text',
 *   contextSize: 8192,
 * });
 * const [vector] = await provider.embed(['hello world']);
 * ```
 */
export class LocalEmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly contextSize: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(config: LocalEmbeddingProviderConfig) {
    if (!config.model || typeof config.model !== 'string') {
      throw new Error('LocalEmbeddingProvider: `model` is required.');
    }
    if (config.contextSize !== undefined) {
      if (
        !Number.isInteger(config.contextSize) ||
        config.contextSize <= 0
      ) {
        throw new Error(
          `LocalEmbeddingProvider: \`contextSize\` must be a positive integer, got ${String(
            config.contextSize
          )}.`
        );
      }
    }
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
      throw new Error(
        `LocalEmbeddingProvider: \`timeoutMs\` must be a positive number, got ${String(
          config.timeoutMs
        )}.`
      );
    }

    // Strip trailing slash so endpoint join is deterministic.
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model;
    this.contextSize = config.contextSize ?? DEFAULT_CONTEXT_SIZE;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof this.fetchImpl !== 'function') {
      throw new Error(
        'LocalEmbeddingProvider: no `fetch` implementation available. Pass `config.fetch` or run on a runtime with global `fetch`.'
      );
    }
  }

  /**
   * Embed a batch of texts. Issues one request per text against
   * `${baseUrl}/api/embeddings`, forwarding `contextSize` as `options.num_ctx`.
   *
   * @throws if any underlying request fails or returns a malformed payload.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!Array.isArray(texts)) {
      throw new Error('LocalEmbeddingProvider.embed: `texts` must be an array.');
    }
    if (texts.length === 0) {
      return [];
    }

    const endpoint = `${this.baseUrl}/api/embeddings`;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const prompt = texts[i] ?? '';
      results.push(await this.embedSingle(endpoint, prompt, i));
    }

    return results;
  }

  private async embedSingle(endpoint: string, prompt: string, index: number): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          options: { num_ctx: this.contextSize },
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const aborted =
        error instanceof DOMException && error.name === 'AbortError';
      const message = aborted
        ? `LocalEmbeddingProvider: request timed out after ${this.timeoutMs}ms (text index ${index}).`
        : `LocalEmbeddingProvider: fetch failed for text index ${index}.`;
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodyPreview = await safeReadText(response);
      throw new Error(
        `LocalEmbeddingProvider: HTTP ${response.status} from ${endpoint} (text index ${index})${
          bodyPreview ? `: ${bodyPreview}` : ''
        }`
      );
    }

    let payload: OllamaEmbeddingsResponse;
    try {
      payload = (await response.json()) as OllamaEmbeddingsResponse;
    } catch (error: unknown) {
      throw new Error(
        `LocalEmbeddingProvider: malformed JSON response (text index ${index}).`,
        { cause: error }
      );
    }

    const embedding = payload.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(
        `LocalEmbeddingProvider: missing/empty \`embedding\` in response (text index ${index}).`
      );
    }

    return embedding;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

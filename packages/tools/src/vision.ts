import { type ToolDefinition, type ToolExecutionResult } from '@crowclaw/core';
import { assertSafeUrl } from './ssrf-blocklist.js';

export interface VisionAnalysisOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
  provider?: 'openai' | 'gemini' | 'replicate';
  fallbackProviders?: VisionProviderConfig[];
}

export interface VisionProviderConfig {
  provider: 'openai' | 'gemini' | 'replicate';
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
}

function readEnv(name: string): string | undefined {
  const env = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  const value = env.process?.env?.[name];
  return value && value.trim() ? value : undefined;
}

let cachedDnsLookup: ((host: string) => Promise<string[]>) | null | undefined;

async function loadDnsLookup(): Promise<((host: string) => Promise<string[]>) | null> {
  if (cachedDnsLookup !== undefined) return cachedDnsLookup;
  try {
    const dns = await import('node:dns');
    cachedDnsLookup = async (host: string) => {
      const records = await dns.promises.lookup(host, { all: true });
      return records.map((record) => record.address);
    };
  } catch {
    cachedDnsLookup = null;
  }
  return cachedDnsLookup;
}

async function safeImageUrlPreflight(url: string): Promise<{ safe: boolean; reason?: string }> {
  // v0.9.0 (#298) — route through central choke point with kind=vision so
  // cloud-metadata hostnames (e.g. metadata.google.internal) are rejected
  // even when the regex-only blocklist would let them through.
  const lookup = await loadDnsLookup();
  const result = await assertSafeUrl(url, { kind: 'vision', dnsLookup: lookup });
  return result.safe ? { safe: true } : { safe: false, reason: result.reason };
}

/**
 * Resolve the image source to a URL suitable for the OpenAI vision API.
 * Supports:
 *  - HTTP(S) URLs (passed through)
 *  - data: URIs (passed through)
 *  - Base64-encoded strings (wrapped in a data URI)
 *  - Local file paths (read via fs and base64-encoded)
 */
async function resolveImageUrl(source: string): Promise<string> {
  // Already a URL or data URI
  if (/^https?:\/\//i.test(source) || source.startsWith('data:')) {
    return source;
  }

  // Looks like raw base64 (no whitespace, no path separators at the start)
  if (/^[A-Za-z0-9+/]+=*$/.test(source) && source.length > 100) {
    return `data:image/png;base64,${source}`;
  }

  // Treat as a file path — attempt to read and base64-encode
  try {
    const fs = await import('node:fs');
    const data = await fs.promises.readFile(source);
    const base64 = data.toString('base64');
    // Infer MIME from extension
    const ext = source.split('.').pop()?.toLowerCase() ?? 'png';
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    };
    const mime = mimeMap[ext] ?? 'image/png';
    return `data:${mime};base64,${base64}`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read image file "${source}": ${msg}`);
  }
}

function normalizeVisionProviders(input: Record<string, unknown>, options?: VisionAnalysisOptions): VisionProviderConfig[] {
  const fromInput = Array.isArray(input.providers)
    ? input.providers
        .map((entry): VisionProviderConfig | null => {
          if (!entry || typeof entry !== 'object') return null;
          const obj = entry as Record<string, unknown>;
          const provider = String(obj.provider ?? obj.name ?? '').toLowerCase();
          if (provider !== 'openai' && provider !== 'gemini' && provider !== 'replicate') return null;
          return {
            provider,
            providerBaseUrl: typeof obj.providerBaseUrl === 'string' ? obj.providerBaseUrl : typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
            apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
            model: typeof obj.model === 'string' ? obj.model : undefined,
          };
        })
        .filter((provider): provider is VisionProviderConfig => provider !== null)
    : [];
  if (fromInput.length > 0) return fromInput;

  const primaryKey = (typeof input.apiKey === 'string' ? input.apiKey : undefined) ?? options?.apiKey;
  const primaryBaseUrl = (typeof input.providerBaseUrl === 'string' ? input.providerBaseUrl : undefined) ?? options?.providerBaseUrl;
  const primaryModel = (typeof input.model === 'string' ? input.model : undefined) ?? options?.model;
  const providers: VisionProviderConfig[] = [];
  if (primaryKey) {
    providers.push({
      provider: options?.provider ?? 'openai',
      apiKey: primaryKey,
      providerBaseUrl: primaryBaseUrl,
      model: primaryModel,
    });
  }
  providers.push(...(options?.fallbackProviders ?? []));
  if (providers.length === 0) {
    const openaiKey = readEnv('OPENAI_API_KEY');
    if (openaiKey) {
      providers.push({
        provider: 'openai',
        apiKey: openaiKey,
        providerBaseUrl: readEnv('LLM_BASE_URL') ?? readEnv('OPENAI_BASE_URL'),
      });
    }
  }
  const googleKey = readEnv('GOOGLE_API_KEY');
  if (googleKey && !providers.some((provider) => provider.provider === 'gemini')) {
    providers.push({ provider: 'gemini', apiKey: googleKey, model: 'gemini-1.5-flash' });
  }
  return providers;
}

async function callVisionProvider(
  provider: VisionProviderConfig,
  resolvedUrl: string,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal
): Promise<{ analysis: string; metadata: Record<string, unknown> }> {
  if (!provider.apiKey) throw new Error('missing apiKey');

  if (provider.provider === 'gemini') {
    const model = provider.model ?? 'gemini-1.5-pro';
    const baseUrl = provider.providerBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { text: `Image URL or data URI: ${resolvedUrl}` }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return {
      analysis: payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() || 'No analysis returned.',
      metadata: { provider: 'gemini', model },
    };
  }

  if (provider.provider === 'replicate') {
    const model = provider.model ?? 'yorickvp/llava-13b';
    const baseUrl = provider.providerBaseUrl ?? 'https://api.replicate.com/v1';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Token ${provider.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: model, input: { image: resolvedUrl, prompt, max_tokens: maxTokens } }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { output?: string | string[]; urls?: { get?: string } };
    const output = Array.isArray(payload.output) ? payload.output.join('') : payload.output;
    return {
      analysis: output ?? (payload.urls?.get ? `Replicate prediction created: ${payload.urls.get}` : 'No analysis returned.'),
      metadata: { provider: 'replicate', model, predictionUrl: payload.urls?.get },
    };
  }

  const baseUrl = provider.providerBaseUrl ?? 'https://api.openai.com/v1';
  const model = provider.model ?? 'gpt-4o';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: resolvedUrl } },
          { type: 'text', text: prompt }
        ]
      }]
    }),
    signal
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return {
    analysis: payload.choices?.[0]?.message?.content ?? 'No analysis returned.',
    metadata: { provider: 'openai', model },
  };
}

export function createVisionAnalyzeTool(options?: VisionAnalysisOptions): ToolDefinition {
  return {
    manifest: {
      name: 'vision.analyze',
      description: 'Analyzes an image from a URL, base64 string, or local file path and returns a text description of its contents.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Image source: an HTTP(S) URL, a data URI, a raw base64 string, or a local file path.',
          },
          prompt: {
            type: 'string',
            description: 'Text prompt describing what to analyze. Defaults to "Describe this image in detail."',
          },
          maxTokens: {
            type: 'number',
            description: 'Maximum tokens for the response. Defaults to 1024.',
          },
          providerBaseUrl: {
            type: 'string',
            description: 'Override the OpenAI-compatible API base URL.',
          },
          apiKey: {
            type: 'string',
            description: 'Override the API key for this request.',
          },
          model: {
            type: 'string',
            description: 'Override the model name (default: gpt-4o).',
          },
        },
        required: ['url'],
      },
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const imageSource = typeof input.url === 'string' ? input.url : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : 'Describe this image in detail.';
      const maxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : 1024;

      if (!imageSource) {
        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: false,
          output: 'Missing image URL. Provide "url" parameter (URL, base64, or file path).'
        };
      }

      if (/^https?:\/\//i.test(imageSource)) {
        const urlCheck = await safeImageUrlPreflight(imageSource);
        if (!urlCheck.safe) {
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: false,
            output: `URL blocked: ${urlCheck.reason ?? 'unsafe image URL'}`,
            metadata: { imageSource }
          };
        }
      }

      // Resolve image source to a usable URL
      let resolvedUrl: string;
      try {
        resolvedUrl = await resolveImageUrl(imageSource);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: false,
          output: `Failed to resolve image source: ${message}`,
          metadata: { imageSource }
        };
      }

      const providers = normalizeVisionProviders(input, options);
      if (providers.length > 0) {
        const errors: string[] = [];
        for (const provider of providers) {
          try {
            const result = await callVisionProvider(provider, resolvedUrl, prompt, maxTokens, context.signal);
            const model = result.metadata.model;
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: true,
                output: result.analysis,
                metadata: { imageSource, prompt, attemptedProviders: providers.map((entry) => entry.provider), ...result.metadata, model }
          };
          } catch (error: unknown) {
            errors.push(`${provider.provider}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (providers.length === 1) {
          const detail = errors[0]?.replace(/^[^:]+:\s*/, '') ?? 'unknown error';
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: false,
            output: detail.startsWith('HTTP ')
              ? `Vision API request failed: ${detail.slice('HTTP '.length)}`
              : `Vision analysis failed: ${detail}`,
            metadata: { imageSource, attemptedProviders: providers.map((entry) => entry.provider), errors }
          };
        }
        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: false,
          output: `Vision analysis failed: ${errors.join('; ')}`,
          metadata: { imageSource, attemptedProviders: providers.map((entry) => entry.provider), errors }
        };
      }

      return {
        toolName: 'vision.analyze',
        runtime: 'worker',
        ok: false,
        output: 'Vision analysis requires OPENAI_API_KEY or GOOGLE_API_KEY.',
        metadata: { imageSource: imageSource.slice(0, 100), provider: 'none' }
      };
    }
  };
}

export { resolveImageUrl };

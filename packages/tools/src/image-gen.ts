import type { ToolDefinition, ToolExecutionResult } from '@crowclaw/core';

export interface ImageGenerationOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultSize?: string;
  provider?: 'openai' | 'gemini' | 'replicate';
  fallbackProviders?: ImageProviderConfig[];
}

export interface ImageProviderConfig {
  provider: 'openai' | 'gemini' | 'replicate';
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
}

function normalizeImageProviders(input: Record<string, unknown>, options?: ImageGenerationOptions): ImageProviderConfig[] {
  const fromInput = Array.isArray(input.providers)
    ? input.providers
        .map((entry): ImageProviderConfig | null => {
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
        .filter((provider): provider is ImageProviderConfig => provider !== null)
    : [];
  if (fromInput.length > 0) return fromInput;

  const primaryKey = (typeof input.apiKey === 'string' ? input.apiKey : undefined) ?? options?.apiKey;
  const providers: ImageProviderConfig[] = [];
  if (primaryKey) {
    providers.push({
      provider: options?.provider ?? 'openai',
      apiKey: primaryKey,
      providerBaseUrl: (typeof input.providerBaseUrl === 'string' ? input.providerBaseUrl : undefined) ?? options?.providerBaseUrl,
      model: (typeof input.model === 'string' ? input.model : undefined) ?? options?.model,
    });
  }
  providers.push(...(options?.fallbackProviders ?? []));
  return providers;
}

async function callImageProvider(
  provider: ImageProviderConfig,
  input: { prompt: string; size: string; quality: string; n: number },
  signal?: AbortSignal
): Promise<{ urls: string[]; revisedPrompt?: string; metadata: Record<string, unknown> }> {
  if (!provider.apiKey) throw new Error('missing apiKey');

  if (provider.provider === 'replicate') {
    const model = provider.model ?? 'black-forest-labs/flux-schnell';
    const baseUrl = provider.providerBaseUrl ?? 'https://api.replicate.com/v1';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Token ${provider.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: model, input: { prompt: input.prompt, aspect_ratio: input.size } }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { output?: string | string[]; urls?: { get?: string } };
    const urls = Array.isArray(payload.output) ? payload.output : payload.output ? [payload.output] : payload.urls?.get ? [payload.urls.get] : [];
    return { urls, metadata: { provider: 'replicate', model, predictionUrl: payload.urls?.get } };
  }

  if (provider.provider === 'gemini') {
    const model = provider.model ?? 'gemini-2.0-flash-preview-image-generation';
    const baseUrl = provider.providerBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> } }> };
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const urls = parts
      .map((part) => part.inlineData?.data ? `data:${part.inlineData.mimeType ?? 'image/png'};base64,${part.inlineData.data}` : null)
      .filter((url): url is string => Boolean(url));
    const revisedPrompt = parts.map((part) => part.text ?? '').join('').trim() || undefined;
    return { urls, revisedPrompt, metadata: { provider: 'gemini', model } };
  }

  const model = provider.model ?? 'dall-e-3';
  const baseUrl = provider.providerBaseUrl ?? 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      n: input.n,
      response_format: 'url'
    }),
    signal
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { data?: Array<{ url?: string; revised_prompt?: string }> };
  const images = payload.data ?? [];
  return {
    urls: images.map((img) => img.url).filter((url): url is string => Boolean(url)),
    revisedPrompt: images[0]?.revised_prompt,
    metadata: { provider: 'openai', model },
  };
}

export function createImageGenerateTool(options?: ImageGenerationOptions): ToolDefinition {
  return {
    manifest: {
      name: 'image.generate',
      description: 'Generates an image from a text prompt using a DALL-E or compatible image generation API.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Text description of the image to generate.',
          },
          size: {
            type: 'string',
            description: 'Image dimensions (e.g., "1024x1024", "1792x1024"). Defaults to "1024x1024".',
          },
          quality: {
            type: 'string',
            description: 'Image quality: "standard" or "hd". Defaults to "standard".',
            enum: ['standard', 'hd'],
          },
          n: {
            type: 'number',
            description: 'Number of images to generate. Defaults to 1.',
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
            description: 'Override the model name (default: dall-e-3).',
          },
        },
        required: ['prompt'],
      },
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const size = typeof input.size === 'string' ? input.size : (options?.defaultSize ?? '1024x1024');
      const quality = typeof input.quality === 'string' ? input.quality : 'standard';
      const n = typeof input.n === 'number' ? input.n : 1;

      if (!prompt) {
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: false,
          output: 'Missing prompt. Provide a "prompt" parameter describing the image to generate.'
        };
      }

      const providers = normalizeImageProviders(input, options);
      if (providers.length === 0) {
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: false,
          output: `Image generation requires an API key. Prompt: "${prompt}"\nConfigure an image generation API key to enable this feature.`,
          metadata: { prompt, size, quality, simulated: true }
        };
      }

      const errors: string[] = [];
      for (const provider of providers) {
        try {
          const result = await callImageProvider(provider, { prompt, size, quality, n }, context.signal);
          const model = result.metadata.model;
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
              urls: result.urls,
              revisedPrompt: result.revisedPrompt,
            prompt,
            model,
            size,
            quality,
              count: result.urls.length
          }, null, 2),
            metadata: { prompt, model, size, quality, count: result.urls.length, revisedPrompt: result.revisedPrompt, attemptedProviders: providers.map((entry) => entry.provider), ...result.metadata }
        };
        } catch (error: unknown) {
          errors.push(`${provider.provider}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (providers.length === 1) {
        const detail = errors[0]?.replace(/^[^:]+:\s*/, '') ?? 'unknown error';
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: false,
          output: detail.startsWith('HTTP ')
            ? `Image generation failed: ${detail.slice('HTTP '.length)}`
            : `Image generation failed: ${detail}`,
          metadata: { prompt, size, quality, attemptedProviders: providers.map((entry) => entry.provider), errors }
        };
      }
      return {
        toolName: 'image.generate',
        runtime: 'worker',
        ok: false,
        output: `Image generation failed: ${errors.join('; ')}`,
        metadata: { prompt, size, quality, attemptedProviders: providers.map((entry) => entry.provider), errors }
      };
    }
  };
}

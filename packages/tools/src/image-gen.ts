import type { ToolDefinition, ToolExecutionResult } from '@crowclaw/core';

export interface ImageGenerationOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultSize?: string;
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

      const apiKey = (typeof input.apiKey === 'string' ? input.apiKey : undefined) ?? options?.apiKey;
      const baseUrl = (typeof input.providerBaseUrl === 'string' ? input.providerBaseUrl : undefined) ?? options?.providerBaseUrl ?? 'https://api.openai.com/v1';
      const model = (typeof input.model === 'string' ? input.model : undefined) ?? options?.model ?? 'dall-e-3';

      if (!apiKey) {
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: false,
          output: `Image generation requires an API key. Prompt: "${prompt}"\nConfigure an image generation API key to enable this feature.`,
          metadata: { prompt, size, quality, simulated: true }
        };
      }

      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model,
            prompt,
            size,
            quality,
            n,
            response_format: 'url'
          }),
          signal: context.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          return {
            toolName: 'image.generate',
            runtime: 'worker',
            ok: false,
            output: `Image generation failed: ${response.status} ${response.statusText}\n${errorText}`,
            metadata: { prompt, size, model, status: response.status }
          };
        }

        const payload = await response.json() as {
          data?: Array<{ url?: string; revised_prompt?: string }>;
        };
        const images = payload.data ?? [];
        const urls = images.map(img => img.url).filter(Boolean);
        const revisedPrompt = images[0]?.revised_prompt;

        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
            urls,
            revisedPrompt,
            prompt,
            model,
            size,
            quality,
            count: urls.length
          }, null, 2),
          metadata: { prompt, model, size, quality, count: urls.length, revisedPrompt }
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'image.generate',
          runtime: 'worker',
          ok: false,
          output: `Image generation failed: ${message}`,
          metadata: { prompt, model }
        };
      }
    }
  };
}

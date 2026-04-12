import type { ToolDefinition, ToolExecutionResult } from '@crowclaw/core';

export interface VisionAnalysisOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
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

      const apiKey = (typeof input.apiKey === 'string' ? input.apiKey : undefined) ?? options?.apiKey;
      const baseUrl = (typeof input.providerBaseUrl === 'string' ? input.providerBaseUrl : undefined) ?? options?.providerBaseUrl ?? 'https://api.openai.com/v1';
      const model = (typeof input.model === 'string' ? input.model : undefined) ?? options?.model ?? 'gpt-4o';

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

      if (apiKey) {
        try {
          const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
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
            signal: context.signal
          });

          if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            return {
              toolName: 'vision.analyze',
              runtime: 'worker',
              ok: false,
              output: `Vision API request failed: ${response.status} ${response.statusText}${errorBody ? `\n${errorBody}` : ''}`,
              metadata: { imageSource, status: response.status }
            };
          }

          const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          const analysis = payload.choices?.[0]?.message?.content ?? 'No analysis returned.';

          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: true,
            output: analysis,
            metadata: { imageSource, model, prompt }
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: false,
            output: `Vision analysis failed: ${message}`,
            metadata: { imageSource }
          };
        }
      }

      // Fallback: fetch image metadata without vision API (only for HTTP URLs)
      if (/^https?:\/\//i.test(resolvedUrl)) {
        try {
          const response = await fetch(resolvedUrl, { method: 'HEAD', signal: context.signal });
          const contentType = response.headers.get('content-type') ?? 'unknown';
          const contentLength = response.headers.get('content-length');

          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: true,
            output: `Image metadata for ${imageSource}:\n- Content-Type: ${contentType}\n- Size: ${contentLength ? `${Math.round(parseInt(contentLength) / 1024)}KB` : 'unknown'}\n\nNote: Full vision analysis requires a vision-capable API key to be configured.`,
            metadata: { imageSource, contentType, contentLength, simulated: true }
          };
        } catch {
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: false,
            output: `Could not access image at ${imageSource}. Verify the URL is accessible.`,
            metadata: { imageSource, simulated: true }
          };
        }
      }

      return {
        toolName: 'vision.analyze',
        runtime: 'worker',
        ok: true,
        output: `Image loaded from local source (${imageSource.length > 50 ? imageSource.slice(0, 50) + '...' : imageSource}).\n\nNote: Full vision analysis requires a vision-capable API key to be configured.`,
        metadata: { imageSource: imageSource.slice(0, 100), simulated: true }
      };
    }
  };
}

export { resolveImageUrl };

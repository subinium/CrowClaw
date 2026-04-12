import type { ToolDefinition, ToolExecutionResult } from '@crowclaw/core';

export interface VisionAnalysisOptions {
  providerBaseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function createVisionAnalyzeTool(options?: VisionAnalysisOptions): ToolDefinition {
  return {
    manifest: {
      name: 'vision.analyze',
      description: 'Analyzes an image from a URL and returns a text description of its contents.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const imageUrl = typeof input.url === 'string' ? input.url : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : 'Describe this image in detail.';
      const maxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : 1024;

      if (!imageUrl) {
        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: false,
          output: 'Missing image URL. Provide "url" parameter.'
        };
      }

      const apiKey = options?.apiKey;
      const baseUrl = options?.providerBaseUrl ?? 'https://api.openai.com/v1';
      const model = options?.model ?? 'gpt-4o';

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
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: imageUrl } }
                ]
              }]
            }),
            signal: context.signal
          });

          if (!response.ok) {
            return {
              toolName: 'vision.analyze',
              runtime: 'worker',
              ok: false,
              output: `Vision API request failed: ${response.status} ${response.statusText}`,
              metadata: { imageUrl, status: response.status }
            };
          }

          const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          const analysis = payload.choices?.[0]?.message?.content ?? 'No analysis returned.';

          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: true,
            output: analysis,
            metadata: { imageUrl, model, prompt }
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            toolName: 'vision.analyze',
            runtime: 'worker',
            ok: false,
            output: `Vision analysis failed: ${message}`,
            metadata: { imageUrl }
          };
        }
      }

      // Fallback: fetch image metadata without vision API
      try {
        const response = await fetch(imageUrl, { method: 'HEAD', signal: context.signal });
        const contentType = response.headers.get('content-type') ?? 'unknown';
        const contentLength = response.headers.get('content-length');

        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: true,
          output: `Image metadata for ${imageUrl}:\n- Content-Type: ${contentType}\n- Size: ${contentLength ? `${Math.round(parseInt(contentLength) / 1024)}KB` : 'unknown'}\n\nNote: Full vision analysis requires a vision-capable API key to be configured.`,
          metadata: { imageUrl, contentType, contentLength, simulated: true }
        };
      } catch {
        return {
          toolName: 'vision.analyze',
          runtime: 'worker',
          ok: false,
          output: `Could not access image at ${imageUrl}. Verify the URL is accessible.`,
          metadata: { imageUrl, simulated: true }
        };
      }
    }
  };
}

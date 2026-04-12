import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVisionAnalyzeTool, type VisionAnalysisOptions } from '../packages/tools/src/vision.js';
import { createImageGenerateTool, type ImageGenerationOptions } from '../packages/tools/src/image-gen.js';
import type { ToolExecutionContext } from '../packages/core/src/index.js';

function makeContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    agentId: 'test-agent',
    sessionId: 'test-session',
    signal: undefined as unknown as AbortSignal,
    ...overrides,
  };
}

describe('vision.analyze tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds correct multimodal message format with image_url + text', async () => {
    let capturedBody: string | undefined;

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'A beautiful landscape with mountains.' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    await tool.execute({ url: 'https://example.com/photo.jpg', prompt: 'Describe the scene' }, makeContext());

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].role).toBe('user');
    expect(parsed.messages[0].content).toHaveLength(2);

    // image_url comes first, then text
    const imageContent = parsed.messages[0].content[0];
    const textContent = parsed.messages[0].content[1];
    expect(imageContent.type).toBe('image_url');
    expect(imageContent.image_url.url).toBe('https://example.com/photo.jpg');
    expect(textContent.type).toBe('text');
    expect(textContent.text).toBe('Describe the scene');
  });

  it('handles URL images directly', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'URL image analysis' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    const result = await tool.execute({ url: 'https://images.example.com/cat.png' }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('URL image analysis');

    // Verify the URL was passed through directly
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content[0].image_url.url).toBe('https://images.example.com/cat.png');
  });

  it('handles base64 images by wrapping in data URI', async () => {
    // Create a long enough base64 string to pass the detection heuristic
    const fakeBase64 = 'A'.repeat(200);

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Base64 image analysis' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    const result = await tool.execute({ url: fakeBase64 }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('Base64 image analysis');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content[0].image_url.url).toBe(`data:image/png;base64,${fakeBase64}`);
  });

  it('handles file path by reading and base64 encoding (mock fs)', async () => {
    // Mock node:fs to simulate file reading
    const fakeBuffer = Buffer.from('fake-png-data');
    vi.doMock('node:fs', () => ({
      promises: {
        readFile: vi.fn(async () => fakeBuffer),
      },
    }));

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'File image analysis' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Re-import to get the mocked fs
    const { resolveImageUrl } = await import('../packages/tools/src/vision.js');
    const resolved = await resolveImageUrl('/path/to/image.png');

    expect(resolved).toContain('data:image/png;base64,');
    expect(resolved).toContain(fakeBuffer.toString('base64'));

    vi.doUnmock('node:fs');
  });

  it('returns API response text on success', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'The image shows a crowclaw agent logo with dark background.' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key', model: 'gpt-4o-mini' });
    const result = await tool.execute({ url: 'https://example.com/logo.png', prompt: 'What is in this image?' }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.output).toBe('The image shows a crowclaw agent logo with dark background.');
    expect(result.metadata).toMatchObject({ model: 'gpt-4o-mini', prompt: 'What is in this image?' });
  });

  it('handles API error gracefully without throwing', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    const result = await tool.execute({ url: 'https://example.com/image.png' }, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Vision API request failed: 429');
    expect(result.toolName).toBe('vision.analyze');
  });

  it('handles network error gracefully without throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Network connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    const result = await tool.execute({ url: 'https://example.com/image.png' }, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Vision analysis failed: Network connection refused');
  });

  it('falls back to metadata when no API key is provided', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': '51200'
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool(); // no apiKey
    const result = await tool.execute({ url: 'https://example.com/image.jpg' }, makeContext());

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Image metadata');
    expect(result.output).toContain('Content-Type: image/jpeg');
    expect(result.metadata).toMatchObject({ simulated: true });
  });

  it('returns error when url parameter is missing', async () => {
    const tool = createVisionAnalyzeTool({ apiKey: 'test-key' });
    const result = await tool.execute({}, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing image URL');
  });

  it('supports per-request apiKey and providerBaseUrl overrides', async () => {
    let calledUrl = '';
    let calledAuth = '';
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Override test' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createVisionAnalyzeTool({ apiKey: 'default-key', providerBaseUrl: 'https://default.api.com/v1' });
    await tool.execute({
      url: 'https://example.com/img.png',
      apiKey: 'override-key',
      providerBaseUrl: 'https://custom.api.com/v1',
    }, makeContext());

    expect(calledUrl).toContain('custom.api.com');
    expect(calledAuth).toBe('Bearer override-key');
  });

  it('includes inputSchema in the manifest', () => {
    const tool = createVisionAnalyzeTool();
    expect(tool.manifest.inputSchema).toBeDefined();
    expect(tool.manifest.inputSchema!.type).toBe('object');
    expect((tool.manifest.inputSchema!.properties as Record<string, unknown>)['url']).toBeDefined();
    expect((tool.manifest.inputSchema!.required as string[])).toContain('url');
  });
});

describe('image.generate tool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds correct DALL-E request', async () => {
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example.com/generated.png', revised_prompt: 'A pixel art logo' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createImageGenerateTool({ apiKey: 'test-key' });
    await tool.execute({ prompt: 'a crowclaw logo in pixel art', size: '512x512', quality: 'hd' }, makeContext());

    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toBe('dall-e-3');
    expect(parsed.prompt).toBe('a crowclaw logo in pixel art');
    expect(parsed.size).toBe('512x512');
    expect(parsed.quality).toBe('hd');
    expect(parsed.response_format).toBe('url');
    expect(parsed.n).toBe(1);

    // Verify endpoint
    expect(String(fetchMock.mock.calls[0][0])).toContain('/images/generations');
  });

  it('returns image URL from response', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        data: [
          { url: 'https://cdn.example.com/img1.png', revised_prompt: 'A revised prompt' },
          { url: 'https://cdn.example.com/img2.png' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createImageGenerateTool({ apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'generate a logo', n: 2 }, makeContext());

    expect(result.ok).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.urls).toEqual(['https://cdn.example.com/img1.png', 'https://cdn.example.com/img2.png']);
    expect(output.revisedPrompt).toBe('A revised prompt');
    expect(output.count).toBe(2);
  });

  it('returns error when no API key is provided', async () => {
    const tool = createImageGenerateTool(); // no apiKey
    const result = await tool.execute({ prompt: 'a logo' }, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('requires an API key');
  });

  it('handles API error gracefully', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"error": {"message": "Content policy violation"}}', {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createImageGenerateTool({ apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'something bad' }, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Image generation failed: 400');
  });

  it('handles network error gracefully', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('DNS resolution failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createImageGenerateTool({ apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'a logo' }, makeContext());

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Image generation failed: DNS resolution failed');
  });

  it('supports per-request apiKey and model overrides', async () => {
    let calledUrl = '';
    let calledBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        data: [{ url: 'https://cdn.example.com/override.png' }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tool = createImageGenerateTool({ apiKey: 'default-key', model: 'dall-e-2' });
    await tool.execute({
      prompt: 'a logo',
      apiKey: 'override-key',
      model: 'dall-e-3',
      providerBaseUrl: 'https://custom-api.example.com/v1',
    }, makeContext());

    expect(calledUrl).toContain('custom-api.example.com');
    expect(calledBody.model).toBe('dall-e-3');
  });

  it('includes inputSchema in the manifest', () => {
    const tool = createImageGenerateTool();
    expect(tool.manifest.inputSchema).toBeDefined();
    expect(tool.manifest.inputSchema!.type).toBe('object');
    expect((tool.manifest.inputSchema!.properties as Record<string, unknown>)['prompt']).toBeDefined();
    expect((tool.manifest.inputSchema!.required as string[])).toContain('prompt');
  });
});

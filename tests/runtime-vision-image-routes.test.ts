import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '../packages/runtime-cloudflare/src/index.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime vision/image routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves vision analyze and image generate through the node runtime', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Vision analysis result' } }]
        }), { status: 200 });
      }
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.com/generated.png', revised_prompt: 'revised' }]
        }), { status: 200 });
      }
      return new Response('', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1024' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createNodeRuntime();
    const vision = await runtime.fetch(new Request('http://localhost/api/vision/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/image.png', prompt: 'describe the UI' })
    }));
    expect((await vision.json() as { toolName: string }).toolName).toBe('vision.analyze');

    const image = await runtime.fetch(new Request('http://localhost/api/image/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a crowclaw logo in pixel art', style: 'pixel-art', size: '512x512' })
    }));
    expect((await image.json() as { toolName: string }).toolName).toBe('image.generate');
  });

  it('forwards top-level vision/image routes through the Cloudflare runtime', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: { idFromName: (name: string) => ({ toString: () => name }), get: () => stub },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const vision = await runtimeCloudflare.fetch(new Request('https://example.com/api/vision/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/image.png' })
    }), env as never);
    expect((await vision.json() as { forwardedTo: string }).forwardedTo).toContain('/vision/analyze');

    const image = await runtimeCloudflare.fetch(new Request('https://example.com/api/image/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a crowclaw logo' })
    }), env as never);
    expect((await image.json() as { forwardedTo: string }).forwardedTo).toContain('/image/generate');
  });
});

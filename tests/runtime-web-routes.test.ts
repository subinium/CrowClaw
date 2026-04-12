import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime web extraction routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves web metadata, links, text, search, and crawl through the node runtime', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('page')) {
        return new Response('<html><head><title>CrowClaw</title><meta name="description" content="TS port"></head><body><a href="/docs">Docs</a></body></html>', { status: 200 });
      }
      if (url.includes('duckduckgo.com')) {
        return new Response('<html><body><a href="https://example.com/search-result">Search Result</a></body></html>', { status: 200 });
      }
      return new Response('plain body', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createNodeRuntime();
    const metadata = await runtime.fetch(new Request('http://localhost/api/web/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }));
    const metadataPayload = await metadata.json() as { metadata: { title?: string } } | { output: string };
    expect(JSON.stringify(metadataPayload)).toContain('CrowClaw');

    const links = await runtime.fetch(new Request('http://localhost/api/web/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }));
    const linksPayload = await links.json() as { output: string };
    expect(linksPayload.output).toContain('/docs');

    const text = await runtime.fetch(new Request('http://localhost/api/web/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }));
    const textPayload = await text.json() as { output: string };
    expect(textPayload.output).toContain('CrowClaw');

    const search = await runtime.fetch(new Request('http://localhost/api/web/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'crowclaw', limit: 1 })
    }));
    const searchPayload = await search.json() as { output: string };
    expect(searchPayload.output).toContain('Search Result');

    const crawl = await runtime.fetch(new Request('http://localhost/api/web/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page', maxPages: 1 })
    }));
    const crawlPayload = await crawl.json() as { output: string };
    expect(crawlPayload.output).toContain('https://example.com/page');
  });

  it('forwards nested web metadata and text routes through the Cloudflare runtime', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: { idFromName: (name: string) => ({ toString: () => name }), get: () => stub },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/web/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { url: string } };
    expect(payload.forwardedTo).toContain('/web/metadata');
    expect(payload.body.url).toBe('https://example.com/page');

    const textResponse = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/web/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }), env as never);

    const textPayload = await textResponse.json() as { forwardedTo: string; body: { url: string } };
    expect(textPayload.forwardedTo).toContain('/web/text');
    expect(textPayload.body.url).toBe('https://example.com/page');
  });

  it('forwards top-level web routes through the Cloudflare runtime', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: { idFromName: (name: string) => ({ toString: () => name }), get: () => stub },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/web/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { url: string } };
    expect(payload.forwardedTo).toContain('/web/text');
    expect(payload.body.url).toBe('https://example.com/page');

    const searchResponse = await runtimeCloudflare.fetch(new Request('https://example.com/api/web/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'crowclaw' })
    }), env as never);
    const searchPayload = await searchResponse.json() as { forwardedTo: string; body: { query: string } };
    expect(searchPayload.forwardedTo).toContain('/web/search');
    expect(searchPayload.body.query).toBe('crowclaw');

    const crawlResponse = await runtimeCloudflare.fetch(new Request('https://example.com/api/web/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/page' })
    }), env as never);
    const crawlPayload = await crawlResponse.json() as { forwardedTo: string; body: { url: string } };
    expect(crawlPayload.forwardedTo).toContain('/web/crawl');
    expect(crawlPayload.body.url).toBe('https://example.com/page');
  });
});

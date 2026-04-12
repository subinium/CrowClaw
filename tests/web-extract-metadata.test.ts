import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, createWebExtractMetadataTool } from '@crowclaw/tools';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web metadata extraction tool', () => {
  it('extracts title and description from HTML documents', async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html>
        <head>
          <title>CrowClaw</title>
          <meta name="description" content="TypeScript agent framework">
        </head>
        <body>Hello</body>
      </html>
    `, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebExtractMetadataTool());
    const result = await registry.execute('web.extractMetadata', { url: 'https://example.com' }, {
      agentId: 'crowclaw',
      sessionId: 'meta-1'
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      title: 'CrowClaw',
      description: 'TypeScript agent framework'
    });
    expect(result.output).toContain('CrowClaw');
  });

  it('falls back to Open Graph and Twitter metadata when standard tags are absent', async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html>
        <head>
          <link rel="canonical" href="https://example.com/og">
          <meta property="og:title" content="OG CrowClaw">
          <meta property="og:image" content="https://example.com/preview.png">
          <meta name="twitter:description" content="Twitter CrowClaw summary">
        </head>
        <body>Hello</body>
      </html>
    `, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebExtractMetadataTool());
    const result = await registry.execute('web.extractMetadata', { url: 'https://example.com/og' }, {
      agentId: 'crowclaw',
      sessionId: 'meta-2'
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      title: 'OG CrowClaw',
      description: 'Twitter CrowClaw summary',
      canonicalUrl: 'https://example.com/og',
      image: 'https://example.com/preview.png'
    });
    expect(result.output).toContain('"canonicalUrl": "https://example.com/og"');
    expect(result.output).toContain('"image": "https://example.com/preview.png"');
  });

  it('resolves relative canonical and image URLs against the source page', async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html>
        <head>
          <link rel="canonical" href="/posts/crowclaw">
          <meta property="og:title" content="CrowClaw Post">
          <meta property="og:image" content="../images/preview.png">
        </head>
        <body>Hello</body>
      </html>
    `, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebExtractMetadataTool());
    const result = await registry.execute('web.extractMetadata', { url: 'https://example.com/blog/intro' }, {
      agentId: 'crowclaw',
      sessionId: 'meta-3'
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      canonicalUrl: 'https://example.com/posts/crowclaw',
      image: 'https://example.com/images/preview.png'
    });
  });
});

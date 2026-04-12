import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, createWebExtractLinksTool } from '@crowclaw/tools';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web link extraction tool', () => {
  it('extracts href links from HTML documents', async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html>
        <body>
          <a href="https://example.com/a">A</a>
          <a href="/relative">B</a>
          <a href="/relative">B2</a>
          <a href="../parent">C</a>
          <a href="#section">Fragment</a>
          <a href="javascript:void(0)">JS</a>
          <a href="mailto:test@example.com">Mail</a>
          <a href="https://example.com/a#hash">A with hash</a>
        </body>
      </html>
    `, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebExtractLinksTool());
    const result = await registry.execute('web.extractLinks', { url: 'https://example.com/base/page' }, {
      agentId: 'crowclaw',
      sessionId: 'links-1'
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ count: 3, url: 'https://example.com/base/page' });
    expect(result.output).toContain('https://example.com/a');
    expect(result.output).toContain('https://example.com/relative');
    expect(result.output).toContain('https://example.com/parent');
    expect(result.output).not.toContain('javascript:');
    expect(result.output).not.toContain('mailto:');
    expect(result.output).not.toContain('#section');
  });
});

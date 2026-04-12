import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ToolRegistry,
  createWebCrawlTool,
  createWebExtractLinksTool,
  createWebExtractMetadataTool,
  createWebExtractTextTool,
  createWebFetchTool,
  createWebSearchTool
} from '@crowclaw/tools';

const cases = [
  { name: 'web.fetch', register: () => new ToolRegistry().register(createWebFetchTool()), input: { url: 'http://localhost/admin' } },
  { name: 'web.extractMetadata', register: () => new ToolRegistry().register(createWebExtractMetadataTool()), input: { url: 'http://127.0.0.1/meta' } },
  { name: 'web.extractLinks', register: () => new ToolRegistry().register(createWebExtractLinksTool()), input: { url: 'http://192.168.1.1/links' } },
  { name: 'web.extractText', register: () => new ToolRegistry().register(createWebExtractTextTool()), input: { url: 'http://10.0.0.4/text' } },
  { name: 'web.search', register: () => new ToolRegistry().register(createWebSearchTool()), input: { query: 'crowclaw', providerBaseUrl: 'http://localhost/search' } },
  { name: 'web.crawl', register: () => new ToolRegistry().register(createWebCrawlTool()), input: { url: 'http://localhost/crawl' } }
];

describe('web tool SSRF guard wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const testCase of cases) {
    it(`${testCase.name} blocks private URLs before calling fetch`, async () => {
      const fetchMock = vi.fn(async () => new Response('unexpected'));
      vi.stubGlobal('fetch', fetchMock);

      const registry = testCase.register();
      const result = await registry.execute(testCase.name, testCase.input, {
        agentId: 'crowclaw',
        sessionId: `${testCase.name}-ssrf`
      });

      expect(result.ok).toBe(false);
      expect(result.output).toContain('URL blocked');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

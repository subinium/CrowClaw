import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capability badges', () => {
  describe('GET /api/capabilities returns correct shape', () => {
    it('returns all expected capability keys with status and optional detail', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      const expectedKeys = [
        'provider',
        'chat',
        'streaming',
        'tools',
        'memory',
        'skills',
        'scheduler',
        'gateway',
        'mcp',
        'browser',
        'workspace',
      ];
      for (const key of expectedKeys) {
        expect(data).toHaveProperty(key);
        expect(data[key]).toHaveProperty('status');
        expect(['live', 'simulated', 'disconnected', 'experimental']).toContain(
          data[key].status
        );
      }
    });

    it('reports provider as simulated when using EchoProvider (default)', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      // Default runtime uses EchoProvider — should be simulated
      expect(data.provider.status).toBe('simulated');
      expect(data.chat.status).toBe('simulated');
    });

    it('reports workspace as live with file-backed detail', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      expect(data.workspace.status).toBe('live');
      expect(data.workspace.detail).toContain('File-backed');
    });

    it('reports gateway as disconnected when no tokens are configured', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      expect(data.gateway.status).toBe('disconnected');
    });

    it('reports streaming as live', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      expect(data.streaming.status).toBe('live');
    });

    it('reports tools as live with registered count', async () => {
      const runtime = createNodeRuntime();
      const res = await runtime.fetch(
        new Request('http://localhost/api/capabilities')
      );
      const data = (await res.json()) as Record<
        string,
        { status: string; detail?: string }
      >;

      expect(data.tools.status).toBe('live');
      expect(data.tools.detail).toMatch(/\d+ registered/);
    });
  });

  describe('dashboard HTML contains Lit badge components', () => {
    it('includes badge-related text in the Lit output', () => {
      expect(DASHBOARD_HTML).toContain('badge');
    });

    it('includes live status indicator', () => {
      expect(DASHBOARD_HTML).toContain('live');
    });

    it('includes simulated status indicator', () => {
      expect(DASHBOARD_HTML).toContain('simulated');
    });

    it('includes disconnected status indicator', () => {
      expect(DASHBOARD_HTML).toContain('disconnected');
    });

    it('includes crowclaw-sidebar component which holds badges', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-sidebar');
    });

    it('includes crowclaw-agent-view for capability details', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-agent-view');
    });
  });

  describe('dashboard references capabilities in Lit components', () => {
    it('dashboard HTML includes crowclaw-sidebar for nav badges', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-sidebar');
    });

    it('crowclaw-agent-view handles capability display', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-agent-view');
    });

    it('fetches system status which includes capability data', () => {
      expect(DASHBOARD_HTML).toContain('/api/system/status');
    });
  });

  describe('badge data accessible via Lit components', () => {
    it('has sidebar component for nav badges', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-sidebar');
    });

    it('has agent view for capability details', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-agent-view');
    });
  });

  describe('branding: no Mercury references in config files', () => {
    it('.env.example has no Mercury references', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const envContent = await readFile(
        join(process.cwd(), '.env.example'),
        'utf-8'
      );
      expect(envContent.toLowerCase()).not.toContain('mercury');
      expect(envContent).toContain('CROWCLAW');
    });

    it('Dockerfile has correct startup command', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dockerContent = await readFile(
        join(process.cwd(), 'Dockerfile'),
        'utf-8'
      );
      expect(dockerContent).toContain('scripts/docker-serve.mjs');
      expect(dockerContent).not.toContain('packages/runtime-node/dist/index.js');
      expect(dockerContent).toContain('npm run build -- --force');
      expect(dockerContent).toContain('EXPOSE 8787');
      expect(dockerContent).toContain('CrowClaw HTTP server');
    });

    it('.dockerignore excludes TypeScript build cache from image builds', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dockerIgnoreContent = await readFile(
        join(process.cwd(), '.dockerignore'),
        'utf-8'
      );
      expect(dockerIgnoreContent).toContain('**/*.tsbuildinfo');
    });

    it('wrangler.jsonc uses crowclaw branding', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const wranglerContent = await readFile(
        join(process.cwd(), 'wrangler.jsonc'),
        'utf-8'
      );
      expect(wranglerContent.toLowerCase()).not.toContain('"mercury"');
      expect(wranglerContent).toContain('"crowclaw"');
    });
  });
});

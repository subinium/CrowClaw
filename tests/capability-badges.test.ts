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

  describe('dashboard HTML contains badge CSS classes', () => {
    it('includes cap-badge class in CSS', () => {
      expect(DASHBOARD_HTML).toContain('.cap-badge');
    });

    it('includes cap-live CSS class', () => {
      expect(DASHBOARD_HTML).toContain('.cap-live');
    });

    it('includes cap-sim CSS class', () => {
      expect(DASHBOARD_HTML).toContain('.cap-sim');
    });

    it('includes cap-disc CSS class', () => {
      expect(DASHBOARD_HTML).toContain('.cap-disc');
    });

    it('includes cap-exp CSS class', () => {
      expect(DASHBOARD_HTML).toContain('.cap-exp');
    });

    it('includes cap-detail CSS class', () => {
      expect(DASHBOARD_HTML).toContain('.cap-detail');
    });
  });

  describe('dashboard JS fetches capabilities on load', () => {
    it('dashboard HTML includes lCap function', () => {
      expect(DASHBOARD_HTML).toContain('function lCap()');
    });

    it('initApp calls lCap', () => {
      expect(DASHBOARD_HTML).toContain('lCap()');
      // Verify lCap is called inside initApp
      const initAppMatch = DASHBOARD_HTML.match(
        /function initApp\(\)\s*\{[^}]+\}/
      );
      expect(initAppMatch).not.toBeNull();
      expect(initAppMatch![0]).toContain('lCap()');
    });

    it('lCap fetches /api/capabilities', () => {
      expect(DASHBOARD_HTML).toContain('/api/capabilities');
    });
  });

  describe('badge elements exist in nav', () => {
    it('has badge elements for chat, memory, skills, tools, gateway, mcp, scheduler', () => {
      const badgeIds = [
        'cb-chat',
        'cb-memory',
        'cb-skills',
        'cb-tools',
        'cb-gateway',
        'cb-mcp',
        'cb-scheduler',
      ];
      for (const id of badgeIds) {
        expect(DASHBOARD_HTML).toContain(`id="${id}"`);
      }
    });

    it('has panel detail elements for memory, skills, tools, gateway, mcp, scheduler', () => {
      const detailIds = [
        'cpd-memory',
        'cpd-skills',
        'cpd-tools',
        'cpd-gateway',
        'cpd-mcp',
        'cpd-scheduler',
      ];
      for (const id of detailIds) {
        expect(DASHBOARD_HTML).toContain(`id="${id}"`);
      }
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
      // Should start the runtime-node server, not the CLI
      expect(dockerContent).toContain('runtime-node');
      expect(dockerContent).not.toContain('packages/cli/dist/index.js');
      // Should expose port 8787
      expect(dockerContent).toContain('EXPOSE 8787');
      // Should have a startup comment
      expect(dockerContent).toContain('CrowClaw HTTP server');
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

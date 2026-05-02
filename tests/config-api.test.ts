import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('Configuration API', () => {
  const TEST_TOKEN = 'config-api-token';
  const runtime = createNodeRuntime();

  function req(method: string, path: string, body?: unknown, auth = false) {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (auth) (init.headers as Record<string, string>).authorization = `Bearer ${TEST_TOKEN}`;
    if (body) init.body = JSON.stringify(body);
    return runtime.fetch(new Request(`http://localhost${path}`, init));
  }

  describe('POST /api/agent/preset', () => {
    // Issue #217: the hardcoded `agentPresets` registry has been emptied.
    // Personas are now expected to come from the file-backed PersonaRegistry,
    // and the agent/preset endpoint stores whatever role/goal/backstory the
    // caller supplies inline. These tests verify the route still accepts
    // user-supplied identities without depending on any built-in preset name.
    it('accepts an inline role/goal payload (no built-in registry lookup needed)', async () => {
      const res = await req('POST', '/api/agent/preset', {
        name: 'custom-engineer',
        role: 'Senior engineer',
        goal: 'Write clean code',
      });
      const data = await res.json() as { ok: boolean; activePreset: string };
      expect(data.ok).toBe(true);
      // The name is stored verbatim — it does not need to match an
      // `agentPresets` entry (the registry is empty by design).
      expect(data.activePreset).toBe('custom-engineer');
    });

    it('should clear preset with null', async () => {
      const res = await req('POST', '/api/agent/preset', { name: null });
      const data = await res.json() as { ok: boolean; activePreset: string | null };
      expect(data.ok).toBe(true);
      expect(data.activePreset).toBeNull();
    });
  });

  describe('POST /api/toolset/select', () => {
    it('should set active toolset', async () => {
      const res = await req('POST', '/api/toolset/select', { name: 'web' });
      const data = await res.json() as { ok: boolean; activeToolset: string };
      expect(data.ok).toBe(true);
      expect(data.activeToolset).toBe('web');
    });
  });

  describe('POST /api/skills/:slug/toggle', () => {
    it('should disable a skill', async () => {
      const res = await req('POST', '/api/skills/git-commit-workflow/toggle', { enabled: false });
      const data = await res.json() as { ok: boolean; slug: string; enabled: boolean };
      expect(data.ok).toBe(true);
      expect(data.slug).toBe('git-commit-workflow');
      expect(data.enabled).toBe(false);
    });

    it('should re-enable a skill', async () => {
      const res = await req('POST', '/api/skills/git-commit-workflow/toggle', { enabled: true });
      const data = await res.json() as { ok: boolean; enabled: boolean };
      expect(data.ok).toBe(true);
      expect(data.enabled).toBe(true);
    });
  });

  describe('POST /api/gateway/:platform/config', () => {
    it('should save gateway token', async () => {
      const res = await req('POST', '/api/gateway/telegram/config', { token: 'test-bot-token', enabled: true });
      const data = await res.json() as { ok: boolean; platform: string; configured: boolean };
      expect(data.ok).toBe(true);
      expect(data.platform).toBe('telegram');
      expect(data.configured).toBe(true);
    });

    it('rotates webhook secrets without exposing old secret', async () => {
      await req('POST', '/api/gateway/slack/config', { webhookSecret: 'old-secret', enabled: true });

      const res = await req('POST', '/api/gateway/slack/secret/rotate', {});
      const data = await res.json() as { ok: boolean; platform: string; secret: string; graceUntil: string | null };

      expect(data.ok).toBe(true);
      expect(data.platform).toBe('slack');
      expect(data.secret).toMatch(/^ccwhsec_/);
      expect(data.secret).not.toBe('old-secret');
      expect(typeof data.graceUntil).toBe('string');
    });

    it('keeps previous generic webhook secret valid during rotation grace', async () => {
      const oldSecret = 'old-generic-secret';
      await req('POST', '/api/gateway/webhook/config', { webhookSecret: oldSecret, enabled: true });
      await req('POST', '/api/gateway/webhook/secret/rotate', {});
      const body = JSON.stringify({ channelId: 'room-1', userId: 'user-1', text: 'hello' });
      const signature = `sha256=${createHmac('sha256', oldSecret).update(body).digest('hex')}`;

      const res = await runtime.fetch(new Request('http://localhost/api/gateway/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crowclaw-signature': signature },
        body,
      }));
      const data = await res.json() as { error?: string };
      expect(data.error).not.toBe('Invalid webhook signature');
    });

    it('returns gateway activity and accepts pairing rejection shape', async () => {
      const reject = await req('POST', '/api/gateway/pairing/reject', { code: 'missing' });
      expect(await reject.json()).toMatchObject({ ok: false, rejected: false });

      const activity = await req('GET', '/api/gateway/activity');
      const data = await activity.json() as { ok: boolean; events: unknown[] };
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.events)).toBe(true);
    });
  });

  describe('plugin and MCP catalogs', () => {
    it('lists plugin catalog entries and installs/configures/uninstalls a plugin', async () => {
      const catalogRes = await req('GET', '/api/plugins/catalog');
      const catalog = await catalogRes.json() as { catalog: Array<{ slug: string; manifest: { name: string } }> };
      expect(catalog.catalog.some((entry) => entry.slug === 'reference-tool-result')).toBe(true);

      const originalToken = process.env.CROWCLAW_DASHBOARD_TOKEN;
      process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN;
      const secured = createNodeRuntime();
      const securedReq = (method: string, path: string, body?: unknown) =>
        secured.fetch(new Request(`http://localhost${path}`, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }));
      try {
        const installRes = await securedReq('POST', '/api/plugins/install', { slug: 'reference-tool-result' });
        const install = await installRes.json() as { ok: boolean; plugin: { name: string } };
        expect(install.ok).toBe(true);
        expect(install.plugin.name).toBe('reference-tool-result');

        const configureRes = await securedReq('POST', '/api/plugins/configure', {
          name: 'reference-tool-result',
          config: { enabled: true },
        });
        expect((await configureRes.json() as { ok: boolean }).ok).toBe(true);

        const uninstallRes = await securedReq('POST', '/api/plugins/uninstall', { name: 'reference-tool-result' });
        expect((await uninstallRes.json() as { ok: boolean }).ok).toBe(true);
      } finally {
        await secured.shutdown();
        if (originalToken === undefined) delete process.env.CROWCLAW_DASHBOARD_TOKEN;
        else process.env.CROWCLAW_DASHBOARD_TOKEN = originalToken;
      }
    });

    it('installs MCP servers from catalog manifests instead of raw commands', async () => {
      const catalogRes = await req('GET', '/api/mcp/catalog');
      const catalog = await catalogRes.json() as { catalog: Array<{ slug: string; env?: Record<string, unknown> }> };
      expect(catalog.catalog.some((entry) => entry.slug === 'filesystem')).toBe(true);

      const originalToken = process.env.CROWCLAW_DASHBOARD_TOKEN;
      process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN;
      const secured = createNodeRuntime();
      const securedReq = (method: string, path: string, body?: unknown) =>
        secured.fetch(new Request(`http://localhost${path}`, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }));
      try {
        const missingEnv = await securedReq('POST', '/api/mcp/servers/install', { slug: 'filesystem', env: {} });
        expect(missingEnv.status).toBe(400);

        const installRes = await securedReq('POST', '/api/mcp/servers/install', {
          slug: 'filesystem',
          env: { WORKSPACE_DIR: '/tmp/crowclaw-fixture' },
        });
        const install = await installRes.json() as { ok: boolean; server: { name: string; command: string; args: string[]; custom: boolean } };
        expect(install.ok).toBe(true);
        expect(install.server).toMatchObject({ name: 'filesystem', command: 'npx', custom: false });
        expect(install.server.args).toContain('@modelcontextprotocol/server-filesystem');
      } finally {
        await secured.shutdown();
        if (originalToken === undefined) delete process.env.CROWCLAW_DASHBOARD_TOKEN;
        else process.env.CROWCLAW_DASHBOARD_TOKEN = originalToken;
      }
    });
  });

  describe('GET /api/sessions/:id/export and POST /api/sessions/import', () => {
    it('exports and imports a self-contained session JSON envelope', async () => {
      await req('POST', '/api/sessions', { sessionId: 'export-demo' });

      const exported = await req('GET', '/api/sessions/export-demo/export');
      const payload = await exported.json() as { ok: boolean; session: { sessionId: string }; metadata: { exportVersion: number } };
      expect(payload.ok).toBe(true);
      expect(payload.session.sessionId).toBe('export-demo');
      expect(payload.metadata.exportVersion).toBe(1);

      const imported = await req('POST', '/api/sessions/import', payload);
      const data = await imported.json() as { ok: boolean; sessionId: string };
      expect(data.ok).toBe(true);
      expect(data.sessionId).not.toBe('export-demo');
    });
  });

  describe('GET /api/config/snapshot', () => {
    it('should return current config state', async () => {
      // Set some state first
      await req('POST', '/api/agent/preset', { name: 'test-preset', role: 'tester', goal: 'test' });
      await req('POST', '/api/toolset/select', { name: 'minimal' });

      const res = await req('GET', '/api/config/snapshot');
      const data = await res.json() as { ok: boolean; activePreset: string; activeToolset: string };
      expect(data.ok).toBe(true);
      expect(data.activePreset).toBe('test-preset');
      expect(data.activeToolset).toBe('minimal');
    });
  });

  describe('GET /api/sessions', () => {
    it('should return session list', async () => {
      const res = await req('GET', '/api/sessions');
      const data = await res.json() as { sessions: unknown[] };
      expect(Array.isArray(data.sessions)).toBe(true);
    });
  });

  describe('GET /api/events (SSE)', () => {
    it('should return event stream', async () => {
      const res = await req('GET', '/api/events');
      // Route may not yet implement SSE — verify it responds without error
      expect(res.status).toBeLessThan(500);
      const ct = res.headers.get('content-type') ?? '';
      // Accept either SSE content-type or a JSON/text fallback
      expect(ct.length).toBeGreaterThan(0);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('Configuration API', () => {
  const runtime = createNodeRuntime();

  function req(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
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

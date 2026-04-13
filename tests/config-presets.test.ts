import { describe, it, expect } from 'vitest';
import { RuntimeConfigStore, FileConfigStore, DEFAULT_CONFIG_PRESETS } from '../packages/runtime-node/src/config-store.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

describe('Config Presets', () => {
  describe('DEFAULT_CONFIG_PRESETS', () => {
    it('should include web-research preset', () => {
      const preset = DEFAULT_CONFIG_PRESETS.find((p) => p.name === 'web-research');
      expect(preset).toBeDefined();
      expect(preset!.description).toBe('Browse and analyze web content');
      expect(preset!.mcpServers).toContain('braveSearch');
      expect(preset!.skills).toContain('web-research');
    });

    it('should include code-development preset', () => {
      const preset = DEFAULT_CONFIG_PRESETS.find((p) => p.name === 'code-development');
      expect(preset).toBeDefined();
      expect(preset!.mcpServers).toContain('github');
      expect(preset!.toolset).toBe('devops');
    });

    it('should include data-analysis preset', () => {
      const preset = DEFAULT_CONFIG_PRESETS.find((p) => p.name === 'data-analysis');
      expect(preset).toBeDefined();
      expect(preset!.mcpServers).toContain('postgres');
    });

    it('should include minimal preset', () => {
      const preset = DEFAULT_CONFIG_PRESETS.find((p) => p.name === 'minimal');
      expect(preset).toBeDefined();
      expect(preset!.mcpServers).toEqual([]);
      expect(preset!.skills).toEqual([]);
    });

    it('should have 4 default presets', () => {
      expect(DEFAULT_CONFIG_PRESETS.length).toBe(4);
    });
  });

  describe('RuntimeConfigStore', () => {
    it('should have default presets on construction', () => {
      const store = new RuntimeConfigStore();
      const presets = store.getConfigPresets();
      expect(presets.length).toBe(4);
      expect(presets.map((p) => p.name)).toContain('web-research');
      expect(presets.map((p) => p.name)).toContain('code-development');
      expect(presets.map((p) => p.name)).toContain('data-analysis');
      expect(presets.map((p) => p.name)).toContain('minimal');
    });

    it('should return null for active config preset when none set', () => {
      const store = new RuntimeConfigStore();
      expect(store.getActiveConfigPreset()).toBeNull();
      expect(store.getActiveConfigPresetName()).toBeNull();
    });

    it('should set and get active config preset', () => {
      const store = new RuntimeConfigStore();
      store.setActiveConfigPreset('web-research');
      expect(store.getActiveConfigPresetName()).toBe('web-research');
      const active = store.getActiveConfigPreset();
      expect(active).toBeDefined();
      expect(active!.name).toBe('web-research');
    });

    it('should throw when setting non-existent preset as active', () => {
      const store = new RuntimeConfigStore();
      expect(() => store.setActiveConfigPreset('nonexistent')).toThrow("Config preset 'nonexistent' not found");
    });

    it('should clear active preset with null', () => {
      const store = new RuntimeConfigStore();
      store.setActiveConfigPreset('minimal');
      expect(store.getActiveConfigPresetName()).toBe('minimal');
      store.setActiveConfigPreset(null);
      expect(store.getActiveConfigPresetName()).toBeNull();
    });

    it('should save a new preset', () => {
      const store = new RuntimeConfigStore();
      const now = new Date().toISOString();
      store.saveConfigPreset({
        name: 'custom-preset',
        description: 'A custom test preset',
        mcpServers: ['testServer'],
        skills: ['test-skill'],
        toolset: 'full',
        createdAt: now,
        updatedAt: now,
      });
      const preset = store.getConfigPreset('custom-preset');
      expect(preset).toBeDefined();
      expect(preset!.description).toBe('A custom test preset');
      expect(preset!.mcpServers).toEqual(['testServer']);
      expect(store.getConfigPresets().length).toBe(5);
    });

    it('should update an existing preset', () => {
      const store = new RuntimeConfigStore();
      const now = new Date().toISOString();
      store.saveConfigPreset({
        name: 'minimal',
        description: 'Updated minimal',
        mcpServers: ['newServer'],
        skills: [],
        toolset: 'web',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: now,
      });
      const preset = store.getConfigPreset('minimal');
      expect(preset!.description).toBe('Updated minimal');
      expect(preset!.mcpServers).toEqual(['newServer']);
      expect(store.getConfigPresets().length).toBe(4); // still 4, not 5
    });

    it('should delete a preset', () => {
      const store = new RuntimeConfigStore();
      const deleted = store.deleteConfigPreset('minimal');
      expect(deleted).toBe(true);
      expect(store.getConfigPreset('minimal')).toBeUndefined();
      expect(store.getConfigPresets().length).toBe(3);
    });

    it('should return false when deleting non-existent preset', () => {
      const store = new RuntimeConfigStore();
      const deleted = store.deleteConfigPreset('nonexistent');
      expect(deleted).toBe(false);
    });

    it('should clear active preset when deleting the active one', () => {
      const store = new RuntimeConfigStore();
      store.setActiveConfigPreset('web-research');
      store.deleteConfigPreset('web-research');
      expect(store.getActiveConfigPresetName()).toBeNull();
    });

    it('should include config presets in snapshot', () => {
      const store = new RuntimeConfigStore();
      store.setActiveConfigPreset('code-development');
      const snapshot = store.snapshot();
      expect(snapshot.configPresets).toBeDefined();
      expect(Array.isArray(snapshot.configPresets)).toBe(true);
      expect((snapshot.configPresets as unknown[]).length).toBe(4);
      expect(snapshot.activeConfigPreset).toBe('code-development');
    });
  });

  describe('API Endpoints', () => {
    const runtime = createNodeRuntime();

    function req(method: string, path: string, body?: unknown) {
      const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
      if (body) init.body = JSON.stringify(body);
      return runtime.fetch(new Request(`http://localhost${path}`, init));
    }

    it('GET /api/config-presets should list presets', async () => {
      const res = await req('GET', '/api/config-presets');
      const data = await res.json() as { presets: unknown[]; active: string | null };
      expect(res.status).toBe(200);
      expect(data.presets).toBeDefined();
      expect(Array.isArray(data.presets)).toBe(true);
      expect(data.presets.length).toBe(4);
      expect(data.active).toBeNull();
    });

    it('GET /api/config-presets/active should return null when none active', async () => {
      const res = await req('GET', '/api/config-presets/active');
      const data = await res.json() as { preset: unknown; name: string | null };
      expect(data.preset).toBeNull();
      expect(data.name).toBeNull();
    });

    it('POST /api/config-presets/switch should activate a preset', async () => {
      const res = await req('POST', '/api/config-presets/switch', { name: 'minimal' });
      const data = await res.json() as { ok: boolean; active: string };
      expect(data.ok).toBe(true);
      expect(data.active).toBe('minimal');
    });

    it('POST /api/config-presets/switch should update toolset when preset has one', async () => {
      const res = await req('POST', '/api/config-presets/switch', { name: 'code-development' });
      const data = await res.json() as { ok: boolean; active: string; preset: { toolset: string } };
      expect(data.ok).toBe(true);
      expect(data.preset.toolset).toBe('devops');
    });

    it('POST /api/config-presets/switch should return 404 for unknown preset', async () => {
      const res = await req('POST', '/api/config-presets/switch', { name: 'nonexistent' });
      expect(res.status).toBe(404);
    });

    it('POST /api/config-presets/switch with null should clear active', async () => {
      await req('POST', '/api/config-presets/switch', { name: 'minimal' });
      const res = await req('POST', '/api/config-presets/switch', { name: null });
      const data = await res.json() as { ok: boolean; active: null };
      expect(data.ok).toBe(true);
      expect(data.active).toBeNull();
    });

    it('POST /api/config-presets should create a new preset', async () => {
      const res = await req('POST', '/api/config-presets', {
        name: 'test-preset',
        description: 'Test preset for CI',
        mcpServers: ['testMcp'],
        skills: ['test-skill'],
        toolset: 'web',
      });
      const data = await res.json() as { ok: boolean; preset: { name: string; description: string } };
      expect(data.ok).toBe(true);
      expect(data.preset.name).toBe('test-preset');
      expect(data.preset.description).toBe('Test preset for CI');
    });

    it('POST /api/config-presets should reject preset without name', async () => {
      const res = await req('POST', '/api/config-presets', { description: 'No name' });
      expect(res.status).toBe(400);
    });

    it('DELETE /api/config-presets/:name should delete a preset', async () => {
      // First create one
      await req('POST', '/api/config-presets', {
        name: 'to-delete',
        description: 'Will be deleted',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const res = await req('DELETE', '/api/config-presets/to-delete');
      const data = await res.json() as { ok: boolean; deleted: string };
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe('to-delete');
    });

    it('DELETE /api/config-presets/:name should return 404 for unknown', async () => {
      const res = await req('DELETE', '/api/config-presets/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('Dashboard HTML', () => {
    it('should contain config presets tab', () => {
      expect(DASHBOARD_HTML).toContain('Config Presets');
    });

    it('should contain Personas tab (renamed from Agent)', () => {
      expect(DASHBOARD_HTML).toContain('Personas');
    });

    it('should contain Toolsets tab', () => {
      expect(DASHBOARD_HTML).toContain('Toolsets');
    });

    it('should contain pConfig container', () => {
      expect(DASHBOARD_HTML).toContain('id="pConfig"');
    });

    it('should contain config preset API calls', () => {
      expect(DASHBOARD_HTML).toContain('/api/config-presets');
    });

    it('should contain config preset switch function', () => {
      expect(DASHBOARD_HTML).toContain('cfgPreSwitch');
    });

    it('should contain config preset create modal function', () => {
      expect(DASHBOARD_HTML).toContain('cfgPreModal');
    });

    it('should contain config preset delete function', () => {
      expect(DASHBOARD_HTML).toContain('cfgPreDel');
    });
  });
});

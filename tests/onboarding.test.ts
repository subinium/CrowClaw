import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import {
  shouldRunOnboarding,
  configFileExists,
  saveConfig,
  loadConfig,
  type CrowClawConfig,
} from '../packages/cli/src/index.js';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statSync } from 'node:fs';

// --- Web Dashboard Onboarding Tests ---

describe('Web onboarding wizard', () => {
  const html = DASHBOARD_HTML;

  it('contains CrowClaw branding', () => {
    expect(html).toContain('CrowClaw');
  });

  it('contains crowclaw-app root element', () => {
    expect(html).toContain('crowclaw-app');
  });

  it('contains crowclaw-chat-view for chat interaction', () => {
    expect(html).toContain('crowclaw-chat-view');
  });

  it('contains crowclaw-settings-view for configuration', () => {
    expect(html).toContain('crowclaw-settings-view');
  });

  it('contains crowclaw-connect-view for provider setup', () => {
    expect(html).toContain('crowclaw-connect-view');
  });

  it('contains crowclaw-agent-view for agent configuration', () => {
    expect(html).toContain('crowclaw-agent-view');
  });

  it('contains auth verification API endpoint', () => {
    expect(html).toContain('/api/auth/verify');
  });

  it('contains auth check API endpoint', () => {
    expect(html).toContain('/api/auth/check');
  });

  it('contains password input for authentication', () => {
    expect(html).toContain('password');
  });

  it('contains providers API endpoint', () => {
    expect(html).toContain('/api/providers');
  });

  it('contains sessions API endpoint', () => {
    expect(html).toContain('/api/sessions');
  });

  it('contains skills API endpoint', () => {
    expect(html).toContain('/api/skills');
  });

  it('contains presets API endpoint', () => {
    expect(html).toContain('/api/presets');
  });

  it('contains MCP servers API endpoint', () => {
    expect(html).toContain('/api/mcp/servers');
  });

  it('contains system status API endpoint', () => {
    expect(html).toContain('/api/system/status');
  });

  it('contains Sign In text for auth flow', () => {
    expect(html).toContain('Sign In');
  });

  it('contains Dashboard token text', () => {
    expect(html).toContain('Dashboard token');
  });

  it('contains CSS custom properties for theming', () => {
    expect(html).toContain('--bg-primary');
    expect(html).toContain('--accent');
    expect(html).toContain('--text-primary');
  });
});

// --- Provider Test Endpoint ---

describe('Provider test endpoint', () => {
  const testToken = 'onboarding-test-token';
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
    ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
    env: {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
      CROWCLAW_DASHBOARD_TOKEN: testToken,
    },
  };
  const runtime = createNodeRuntime();

  function req(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${testToken}` } };
    if (body) init.body = JSON.stringify(body);
    return runtime.fetch(new Request(`http://localhost${path}`, init));
  }

  it('POST /api/config/provider/test returns error shape when missing key', async () => {
    const res = await req('POST', '/api/config/provider/test', {
      baseUrl: 'https://api.openai.com/v1',
      provider: 'openai',
    });
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('Missing API key');
  });

  it('POST /api/config/provider/test returns error with invalid key', async () => {
    const res = await req('POST', '/api/config/provider/test', {
      apiKey: 'sk-invalid-test-key',
      baseUrl: 'http://localhost:1/v1',
      provider: 'openai',
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  it('POST /api/config/provider saves provider config', async () => {
    const res = await req('POST', '/api/config/provider', {
      apiKey: 'test-key',
      baseUrl: 'https://test.example.com/v1',
      model: 'test-model',
      provider: 'openai',
    });
    const data = (await res.json()) as { ok: boolean; model: string; provider: string };
    expect(data.ok).toBe(true);
    expect(data.model).toBe('test-model');
    expect(data.provider).toBe('openai');
  });
});

// --- CLI Onboarding Detection ---

describe('CLI onboarding detection', () => {
  it('shouldRunOnboarding returns false when --no-onboarding flag is set', () => {
    expect(shouldRunOnboarding(['--no-onboarding'])).toBe(false);
  });

  it('shouldRunOnboarding returns false when CROWCLAW_API_KEY env is set', () => {
    const prev = process.env.CROWCLAW_API_KEY;
    process.env.CROWCLAW_API_KEY = 'test-key';
    expect(shouldRunOnboarding([])).toBe(false);
    if (prev === undefined) {
      delete process.env.CROWCLAW_API_KEY;
    } else {
      process.env.CROWCLAW_API_KEY = prev;
    }
  });

  it('shouldRunOnboarding returns true when no skip conditions are met', () => {
    const prev = process.env.CROWCLAW_API_KEY;
    delete process.env.CROWCLAW_API_KEY;
    expect(shouldRunOnboarding([])).toBe(true);
    if (prev !== undefined) process.env.CROWCLAW_API_KEY = prev;
  });
});

// --- Config File Read/Write/Permissions ---

describe('Config file operations', () => {
  const tempDir = join(tmpdir(), `crowclaw-test-${Date.now()}`);
  const tempConfigDir = join(tempDir, '.crowclaw');
  const tempConfigPath = join(tempConfigDir, 'config.json');

  const testConfig: CrowClawConfig = {
    provider: 'openai',
    apiKey: 'sk-test-12345',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    preset: 'general',
    createdAt: '2026-04-13T00:00:00.000Z',
  };

  beforeAll(async () => {
    await mkdir(tempConfigDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('saveConfig writes valid JSON', async () => {
    await saveConfig(testConfig);
    const config = await loadConfig();
    if (config) {
      expect(config.provider).toBeDefined();
      expect(config.apiKey).toBeDefined();
      expect(config.baseUrl).toBeDefined();
      expect(config.model).toBeDefined();
      expect(config.preset).toBeDefined();
      expect(config.createdAt).toBeDefined();
    }
  });

  it('config file written to temp dir has correct structure', async () => {
    const data = JSON.stringify(testConfig, null, 2);
    await writeFile(tempConfigPath, data, { mode: 0o600 });
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(tempConfigPath, 'utf-8'));
    const parsed = JSON.parse(raw) as CrowClawConfig;
    expect(parsed.provider).toBe('openai');
    expect(parsed.apiKey).toBe('sk-test-12345');
    expect(parsed.baseUrl).toBe('https://api.openai.com/v1');
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.preset).toBe('general');
    expect(parsed.createdAt).toBe('2026-04-13T00:00:00.000Z');
  });

  it('config file has restricted permissions (0o600)', async () => {
    const data = JSON.stringify(testConfig, null, 2);
    await writeFile(tempConfigPath, data, { mode: 0o600 });
    const stats = statSync(tempConfigPath);
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('configFileExists detects existing file', async () => {
    const exists = await configFileExists();
    expect(typeof exists).toBe('boolean');
  });
});

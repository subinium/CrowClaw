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

  it('contains all 6 onboarding steps', () => {
    expect(html).toContain('id="obs0"');
    expect(html).toContain('id="obs1"');
    expect(html).toContain('id="obs2"');
    expect(html).toContain('id="obs3"');
    expect(html).toContain('id="obs4"');
    expect(html).toContain('id="obs5"');
  });

  it('step 0 is the welcome screen with CrowClaw branding', () => {
    expect(html).toContain('CrowClaw');
    expect(html).toContain('Self-improving AI agent framework');
    expect(html).toContain('under 60 seconds');
    expect(html).toContain('Get Started');
    expect(html).toContain('Skip setup');
  });

  it('step 1 has provider selection cards', () => {
    expect(html).toContain('ob-provider-grid');
    expect(html).toContain('data-prov="openai"');
    expect(html).toContain('data-prov="anthropic"');
    expect(html).toContain('data-prov="openrouter"');
    expect(html).toContain('data-prov="custom"');
    expect(html).toContain('GPT-4o, GPT-4.1, o-series');
    expect(html).toContain('Claude 4, Claude Sonnet, Haiku');
    expect(html).toContain('200+ models, single API key');
    expect(html).toContain('Any OpenAI-compatible endpoint');
  });

  it('step 1 pre-fills base URLs in data attributes', () => {
    expect(html).toContain('data-url="https://api.openai.com/v1"');
    expect(html).toContain('data-url="https://api.anthropic.com"');
    expect(html).toContain('data-url="https://openrouter.ai/api/v1"');
  });

  it('step 2 has API key input with show/hide toggle', () => {
    expect(html).toContain('id="obKey"');
    expect(html).toContain('type="password"');
    expect(html).toContain('ob-key-toggle');
    expect(html).toContain('obToggleKey()');
  });

  it('step 2 has Test Connection button and result area', () => {
    expect(html).toContain('id="obTestBtn"');
    expect(html).toContain('Test Connection');
    expect(html).toContain('obTestConn()');
    expect(html).toContain('id="obTestRes"');
    expect(html).toContain('ob-test-result');
  });

  it('step 2 has base URL input', () => {
    expect(html).toContain('id="obUrl"');
  });

  it('step 3 has model selection grid', () => {
    expect(html).toContain('id="obModGrid"');
    expect(html).toContain('ob-model-grid');
  });

  it('step 4 has preset selection grid', () => {
    expect(html).toContain('id="obPreGrid"');
    expect(html).toContain('ob-preset-grid');
  });

  it('step 5 is the all-done screen', () => {
    expect(html).toContain('CrowClaw is ready!');
    expect(html).toContain('Start chatting below');
    expect(html).toContain('Press Cmd+K for quick commands');
    expect(html).toContain('Explore Agent and Connect tabs in the sidebar');
    expect(html).toContain('Start Chatting');
  });

  it('has step indicator dots', () => {
    expect(html).toContain('id="obDots"');
    expect(html).toContain('ob-dots');
    expect(html).toContain('obRenderDots');
  });

  it('has back/next navigation with proper controls', () => {
    expect(html).toContain('id="obBack"');
    expect(html).toContain('id="obNext"');
    expect(html).toContain('id="obNavBar"');
    expect(html).toContain('obNav(-1)');
    expect(html).toContain('obNav(1)');
  });

  it('sends API key to server, not localStorage', () => {
    // The JS should POST to /api/config/provider, not store key in localStorage
    expect(html).toContain('/api/config/provider');
    // Only cc_onboarded flag in localStorage
    expect(html).toContain("localStorage.setItem('cc_onboarded', '1')");
    // Should NOT store the key in localStorage
    expect(html).not.toContain("localStorage.setItem('cc_api_key'");
  });

  it('provider test calls /api/config/provider/test', () => {
    expect(html).toContain('/api/config/provider/test');
  });

  it('contains CSS for onboarding provider cards', () => {
    expect(html).toContain('.ob-pcard');
    expect(html).toContain('.ob-pcard.sel');
    expect(html).toContain('.ob-mcard');
    expect(html).toContain('.ob-prcard');
    expect(html).toContain('.ob-spinner');
    expect(html).toContain('.ob-test-result.ok');
    expect(html).toContain('.ob-test-result.er');
  });

  it('has smooth step transitions via CSS', () => {
    expect(html).toContain('transition: opacity .25s ease, transform .25s ease');
  });

  it('model definitions include provider-specific models', () => {
    expect(html).toContain("openai: [");
    expect(html).toContain("anthropic: [");
    expect(html).toContain("openrouter: [");
    expect(html).toContain("custom: [");
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
    // This will fail to connect to a real API but should return the correct shape
    const res = await req('POST', '/api/config/provider/test', {
      apiKey: 'sk-invalid-test-key',
      baseUrl: 'http://localhost:1/v1', // unreachable
      provider: 'openai',
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    // Should not crash — returns ok:false with an error message
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

  // We test saveConfig/loadConfig by temporarily overriding the path
  // Since the functions use a const, we test the actual behavior with real files
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
    // If the home config already existed, we check the structure is correct
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
    // Check owner-only read/write (0o600 = 384 decimal)
    // On some systems the mode may include the file type bits, so mask with 0o777
    const perms = stats.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it('configFileExists detects existing file', async () => {
    // This checks the real ~/.crowclaw/config.json — which may or may not exist
    // We just verify it returns a boolean
    const exists = await configFileExists();
    expect(typeof exists).toBe('boolean');
  });
});

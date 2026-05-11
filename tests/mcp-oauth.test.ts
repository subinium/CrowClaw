import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mcpPresets,
  listMcpPresetNames,
  getMcpPresetDescription,
  OAUTH_CONFIGS,
  hasValidToken,
  saveOAuthToken,
} from '../packages/mcp/src/index.js';
import { parseCliArgs, renderCliHelp, builtInCliSlashCommands } from '../packages/cli/src/index.js';

// --- Task 1: Playwright and new presets ---

describe('Playwright MCP preset', () => {
  it('generates correct command and args', () => {
    const config = mcpPresets.playwright();
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@playwright/mcp@latest');
  });

  it('generates config with headless=false', () => {
    const config = mcpPresets.playwright({ headless: false });
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@playwright/mcp@latest');
    expect(config.env).toEqual({ HEADLESS: 'false' });
  });

  it('generates config with default headless (no env)', () => {
    const config = mcpPresets.playwright({ headless: true });
    expect(config.env).toBeUndefined();
  });

  it('has a description', () => {
    expect(getMcpPresetDescription('playwright')).toBeTruthy();
    expect(getMcpPresetDescription('playwright')).toContain('Browser automation');
  });
});

describe('Exa MCP preset', () => {
  it('generates correct command and args', () => {
    const config = mcpPresets.exa({ apiKey: 'exa_test_key' });
    expect(config.command).toBe('npx');
    expect(config.args).toContain('exa-mcp-server');
    expect(config.env).toEqual({ EXA_API_KEY: 'exa_test_key' });
  });

  it('has a description', () => {
    expect(getMcpPresetDescription('exa')).toBeTruthy();
    expect(getMcpPresetDescription('exa')).toContain('Exa');
  });
});

describe('Existing presets still work', () => {
  it('puppeteer preset exists and generates correct config', () => {
    const config = mcpPresets.puppeteer();
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@modelcontextprotocol/server-puppeteer');
  });

  it('memory preset exists and generates correct config', () => {
    const config = mcpPresets.memory();
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@modelcontextprotocol/server-memory');
  });

  it('fetch preset exists and generates correct config', () => {
    const config = mcpPresets.fetch();
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@modelcontextprotocol/server-fetch');
  });

  it('everart preset exists and generates correct config', () => {
    const config = mcpPresets.everart();
    expect(config.command).toBe('npx');
    expect(config.args).toContain('@modelcontextprotocol/server-everart');
  });
});

describe('All presets have name and description', () => {
  it('should have at least 17 presets (including playwright and exa)', () => {
    const names = listMcpPresetNames();
    expect(names.length).toBeGreaterThanOrEqual(17);
  });

  it('every preset has a description', () => {
    for (const name of listMcpPresetNames()) {
      const desc = getMcpPresetDescription(name);
      expect(desc, `Missing description for preset: ${name}`).toBeTruthy();
    }
  });

  it('playwright and exa are in the preset list', () => {
    const names = listMcpPresetNames();
    expect(names).toContain('playwright');
    expect(names).toContain('exa');
  });
});

// --- Task 2: OAuth helper ---

describe('OAuth configs', () => {
  it('has config for github', () => {
    expect(OAUTH_CONFIGS.github).toBeDefined();
    expect(OAUTH_CONFIGS.github.provider).toBe('github');
    expect(OAUTH_CONFIGS.github.envVarName).toBe('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(OAUTH_CONFIGS.github.flowType).toBe('device_code');
    expect(OAUTH_CONFIGS.github.scopes).toContain('repo');
  });

  it('has config for slack', () => {
    expect(OAUTH_CONFIGS.slack).toBeDefined();
    expect(OAUTH_CONFIGS.slack.provider).toBe('slack');
    expect(OAUTH_CONFIGS.slack.envVarName).toBe('SLACK_BOT_TOKEN');
    expect(OAUTH_CONFIGS.slack.flowType).toBe('pat');
  });

  it('has config for google', () => {
    expect(OAUTH_CONFIGS.google).toBeDefined();
    expect(OAUTH_CONFIGS.google.provider).toBe('google');
    expect(OAUTH_CONFIGS.google.envVarName).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    expect(OAUTH_CONFIGS.google.flowType).toBe('pat');
  });
});

describe('hasValidToken', () => {
  it('returns false when no token is stored', () => {
    // No token should be stored for a random provider name
    expect(hasValidToken('nonexistent-provider-test')).toBe(false);
  });

  it('returns false for providers with no config file', () => {
    expect(hasValidToken('github')).toBe(false);
  });
});

describe('saveOAuthToken', () => {
  // We test that saveOAuthToken writes to the config file.
  // Since it writes to ~/.crowclaw/runtime-config.json, we test via hasValidToken round-trip.
  // Note: this test actually writes to the user's home dir, so we use a provider name
  // that won't conflict with real data.
  const testProvider = '__test_mcp_oauth_provider__';

  afterEach(async () => {
    // Clean up the test token
    try {
      const { removeToken } = await import('../packages/mcp/src/oauth.js');
      await removeToken(testProvider);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('writes a token that can be read back', async () => {
    await saveOAuthToken(testProvider, 'test-token-12345');
    expect(hasValidToken(testProvider)).toBe(true);
  });

  it('writes a token with expiry that can be validated', async () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    await saveOAuthToken(testProvider, 'test-token-expiry', futureDate);
    expect(hasValidToken(testProvider)).toBe(true);
  });

  it('expired token returns false from hasValidToken', async () => {
    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    await saveOAuthToken(testProvider, 'test-token-expired', pastDate);
    expect(hasValidToken(testProvider)).toBe(false);
  });
});

// --- Task 3: CLI mcp commands ---

describe('CLI mcp command parsing', () => {
  it('parses "mcp list"', () => {
    const parsed = parseCliArgs(['mcp', 'list']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.mcpSubcommand).toBe('list');
  });

  it('parses "mcp" defaults to list', () => {
    const parsed = parseCliArgs(['mcp']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.mcpSubcommand).toBe('list');
  });

  it('parses "mcp auth github"', () => {
    const parsed = parseCliArgs(['mcp', 'auth', 'github']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.mcpSubcommand).toBe('auth');
    expect(parsed.mcpArgs).toEqual(['github']);
  });

  it('parses "mcp add <url>"', () => {
    const parsed = parseCliArgs(['mcp', 'add', 'http://localhost:8080/mcp']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.mcpSubcommand).toBe('add');
    expect(parsed.mcpArgs).toEqual(['http://localhost:8080/mcp']);
  });

  it('parses "mcp remove <name>"', () => {
    const parsed = parseCliArgs(['mcp', 'remove', 'my-server']);
    expect(parsed.command).toBe('mcp');
    expect(parsed.mcpSubcommand).toBe('remove');
    expect(parsed.mcpArgs).toEqual(['my-server']);
  });
});

describe('CLI help text includes mcp commands', () => {
  it('help text mentions mcp auth', () => {
    const help = renderCliHelp();
    expect(help).toContain('mcp auth');
  });

  it('help text mentions mcp list', () => {
    const help = renderCliHelp();
    expect(help).toContain('mcp list');
  });

  it('help text mentions mcp add', () => {
    const help = renderCliHelp();
    expect(help).toContain('mcp add');
  });

  it('help text mentions mcp remove', () => {
    const help = renderCliHelp();
    expect(help).toContain('mcp remove');
  });
});

describe('CLI slash commands include mcp commands', () => {
  it('includes /mcp-auth', () => {
    expect(builtInCliSlashCommands).toContain('/mcp-auth');
  });

  it('includes /mcp-add', () => {
    expect(builtInCliSlashCommands).toContain('/mcp-add');
  });

  it('includes /mcp-list', () => {
    expect(builtInCliSlashCommands).toContain('/mcp-list');
  });

  it('includes /mcp-remove', () => {
    expect(builtInCliSlashCommands).toContain('/mcp-remove');
  });
});

import { describe, it, expect } from 'vitest';
import { mcpPresets, listMcpPresetNames, getMcpPresetDescription } from '../packages/mcp/src/index.js';

describe('MCP Presets (expanded)', () => {
  it('should have at least 12 presets', () => {
    expect(listMcpPresetNames().length).toBeGreaterThanOrEqual(12);
  });

  it('each zero-config preset should return a valid config', () => {
    const memoryConfig = mcpPresets.memory();
    expect(memoryConfig.command).toBe('npx');
    expect(memoryConfig.args).toContain('-y');

    const fetchConfig = mcpPresets.fetch();
    expect(fetchConfig.command).toBe('npx');

    const timeConfig = mcpPresets.time();
    expect(timeConfig.command).toBe('npx');
  });

  it('filesystem preset should accept roots', () => {
    const config = mcpPresets.filesystem({ roots: ['/tmp', '/home'] });
    expect(config.args).toContain('/tmp');
    expect(config.args).toContain('/home');
  });

  it('github preset should set token env var', () => {
    const config = mcpPresets.github({ token: 'ghp_test123' });
    expect(config.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_test123');
  });

  it('postgres preset should include connection string', () => {
    const config = mcpPresets.postgres({ connectionString: 'postgres://localhost/test' });
    expect(config.args).toContain('postgres://localhost/test');
  });

  it('slack preset should set bot token', () => {
    const config = mcpPresets.slack({ botToken: 'xoxb-test' });
    expect(config.env?.SLACK_BOT_TOKEN).toBe('xoxb-test');
  });

  it('every preset should have a description', () => {
    for (const name of listMcpPresetNames()) {
      expect(getMcpPresetDescription(name)).toBeTruthy();
    }
  });
});

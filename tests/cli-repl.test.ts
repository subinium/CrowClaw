import { describe, expect, it } from 'vitest';
import { parseCliArgs, renderCliHelp, suggestCliCommands, builtInCliSlashCommands } from '@crowclaw/cli';

describe('CLI REPL enhancements', () => {
  it('includes new slash commands in the list', () => {
    expect(builtInCliSlashCommands).toContain('/quit');
    expect(builtInCliSlashCommands).toContain('/exit');
    expect(builtInCliSlashCommands).toContain('/compact');
    expect(builtInCliSlashCommands).toContain('/clear');
    expect(builtInCliSlashCommands).toContain('/model');
    expect(builtInCliSlashCommands).toContain('/session');
  });

  it('suggests new commands', () => {
    expect(suggestCliCommands('/qu')).toContain('/quit');
    expect(suggestCliCommands('/ex')).toContain('/exit');
    expect(suggestCliCommands('/cl')).toContain('/clear');
    expect(suggestCliCommands('/co')).toContain('/compact');
    expect(suggestCliCommands('/mo')).toContain('/model');
    expect(suggestCliCommands('/se')).toContain('/session');
  });

  it('help text includes REPL information', () => {
    const help = renderCliHelp();
    expect(help).toContain('/quit');
    expect(help).toContain('/compact');
    expect(help).toContain('/clear');
  });

  it('parseCliArgs still works for existing commands', () => {
    expect(parseCliArgs(['status']).command).toBe('status');
    expect(parseCliArgs(['tools']).command).toBe('tools');
    expect(parseCliArgs(['chat', '-q', 'hello']).query).toBe('hello');
    expect(parseCliArgs([]).command).toBe('help');
  });
});

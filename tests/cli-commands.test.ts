import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCliArgs,
  renderCliHelp,
  migrateImport,
  runMigrateCommand,
  formatDoctorReport,
  formatToolsTable,
  formatSkillsTable,
  formatSessionsTable,
  formatJobsTable,
  runDoctor,
  resolveTailnetBindHost,
  type DoctorReport,
  type CliRuntimeLike,
} from '@crowclaw/cli';

// --- Subcommand parsing ---

describe('CLI subcommand parsing', () => {
  it('no args → repl', () => {
    const parsed = parseCliArgs([]);
    expect(parsed.command).toBe('repl');
  });

  it('"help" → help', () => {
    expect(parseCliArgs(['help']).command).toBe('help');
  });

  it('"--help" → help', () => {
    expect(parseCliArgs(['--help']).command).toBe('help');
  });

  it('"-h" → help', () => {
    expect(parseCliArgs(['-h']).command).toBe('help');
  });

  it('"init" → init', () => {
    expect(parseCliArgs(['init']).command).toBe('init');
  });

  it('"doctor" → doctor', () => {
    expect(parseCliArgs(['doctor']).command).toBe('doctor');
  });

  it('"status" → status', () => {
    expect(parseCliArgs(['status']).command).toBe('status');
  });

  it('"sessions" → sessions', () => {
    expect(parseCliArgs(['sessions']).command).toBe('sessions');
  });

  it('"skills" → skills', () => {
    expect(parseCliArgs(['skills']).command).toBe('skills');
  });

  it('"tools" → tools', () => {
    expect(parseCliArgs(['tools']).command).toBe('tools');
  });

  it('"jobs" → jobs', () => {
    expect(parseCliArgs(['jobs']).command).toBe('jobs');
  });

  it('"serve" → serve with default port', () => {
    const parsed = parseCliArgs(['serve']);
    expect(parsed.command).toBe('serve');
    expect(parsed.port).toBeUndefined();
  });

  it('"serve --port 4000" → serve with port', () => {
    const parsed = parseCliArgs(['serve', '--port', '4000']);
    expect(parsed.command).toBe('serve');
    expect(parsed.port).toBe(4000);
  });

  it('resolves Tailscale bind host when CROWCLAW_BIND_TAILNET_ONLY is set', () => {
    const plan = resolveTailnetBindHost({
      env: { CROWCLAW_BIND_TAILNET_ONLY: '1' },
      fallbackHost: '127.0.0.1',
      spawnSync: () => ({ status: 0, stdout: '100.64.10.11\n' }),
    });

    expect(plan).toEqual({ hostname: '100.64.10.11', source: 'tailscale' });
  });

  it('"chat hello" → chat with query', () => {
    const parsed = parseCliArgs(['chat', 'hello']);
    expect(parsed.command).toBe('chat');
    expect(parsed.query).toBe('hello');
  });

  it('"chat -q hello" → chat with query via flag', () => {
    const parsed = parseCliArgs(['chat', '-q', 'hello']);
    expect(parsed.command).toBe('chat');
    expect(parsed.query).toBe('hello');
  });

  it('"chat" with no query → repl', () => {
    const parsed = parseCliArgs(['chat']);
    expect(parsed.command).toBe('repl');
  });

  it('-q "hello" at top level → chat', () => {
    const parsed = parseCliArgs(['-q', 'hello']);
    expect(parsed.command).toBe('chat');
    expect(parsed.query).toBe('hello');
  });

  it('--no-onboarding flag is preserved', () => {
    const parsed = parseCliArgs(['--no-onboarding']);
    expect(parsed.noOnboarding).toBe(true);
    expect(parsed.command).toBe('repl');
  });

  it('--no-onboarding with subcommand', () => {
    const parsed = parseCliArgs(['--no-onboarding', 'doctor']);
    expect(parsed.command).toBe('doctor');
    expect(parsed.noOnboarding).toBe(true);
  });

  it('chat --session and --continue', () => {
    const parsed = parseCliArgs(['chat', '--session', 'my-session', '--continue']);
    expect(parsed.command).toBe('chat');
    expect(parsed.sessionId).toBe('my-session');
    expect(parsed.continueSession).toBe(true);
  });

  it('"migrate --dry-run" parses as migrate import', () => {
    const parsed = parseCliArgs(['migrate', '--dry-run', '--only', 'skills']);
    expect(parsed.command).toBe('migrate');
    expect(parsed.migrateSubcommand).toBe('import');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.migrateArgs).toEqual(['--only', 'skills']);
  });
});

// --- Help output ---

describe('CLI help output', () => {
  it('contains all subcommands', () => {
    const help = renderCliHelp();
    expect(help).toContain('init');
    expect(help).toContain('doctor');
    expect(help).toContain('chat');
    expect(help).toContain('serve');
    expect(help).toContain('status');
    expect(help).toContain('sessions');
    expect(help).toContain('skills');
    expect(help).toContain('tools');
    expect(help).toContain('jobs');
    expect(help).toContain('migrate import');
    expect(help).toContain('help');
  });

  it('contains options section', () => {
    const help = renderCliHelp();
    expect(help).toContain('-q');
    expect(help).toContain('--no-onboarding');
    expect(help).toContain('--port');
  });

  it('contains usage line', () => {
    const help = renderCliHelp();
    expect(help).toContain('Usage: crowclaw [command] [options]');
  });
});

// --- Doctor output format ---

describe('Doctor report formatting', () => {
  it('formats all-ok report', () => {
    const report: DoctorReport = {
      checks: [
        { name: 'Provider', status: 'ok', detail: 'OpenAI (gpt-4o)' },
        { name: 'Config', status: 'ok', detail: '~/.crowclaw/config.json' },
      ],
      issues: [],
    };
    const output = formatDoctorReport(report);
    expect(output).toContain('CrowClaw Doctor');
    expect(output).toContain('Provider');
    expect(output).toContain('OpenAI (gpt-4o)');
    expect(output).toContain('Config');
    expect(output).toContain('All checks passed');
  });

  it('formats report with warnings and errors', () => {
    const report: DoctorReport = {
      checks: [
        { name: 'Provider', status: 'ok', detail: 'Connected' },
        { name: 'Gateway', status: 'error', detail: 'No platforms configured' },
        { name: 'MCP', status: 'warn', detail: 'No servers connected' },
      ],
      issues: [
        'Gateway: No platforms configured',
        'MCP: No servers connected',
      ],
    };
    const output = formatDoctorReport(report);
    expect(output).toContain('Issues found: 2');
    expect(output).toContain('Gateway: No platforms configured');
    expect(output).toContain('MCP: No servers connected');
  });

  it('includes check icons (ok/warn/error) in output', () => {
    const report: DoctorReport = {
      checks: [
        { name: 'A', status: 'ok', detail: 'fine' },
        { name: 'B', status: 'warn', detail: 'hmm' },
        { name: 'C', status: 'error', detail: 'bad' },
      ],
      issues: ['C: bad'],
    };
    const output = formatDoctorReport(report);
    // Check marks are present (ANSI-escaped)
    expect(output).toContain('\u2713'); // checkmark
    expect(output).toContain('\u26A0'); // warning
    expect(output).toContain('\u2717'); // X mark
  });
});

// --- Doctor execution with mock runtime ---

describe('runDoctor with mock runtime', () => {
  function createMockRuntime(responses: Record<string, unknown>): CliRuntimeLike {
    return {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        for (const [pathPattern, data] of Object.entries(responses)) {
          if (url.pathname === pathPattern || url.pathname.startsWith(pathPattern)) {
            return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
          }
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      tools: {
        list: () => [
          { name: 'tool1', description: 'A tool' },
          { name: 'tool2', description: 'Another tool' },
        ],
      },
    };
  }

  it('runs all checks and returns report', async () => {
    const runtime = createMockRuntime({
      '/health': { ok: true, runtime: 'node', service: 'CrowClaw' },
      '/api/system/status': { toolCount: 5, dangerousToolCount: 1, skillCount: 10, learnedSkillCount: 2, memoryType: 'embedding', workspaceType: 'file-backed', securityActive: true },
      '/api/scheduler/jobs': [{ id: 'j1' }],
      '/api/gateway/status': { platforms: ['telegram'] },
      '/api/mcp/status': { connected: true },
      '/dashboard': {},
    });

    const report = await runDoctor(runtime);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    expect(report.checks.find((c) => c.name === 'Provider')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'Tools')?.detail).toContain('5 registered');
    expect(report.checks.find((c) => c.name === 'Skills')?.detail).toContain('10 built-in');
    expect(report.checks.find((c) => c.name === 'Scheduler')?.detail).toContain('1 job');
    expect(report.checks.find((c) => c.name === 'Gateway')?.status).toBe('ok');
    expect(report.checks.find((c) => c.name === 'MCP')?.status).toBe('ok');
  });

  it('reports errors when services fail', async () => {
    const runtime: CliRuntimeLike = {
      fetch: async () => {
        throw new Error('Connection refused');
      },
    };

    const report = await runDoctor(runtime);
    expect(report.checks.find((c) => c.name === 'Provider')?.status).toBe('error');
    expect(report.issues.length).toBeGreaterThan(0);
  });
});

describe('migrate import command', () => {
  it('dry-runs skill imports without touching the target directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crowclaw-migrate-'));
    const source = join(root, '.hermes');
    const target = join(root, '.crowclaw');
    await mkdir(join(source, 'skills'), { recursive: true });
    await writeFile(join(source, 'skills', 'deploy.md'), '# deploy\n', 'utf-8');

    const result = await migrateImport({ sourceDir: source, targetDir: target, only: ['skills'], dryRun: true });
    expect(result.actions).toContainEqual({
      section: 'skills',
      source: join(source, 'skills', 'deploy.md'),
      target: join(target, 'skills', 'deploy.md'),
      action: 'copy',
    });
    await expect(readFile(join(target, 'skills', 'deploy.md'), 'utf-8')).rejects.toThrow();
  });

  it('copies only selected skill files and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crowclaw-migrate-'));
    const source = join(root, '.openclaw');
    const target = join(root, '.crowclaw');
    await mkdir(join(source, 'skills'), { recursive: true });
    await mkdir(join(source, 'personas'), { recursive: true });
    await writeFile(join(source, 'skills', 'review.md'), '# review\n', 'utf-8');
    await writeFile(join(source, 'personas', 'SOUL.md'), '# soul\n', 'utf-8');

    await migrateImport({ sourceDir: source, targetDir: target, only: ['skills'] });
    expect(await readFile(join(target, 'skills', 'review.md'), 'utf-8')).toBe('# review\n');
    await expect(readFile(join(target, 'personas', 'SOUL.md'), 'utf-8')).rejects.toThrow();

    const second = await migrateImport({ sourceDir: source, targetDir: target, only: ['skills'] });
    expect(second.actions[0]?.action).toBe('skip');
  });

  it('renders command output for migrate import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crowclaw-migrate-'));
    const source = join(root, '.hermes');
    const target = join(root, '.crowclaw');
    await mkdir(join(source, 'skills'), { recursive: true });
    await writeFile(join(source, 'skills', 'ship.md'), '# ship\n', 'utf-8');

    const output = await runMigrateCommand({
      command: 'migrate',
      migrateSubcommand: 'import',
      migrateArgs: [source, '--target', target, '--only', 'skills'],
      dryRun: true,
    });
    expect(output).toContain('Dry run');
    expect(output).toContain('ship.md');
  });
});

// --- Table formatters ---

describe('formatToolsTable', () => {
  it('renders empty state', () => {
    expect(formatToolsTable([])).toBe('No tools registered.');
  });

  it('renders tools with columns', () => {
    const output = formatToolsTable([
      { name: 'read_file', description: 'Read a file', dangerous: false },
      { name: 'exec_cmd', description: 'Execute command', dangerous: true },
    ]);
    expect(output).toContain('read_file');
    expect(output).toContain('exec_cmd');
    expect(output).toContain('Name');
    expect(output).toContain('Description');
    expect(output).toContain('yes');
    expect(output).toContain('no');
  });
});

describe('formatSkillsTable', () => {
  it('renders empty state', () => {
    expect(formatSkillsTable([])).toBe('No skills found.');
  });

  it('renders skills', () => {
    const output = formatSkillsTable([
      { name: 'code-review', enabled: true, triggerCount: 5 },
      { name: 'summarize', enabled: false, triggerCount: 0 },
    ]);
    expect(output).toContain('code-review');
    expect(output).toContain('summarize');
    expect(output).toContain('5');
    expect(output).toContain('disabled');
  });
});

describe('formatSessionsTable', () => {
  it('renders empty state', () => {
    expect(formatSessionsTable([])).toBe('No sessions found.');
  });

  it('renders sessions', () => {
    const output = formatSessionsTable([
      { sessionId: 'abc-123', messageCount: 10, updatedAt: '2025-01-01T00:00:00Z', lastMessage: 'hello' },
    ]);
    expect(output).toContain('abc-123');
    expect(output).toContain('10');
    expect(output).toContain('hello');
  });
});

describe('formatJobsTable', () => {
  it('renders empty state', () => {
    expect(formatJobsTable([])).toBe('No scheduled jobs.');
  });

  it('renders jobs', () => {
    const output = formatJobsTable([
      { id: 'daily-check', schedule: '0 9 * * *', enabled: true, nextRun: '2025-01-02T09:00:00Z' },
    ]);
    expect(output).toContain('daily-check');
    expect(output).toContain('0 9 * * *');
    expect(output).toContain('yes');
  });
});

// --- Default behavior preserved ---

describe('backward compatibility', () => {
  it('no args starts REPL (parsed as repl command)', () => {
    const parsed = parseCliArgs([]);
    expect(parsed.command).toBe('repl');
  });

  it('-q flag still works for one-shot chat', () => {
    const parsed = parseCliArgs(['-q', 'what is 2+2']);
    expect(parsed.command).toBe('chat');
    expect(parsed.query).toBe('what is 2+2');
  });

  it('existing status command works', () => {
    expect(parseCliArgs(['status']).command).toBe('status');
  });

  it('existing tools command works', () => {
    expect(parseCliArgs(['tools']).command).toBe('tools');
  });
});

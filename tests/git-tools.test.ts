import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ToolRegistry,
  createGitStatusTool,
  createGitDiffTool,
  createGitLogTool,
  createGitCommitTool,
  createGitBranchTool,
} from '@crowclaw/tools';

const defaultContext = { agentId: 'crowclaw', sessionId: 'git-test-1' };

// Mock child_process.execFile via the dynamic import
// The tools use `import('node:child_process')` internally, so we mock the module.
vi.mock('node:child_process', () => {
  const execFileMock = vi.fn();
  return {
    exec: vi.fn(),
    execFile: execFileMock,
    spawn: vi.fn(() => ({
      pid: 1234,
      kill: vi.fn(),
      on: vi.fn(),
      unref: vi.fn(),
    })),
    __execFileMock: execFileMock,
  };
});

async function getExecFileMock() {
  const mod = await import('node:child_process') as unknown as { __execFileMock: ReturnType<typeof vi.fn> };
  return mod.__execFileMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('git.status tool', () => {
  it('has correct manifest properties', () => {
    const tool = createGitStatusTool();
    expect(tool.manifest.name).toBe('git.status');
    expect(tool.manifest.dangerLevel).toBe('low');
    expect(tool.manifest.runtime).toBe('worker');
  });

  it('parses porcelain output into structured format', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '## main...origin/main\n M src/index.ts\nA  README.md\n?? dist/\n', '');
    });

    const registry = new ToolRegistry().register(createGitStatusTool());
    const result = await registry.execute('git.status', {}, defaultContext);

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.branch).toBe('main...origin/main');
    expect(parsed.modified).toContain('src/index.ts');
    expect(parsed.staged).toContain('README.md');
    expect(parsed.untracked).toContain('dist/');
  });

  it('handles error when not a git repo', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error('exit code 128'), '', 'fatal: not a git repository');
    });

    const registry = new ToolRegistry().register(createGitStatusTool());
    const result = await registry.execute('git.status', {}, defaultContext);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('not a git repository');
  });

  it('passes working directory path option', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], opts: { cwd?: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(opts.cwd).toBe('/tmp/my-project');
      cb(null, '## main\n', '');
    });

    const registry = new ToolRegistry().register(createGitStatusTool());
    await registry.execute('git.status', { path: '/tmp/my-project' }, defaultContext);
  });
});

describe('git.diff tool', () => {
  it('has correct manifest properties', () => {
    const tool = createGitDiffTool();
    expect(tool.manifest.name).toBe('git.diff');
    expect(tool.manifest.dangerLevel).toBe('low');
  });

  it('constructs correct command with --staged flag', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('--staged');
      cb(null, 'diff --git a/file.ts b/file.ts\n+added line\n', '');
    });

    const registry = new ToolRegistry().register(createGitDiffTool());
    const result = await registry.execute('git.diff', { staged: true }, defaultContext);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('+added line');
  });

  it('constructs correct command with ref', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('HEAD~3');
      cb(null, 'some diff output', '');
    });

    const registry = new ToolRegistry().register(createGitDiffTool());
    await registry.execute('git.diff', { ref: 'HEAD~3' }, defaultContext);
  });

  it('constructs correct command with path filter', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const dashDashIdx = args.indexOf('--');
      expect(dashDashIdx).toBeGreaterThan(0);
      expect(args[dashDashIdx + 1]).toBe('src/main.ts');
      cb(null, '', '');
    });

    const registry = new ToolRegistry().register(createGitDiffTool());
    await registry.execute('git.diff', { path: 'src/main.ts' }, defaultContext);
  });

  it('returns "(no changes)" when diff is empty', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '', '');
    });

    const registry = new ToolRegistry().register(createGitDiffTool());
    const result = await registry.execute('git.diff', {}, defaultContext);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('(no changes)');
  });
});

describe('git.log tool', () => {
  it('has correct manifest properties', () => {
    const tool = createGitLogTool();
    expect(tool.manifest.name).toBe('git.log');
    expect(tool.manifest.dangerLevel).toBe('low');
  });

  it('defaults to 10 commits', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('-10');
      cb(null, 'abc1234 feat: add feature (Author, 1 day ago)\ndef5678 fix: bug fix (Author, 2 days ago)\n', '');
    });

    const registry = new ToolRegistry().register(createGitLogTool());
    const result = await registry.execute('git.log', {}, defaultContext);

    expect(result.ok).toBe(true);
    expect(result.metadata?.count).toBe(10);
    expect(result.output).toContain('feat: add feature');
  });

  it('respects count parameter', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('-5');
      cb(null, 'some log output', '');
    });

    const registry = new ToolRegistry().register(createGitLogTool());
    const result = await registry.execute('git.log', { count: 5 }, defaultContext);
    expect(result.metadata?.count).toBe(5);
  });

  it('uses --oneline when requested', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('--oneline');
      cb(null, 'abc1234 feat: something\n', '');
    });

    const registry = new ToolRegistry().register(createGitLogTool());
    await registry.execute('git.log', { oneline: true }, defaultContext);
  });

  it('filters by file path', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const dashDashIdx = args.indexOf('--');
      expect(dashDashIdx).toBeGreaterThan(0);
      expect(args[dashDashIdx + 1]).toBe('package.json');
      cb(null, 'log output for package.json', '');
    });

    const registry = new ToolRegistry().register(createGitLogTool());
    await registry.execute('git.log', { path: 'package.json' }, defaultContext);
  });

  it('handles error from git log', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error('git error'), '', 'fatal: not a git repository');
    });

    const registry = new ToolRegistry().register(createGitLogTool());
    const result = await registry.execute('git.log', {}, defaultContext);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('not a git repository');
  });
});

describe('git.commit tool', () => {
  it('has dangerLevel medium', () => {
    const tool = createGitCommitTool();
    expect(tool.manifest.name).toBe('git.commit');
    expect(tool.manifest.dangerLevel).toBe('medium');
    expect(tool.manifest.stateful).toBe(true);
  });

  it('requires a commit message', async () => {
    const registry = new ToolRegistry().register(createGitCommitTool());
    const result = await registry.execute('git.commit', { message: '' }, defaultContext);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing commit message');
  });

  it('stages specific files then commits', async () => {
    const execFileMock = await getExecFileMock();
    const calls: string[][] = [];

    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.push([...args]);
      if (args[0] === 'add') {
        cb(null, '', '');
      } else if (args[0] === 'commit') {
        cb(null, '[main abc1234] feat: new feature\n 1 file changed', '');
      } else {
        cb(null, '', '');
      }
    });

    const registry = new ToolRegistry().register(createGitCommitTool());
    const result = await registry.execute(
      'git.commit',
      { message: 'feat: new feature', files: ['src/index.ts', 'README.md'] },
      defaultContext
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toEqual(['add', 'src/index.ts', 'README.md']);
    expect(calls[1]).toEqual(['commit', '-m', 'feat: new feature']);
    expect(result.metadata?.message).toBe('feat: new feature');
  });

  it('stages all with -A flag when all=true', async () => {
    const execFileMock = await getExecFileMock();
    const calls: string[][] = [];

    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.push([...args]);
      cb(null, args[0] === 'commit' ? '[main abc] chore: stuff' : '', '');
    });

    const registry = new ToolRegistry().register(createGitCommitTool());
    await registry.execute('git.commit', { message: 'chore: stuff', all: true }, defaultContext);

    expect(calls[0]).toEqual(['add', '-A']);
    expect(calls[1]).toEqual(['commit', '-m', 'chore: stuff']);
  });

  it('returns error when staging fails', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'add') {
        cb(new Error('staging failed'), '', 'pathspec not found');
      } else {
        cb(null, '', '');
      }
    });

    const registry = new ToolRegistry().register(createGitCommitTool());
    const result = await registry.execute(
      'git.commit',
      { message: 'test', files: ['nonexistent.ts'] },
      defaultContext
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Failed to stage files');
  });

  it('returns error when commit fails', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] === 'commit') {
        cb(new Error('nothing to commit'), '', 'nothing to commit, working tree clean');
      } else {
        cb(null, '', '');
      }
    });

    const registry = new ToolRegistry().register(createGitCommitTool());
    const result = await registry.execute(
      'git.commit',
      { message: 'test', all: true },
      defaultContext
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('nothing to commit');
  });
});

describe('git.branch tool', () => {
  it('has correct manifest properties', () => {
    const tool = createGitBranchTool();
    expect(tool.manifest.name).toBe('git.branch');
    expect(tool.manifest.dangerLevel).toBe('low');
  });

  it('lists branches when no name provided', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toContain('--list');
      cb(null, '* main\n  feature/foo\n  develop\n', '');
    });

    const registry = new ToolRegistry().register(createGitBranchTool());
    const result = await registry.execute('git.branch', {}, defaultContext);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('main');
    expect(result.output).toContain('feature/foo');
  });

  it('creates a branch without checkout', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toEqual(['branch', 'feature/new']);
      cb(null, '', '');
    });

    const registry = new ToolRegistry().register(createGitBranchTool());
    const result = await registry.execute('git.branch', { name: 'feature/new' }, defaultContext);

    expect(result.ok).toBe(true);
    expect(result.output).toContain('feature/new');
    expect(result.output).toContain('created');
  });

  it('creates and checks out a branch when checkout=true', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(args).toEqual(['checkout', '-b', 'feature/checkout']);
      cb(null, "Switched to a new branch 'feature/checkout'", '');
    });

    const registry = new ToolRegistry().register(createGitBranchTool());
    const result = await registry.execute(
      'git.branch',
      { name: 'feature/checkout', checkout: true },
      defaultContext
    );

    expect(result.ok).toBe(true);
    expect(result.metadata?.checkout).toBe(true);
  });

  it('handles error when branch already exists', async () => {
    const execFileMock = await getExecFileMock();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(new Error('branch exists'), '', "fatal: a branch named 'main' already exists");
    });

    const registry = new ToolRegistry().register(createGitBranchTool());
    const result = await registry.execute('git.branch', { name: 'main' }, defaultContext);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('already exists');
  });
});

describe('git tools registration', () => {
  it('all git tools register in a ToolRegistry', () => {
    const registry = new ToolRegistry();
    registry.register(createGitStatusTool());
    registry.register(createGitDiffTool());
    registry.register(createGitLogTool());
    registry.register(createGitCommitTool());
    registry.register(createGitBranchTool());

    const names = registry.list().map((m) => m.name);
    expect(names).toContain('git.status');
    expect(names).toContain('git.diff');
    expect(names).toContain('git.log');
    expect(names).toContain('git.commit');
    expect(names).toContain('git.branch');
  });

  it('git.commit is the only one with dangerLevel medium', () => {
    const tools = [
      createGitStatusTool(),
      createGitDiffTool(),
      createGitLogTool(),
      createGitCommitTool(),
      createGitBranchTool(),
    ];

    const mediumDanger = tools.filter((t) => t.manifest.dangerLevel === 'medium');
    expect(mediumDanger).toHaveLength(1);
    expect(mediumDanger[0]!.manifest.name).toBe('git.commit');
  });
});

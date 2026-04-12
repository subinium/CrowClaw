import { describe, expect, it } from 'vitest';
import { LocalProcessExecutor, DockerExecutor, createAutoExecutor, CloudflareSandboxExecutor } from '@crowclaw/sandbox-executor';

describe('LocalProcessExecutor', () => {
  it('executes a simple command', async () => {
    const executor = new LocalProcessExecutor();
    const result = await executor.executeCommand('echo hello');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const executor = new LocalProcessExecutor();
    const result = await executor.executeCommand('echo error >&2');

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('error');
  });

  it('returns non-zero exit code for failing commands', async () => {
    const executor = new LocalProcessExecutor();
    const result = await executor.executeCommand('exit 42');

    expect(result.exitCode).toBe(42);
  });

  it('handles timeout', async () => {
    const executor = new LocalProcessExecutor({ defaultTimeoutMs: 500 });
    const result = await executor.executeCommand('sleep 10');

    expect(result.timedOut).toBe(true);
  });

  it('supports cwd option', async () => {
    const executor = new LocalProcessExecutor();
    const result = await executor.executeCommand('pwd', '/tmp');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/tmp|\/private\/tmp/);
  });

  it('handles command errors gracefully', async () => {
    const executor = new LocalProcessExecutor();
    const result = await executor.executeCommand('nonexistent_command_xyz_123');

    expect(result.exitCode).not.toBe(0);
  });
});

describe('DockerExecutor', () => {
  it('constructs docker run command correctly', async () => {
    // DockerExecutor delegates to LocalProcessExecutor internally.
    // We can't easily test actual Docker execution without Docker,
    // but we can verify it constructs and attempts to run the command.
    const executor = new DockerExecutor({
      image: 'alpine:latest',
      memoryLimit: '256m',
      cpuLimit: '0.5',
      networkMode: 'none'
    });

    // This will fail because Docker isn't necessarily available in test env
    const result = await executor.executeCommand('echo test');
    // We just verify it doesn't crash and returns a result
    expect(result).toHaveProperty('exitCode');
    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('stderr');
  });
});

describe('createAutoExecutor', () => {
  it('returns LocalProcessExecutor when no sandbox binding', () => {
    const executor = createAutoExecutor({
      agentId: 'test',
      sessionId: 'test-session'
    });
    expect(executor).toBeInstanceOf(LocalProcessExecutor);
  });

  it('returns CloudflareSandboxExecutor when sandbox binding exists', () => {
    const executor = createAutoExecutor({
      agentId: 'test',
      sessionId: 'test-session',
      env: { Sandbox: {} }
    });
    expect(executor).toBeInstanceOf(CloudflareSandboxExecutor);
  });
});

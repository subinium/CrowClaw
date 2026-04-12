import { describe, expect, it } from 'vitest';
import { SshExecutor } from '@crowclaw/sandbox-executor';

describe('SshExecutor', () => {
  it('constructs with proper options', () => {
    const executor = new SshExecutor({
      host: 'example.com',
      user: 'deploy',
      port: 2222,
      identityFile: '~/.ssh/id_rsa',
      strictHostKeyChecking: false
    });

    // Can't test real SSH without a server, but verify it doesn't throw on construction
    expect(executor).toBeDefined();
  });

  it('handles connection failure gracefully', async () => {
    const executor = new SshExecutor({
      host: '192.0.2.1', // RFC 5737 TEST-NET, won't connect
      defaultTimeoutMs: 1000,
      strictHostKeyChecking: false
    });

    const result = await executor.executeCommand('echo test');
    // Should fail (timeout or connection refused) but not crash
    expect(result.exitCode).not.toBe(0);
  });
});

import { spawn } from 'node:child_process';
import type { SandboxClient, SandboxCommandResult } from './index.js';

export interface SshExecutorOptions {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  defaultTimeoutMs?: number;
  strictHostKeyChecking?: boolean;
}

export class SshExecutor implements SandboxClient {
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: SshExecutorOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  async executeCommand(
    command: string,
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const remoteCommand = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command;

    const sshArgs: string[] = [];

    if (this.options.port) {
      sshArgs.push('-p', String(this.options.port));
    }
    if (this.options.identityFile) {
      sshArgs.push('-i', this.options.identityFile);
    }
    if (this.options.strictHostKeyChecking === false) {
      sshArgs.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null');
    }

    // Connection timeout
    sshArgs.push('-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`);

    const target = this.options.user
      ? `${this.options.user}@${this.options.host}`
      : this.options.host;

    sshArgs.push(target, remoteCommand);

    return new Promise<SandboxCommandResult>((resolve) => {
      const child = spawn('ssh', sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const MAX_OUTPUT = 50 * 1024;

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += data.toString('utf-8').slice(0, MAX_OUTPUT - stdout.length);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT) {
          stderr += data.toString('utf-8').slice(0, MAX_OUTPUT - stderr.length);
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: `SSH error: ${error.message}`,
          exitCode: 1,
          timedOut: false
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
      });
    });
  }
}

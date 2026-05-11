/**
 * v0.9.0 Hermes parity #332: `crowclaw -z "<prompt>"` one-shot mode.
 * Mirrors `tests/cli-batch.test.ts` — uses a mock runtime to exercise the
 * argument parser and the runtime fetch contract without spinning up a
 * real provider.
 */

import { describe, expect, it } from 'vitest';
import {
  parseCliArgs,
  runOneshot,
  type CliRuntimeLike,
} from '@crowclaw/cli';

// --- Argument parsing ---

describe('CLI -z parsing (#332)', () => {
  it('parses `-z "hello"` as oneshot with prompt', () => {
    const parsed = parseCliArgs(['-z', 'hello']);
    expect(parsed.command).toBe('oneshot');
    expect(parsed.oneshotPrompt).toBe('hello');
  });

  it('parses bare `-z` as oneshot with no prompt (stdin will be read)', () => {
    const parsed = parseCliArgs(['-z']);
    expect(parsed.command).toBe('oneshot');
    expect(parsed.oneshotPrompt).toBeUndefined();
  });

  it('parses `--model` override', () => {
    const parsed = parseCliArgs(['-z', 'hi', '--model', 'gpt-4o']);
    expect(parsed.oneshotModel).toBe('gpt-4o');
  });

  it('parses `--provider` override', () => {
    const parsed = parseCliArgs(['-z', 'hi', '--provider', 'openrouter']);
    expect(parsed.oneshotProvider).toBe('openrouter');
  });

  it('parses combined flags', () => {
    const parsed = parseCliArgs(['-z', 'hello', '--model', 'x', '--provider', 'y']);
    expect(parsed.command).toBe('oneshot');
    expect(parsed.oneshotPrompt).toBe('hello');
    expect(parsed.oneshotModel).toBe('x');
    expect(parsed.oneshotProvider).toBe('y');
  });
});

// --- runOneshot integration with mock runtime ---

function createMockRuntime(handler?: (msg: string) => string): CliRuntimeLike {
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
        const body = (await request.json()) as { userMessage?: string };
        const userMessage = body.userMessage ?? '';
        const finalResponse = handler ? handler(userMessage) : `echo: ${userMessage}`;
        return Response.json({
          finalResponse,
          toolResults: [],
          session: { sessionId: url.pathname.split('/')[3] ?? 'oneshot', messages: [] },
        });
      }
      return new Response('{}', { status: 200 });
    },
  };
}

describe('runOneshot (#332)', () => {
  it('returns the final response for a literal prompt', async () => {
    const runtime = createMockRuntime();
    const result = await runOneshot(runtime, { prompt: 'echo hi' });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('echo: echo hi');
  });

  it('reads stdin when no prompt is supplied', async () => {
    const runtime = createMockRuntime();
    const result = await runOneshot(runtime, {
      readStdin: async () => 'summarize this\n',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('echo: summarize this');
  });

  it('returns exit 1 with usage when both prompt and stdin are empty', async () => {
    const runtime = createMockRuntime();
    const result = await runOneshot(runtime, {
      readStdin: async () => '',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/usage:/);
  });

  it('returns exit 1 when runtime returns non-OK', async () => {
    const runtime: CliRuntimeLike = {
      async fetch() {
        return new Response('boom', { status: 500, statusText: 'Internal Error' });
      },
    };
    const result = await runOneshot(runtime, { prompt: 'x' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/session POST failed/);
  });

  it('returns exit 1 when runtime throws', async () => {
    const runtime: CliRuntimeLike = {
      async fetch() {
        throw new Error('network down');
      },
    };
    const result = await runOneshot(runtime, { prompt: 'x' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/network down/);
  });

  it('applies model override into env', async () => {
    const runtime = createMockRuntime();
    delete process.env.OPENROUTER_MODEL;
    delete process.env.CROWCLAW_MODEL;
    await runOneshot(runtime, { prompt: 'hi', model: 'test-model' });
    expect(process.env.OPENROUTER_MODEL).toBe('test-model');
    expect(process.env.CROWCLAW_MODEL).toBe('test-model');
    delete process.env.OPENROUTER_MODEL;
    delete process.env.CROWCLAW_MODEL;
  });

  it('applies provider override into env', async () => {
    const runtime = createMockRuntime();
    delete process.env.CROWCLAW_PROVIDER;
    await runOneshot(runtime, { prompt: 'hi', provider: 'test-provider' });
    expect(process.env.CROWCLAW_PROVIDER).toBe('test-provider');
    delete process.env.CROWCLAW_PROVIDER;
  });
});

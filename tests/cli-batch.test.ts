import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCliArgs,
  renderCliHelp,
  runBatchCommand,
  type CliRuntimeLike,
} from '@crowclaw/cli';

// --- Argument parsing ---

describe('CLI batch parsing (#272)', () => {
  it('parses "batch <file>"', () => {
    const parsed = parseCliArgs(['batch', 'prompts.jsonl']);
    expect(parsed.command).toBe('batch');
    expect(parsed.batchInput).toBe('prompts.jsonl');
    expect(parsed.batchEval).toBe(false);
    expect(parsed.batchThreshold).toBeUndefined();
  });

  it('parses --eval flag', () => {
    const parsed = parseCliArgs(['batch', 'p.jsonl', '--eval']);
    expect(parsed.command).toBe('batch');
    expect(parsed.batchEval).toBe(true);
  });

  it('parses --threshold N as a number', () => {
    const parsed = parseCliArgs(['batch', 'p.jsonl', '--eval', '--threshold', '0.8']);
    expect(parsed.batchEval).toBe(true);
    expect(parsed.batchThreshold).toBe(0.8);
  });

  it('parses --out, --run-name, --concurrency, --max-turns, --timeout-ms, --resume-from', () => {
    const parsed = parseCliArgs([
      'batch',
      'p.jsonl',
      '--out', '/tmp/out.json',
      '--run-name', 'eval-run',
      '--concurrency', '4',
      '--max-turns', '6',
      '--timeout-ms', '30000',
      '--resume-from', 'p2',
    ]);
    expect(parsed.batchOut).toBe('/tmp/out.json');
    expect(parsed.batchRunName).toBe('eval-run');
    expect(parsed.batchConcurrency).toBe(4);
    expect(parsed.batchMaxTurns).toBe(6);
    expect(parsed.batchTimeoutMs).toBe(30000);
    expect(parsed.batchResumeFromId).toBe('p2');
  });

  it('renderCliHelp mentions the batch command', () => {
    const help = renderCliHelp();
    expect(help).toContain('batch');
    expect(help).toContain('--eval');
  });
});

// --- runBatchCommand integration with a mock runtime ---

interface MockRuntimeOptions {
  responseFor?: (userMessage: string) => string;
}

function createMockRuntime(options: MockRuntimeOptions = {}): CliRuntimeLike {
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);
      // POST /api/sessions/:id — message action
      if (request.method === 'POST' && url.pathname.startsWith('/api/sessions/')) {
        const body = (await request.json()) as { userMessage?: string };
        const userMessage = body.userMessage ?? '';
        const finalResponse = options.responseFor?.(userMessage) ?? `echo: ${userMessage}`;
        return Response.json({
          finalResponse,
          toolResults: [],
          session: {
            sessionId: url.pathname.split('/')[3] ?? 'unknown',
            messages: [
              { role: 'user', content: userMessage, createdAt: '2026-01-01T00:00:00Z' },
              { role: 'assistant', content: finalResponse, createdAt: '2026-01-01T00:00:01Z' },
            ],
          },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

async function writeJsonl(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crowclaw-batch-'));
  const path = join(dir, 'prompts.jsonl');
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return path;
}

describe('runBatchCommand (#272)', () => {
  it('returns usage and exit 1 when input is missing', async () => {
    const runtime = createMockRuntime();
    const result = await runBatchCommand(runtime, { command: 'batch' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('usage:');
  });

  it('runs without --eval and exits 0 even when no expected fields exist', async () => {
    const path = await writeJsonl([
      { id: 'p1', prompt: 'hello' },
      { id: 'p2', prompt: 'world' },
    ]);
    const runtime = createMockRuntime();
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: path,
      batchRunName: 'no-eval',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Run: no-eval');
    expect(result.output).toContain('Total: 2');
    expect(result.output).not.toContain('Accuracy:');
  });

  it('with --eval: accuracy 100% passes the default threshold (1.0)', async () => {
    const path = await writeJsonl([
      { id: 'p1', prompt: 'capital of france', expected: { contains: 'Paris' } },
    ]);
    const runtime = createMockRuntime({
      responseFor: () => 'The capital of France is Paris.',
    });
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: path,
      batchEval: true,
      batchRunName: 'eval-pass',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Accuracy: 100%');
    expect(result.output).toContain('threshold 1');
  });

  it('with --eval: accuracy below default threshold exits 1', async () => {
    const path = await writeJsonl([
      { id: 'p1', prompt: 'capital of france', expected: { contains: 'Paris' } },
      { id: 'p2', prompt: 'capital of germany', expected: { contains: 'Berlin' } },
    ]);
    const runtime = createMockRuntime({
      // p1 passes (response contains "Paris"), p2 fails (no "Berlin").
      responseFor: (msg) => (msg.includes('france') ? 'Paris is the capital.' : 'Munich is wrong.'),
    });
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: path,
      batchEval: true,
      batchRunName: 'eval-fail',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Accuracy: 50%');
    expect(result.output).toContain('Failures (1)');
    expect(result.output).toContain('p2');
  });

  it('with --eval and --threshold 0.5: 50% accuracy passes', async () => {
    const path = await writeJsonl([
      { id: 'p1', prompt: 'q1', expected: 'Paris' },
      { id: 'p2', prompt: 'q2', expected: 'Berlin' },
    ]);
    const runtime = createMockRuntime({
      responseFor: (msg) => (msg === 'q1' ? 'answer is Paris' : 'wrong'),
    });
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: path,
      batchEval: true,
      batchThreshold: 0.5,
      batchRunName: 'threshold-pass',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Accuracy: 50%');
  });

  it('with --eval but no expected field on any prompt: exits 1 with explanatory message', async () => {
    const path = await writeJsonl([
      { id: 'p1', prompt: 'no-expected' },
    ]);
    const runtime = createMockRuntime();
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: path,
      batchEval: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('no prompts had `expected`');
  });

  it('reports a clear error when input file does not exist', async () => {
    const runtime = createMockRuntime();
    const result = await runBatchCommand(runtime, {
      command: 'batch',
      batchInput: '/nonexistent/path/to.jsonl',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('failed to read');
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  CLI_EXIT_CODE,
  CliTimeoutError,
  CliUserCancelError,
  exitCodeForError,
  renderCliHelp,
  validateProviderCredentials,
  type CliRuntimeLike,
} from '../packages/cli/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

// --------------------------------------------------------------------------
// Issue #149 — validateProviderCredentials actually hits the provider
// --------------------------------------------------------------------------

describe('validateProviderCredentials (#149)', () => {
  it('treats HTTP 200 from /models as accepted (OpenAI)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models');
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      expect(headers.get('authorization')).toBe('Bearer sk-test-key');
      return new Response('{"data": []}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await validateProviderCredentials({
      provider: 'openai',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('uses x-api-key + anthropic-version for Anthropic', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/models');
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      expect(headers.get('x-api-key')).toBe('sk-ant-test');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('authorization')).toBeNull();
      return new Response('{"data": []}', { status: 200 });
    });

    const result = await validateProviderCredentials({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects HTTP 401 with status + message', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Invalid API key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));

    const result = await validateProviderCredentials({
      provider: 'openai',
      apiKey: 'wrong',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain('401');
    expect(result.message).toContain('Invalid API key');
  });

  it('treats non-401 4xx/5xx as accepted (per task spec)', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));

    const result = await validateProviderCredentials({
      provider: 'custom',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(403);
  });

  it('returns ok:false with status 0 on network failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });

    const result = await validateProviderCredentials({
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toContain('fetch failed');
  });

  it('rejects empty API key without making a request', async () => {
    const fetchMock = vi.fn();
    const result = await validateProviderCredentials({
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts on timeout and reports as transport error', async () => {
    // Simulate a fetch that respects AbortSignal.
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
            return;
          }
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const result = await validateProviderCredentials({
      provider: 'openai',
      apiKey: 'k',
      baseUrl: 'https://api.openai.com/v1',
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.message).toContain('timed out');
  });
});

// --------------------------------------------------------------------------
// Issue #150 — CliRuntimeLike.close() typing
// --------------------------------------------------------------------------

describe('CliRuntimeLike.close (#150)', () => {
  it('accepts a runtime that defines close()', () => {
    // Compile-time check: assignment must succeed without `any`.
    const runtime: CliRuntimeLike = {
      fetch: async () => new Response(null),
      close: () => {
        /* no-op */
      },
    };
    expect(typeof runtime.close).toBe('function');
  });

  it('accepts an async close()', () => {
    const runtime: CliRuntimeLike = {
      fetch: async () => new Response(null),
      close: async () => Promise.resolve(),
    };
    expect(typeof runtime.close).toBe('function');
  });

  it('accepts a runtime without close()', () => {
    const runtime: CliRuntimeLike = {
      fetch: async () => new Response(null),
    };
    expect(runtime.close).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Issue #143 — help docs + distinct exit codes
// --------------------------------------------------------------------------

describe('renderCliHelp session actions + exit codes (#143)', () => {
  it('documents the Session actions (REST) block', () => {
    const help = renderCliHelp();
    expect(help).toContain('Session actions (REST)');
    expect(help).toContain('/api/sessions/<id>/stop');
    expect(help).toContain('/api/sessions/<id>/steer');
    expect(help).toContain('/api/sessions/<id>/compact');
    expect(help).toContain('fork');
  });

  it('documents distinct exit codes 0/1/2/3', () => {
    const help = renderCliHelp();
    expect(help).toContain('Exit codes');
    expect(help).toMatch(/0\s+success/);
    expect(help).toMatch(/1\s+internal error/);
    expect(help).toMatch(/2\s+user-cancel/);
    expect(help).toMatch(/3\s+timeout/);
  });
});

describe('exitCodeForError (#143)', () => {
  it('returns 0/1/2/3 constants', () => {
    expect(CLI_EXIT_CODE.SUCCESS).toBe(0);
    expect(CLI_EXIT_CODE.ERROR).toBe(1);
    expect(CLI_EXIT_CODE.USER_CANCEL).toBe(2);
    expect(CLI_EXIT_CODE.TIMEOUT).toBe(3);
  });

  it('maps CliUserCancelError to 2', () => {
    expect(exitCodeForError(new CliUserCancelError())).toBe(2);
  });

  it('maps CliTimeoutError to 3', () => {
    expect(exitCodeForError(new CliTimeoutError())).toBe(3);
  });

  it('maps generic Error to 1', () => {
    expect(exitCodeForError(new Error('boom'))).toBe(1);
  });

  it('maps AbortError to 2 (user-cancel)', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(exitCodeForError(err)).toBe(2);
  });

  it('maps TimeoutError to 3', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(exitCodeForError(err)).toBe(3);
  });

  it('maps non-Error values to 1', () => {
    expect(exitCodeForError('string error')).toBe(1);
    expect(exitCodeForError(undefined)).toBe(1);
    expect(exitCodeForError(null)).toBe(1);
  });
});

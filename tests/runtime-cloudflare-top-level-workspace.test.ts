import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare top-level workspace routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards top-level workspace read/list/exists routes', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const list = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace?prefix=src/'), env as never);
    expect((await list.json() as { forwardedTo: string }).forwardedTo).toContain('/workspace?prefix=src/');

    const queryRead = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace?path=src/app.ts'), env as never);
    expect((await queryRead.json() as { forwardedTo: string }).forwardedTo).toContain('/workspace?path=src/app.ts');

    const pathRead = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/src/app.ts'), env as never);
    expect((await pathRead.json() as { forwardedTo: string }).forwardedTo).toContain('/workspace/src/app.ts');

    const exists = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/exists?path=src/app.ts'), env as never);
    expect((await exists.json() as { forwardedTo: string }).forwardedTo).toContain('/workspace/exists?path=src/app.ts');
  });

  it('forwards top-level workspace mutation routes', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const write = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', content: 'alpha' })
    }), env as never);
    expect((await write.json() as { forwardedTo: string; body: { path: string } }).forwardedTo).toContain('/workspace/write');

    const patchText = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/patch-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', replacements: [{ from: 'alpha', to: 'ALPHA' }] })
    }), env as never);
    expect((await patchText.json() as { forwardedTo: string }).forwardedTo).toContain('/workspace/patch-text');

    const rename = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromPath: 'src/app.ts', toPath: 'src/main.ts' })
    }), env as never);
    expect((await rename.json() as { forwardedTo: string; body: { fromPath: string; toPath: string } }).forwardedTo).toContain('/workspace/rename');

    const remove = await runtimeCloudflare.fetch(new Request('https://example.com/api/workspace/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/main.ts' })
    }), env as never);
    expect((await remove.json() as { forwardedTo: string; body: { path: string } }).forwardedTo).toContain('/workspace/delete');
  });
});

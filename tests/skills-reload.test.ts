/**
 * v0.9.0 Hermes parity #333: `/reload-skills` slash command.
 *
 * Tests the CLI-side `reloadSkills(runtime)` helper. The runtime-side route
 * is implemented in `packages/runtime-node/src/route-handlers.ts` but a
 * full end-to-end test would require booting the node runtime; here we
 * verify the request shape against a mock runtime and that the parsed
 * response surfaces the new stats.
 */

import { describe, expect, it } from 'vitest';
import { reloadSkills, formatReloadSkillsResult, type CliRuntimeLike } from '@crowclaw/cli';

function createMock(handler: (request: Request) => Response | Promise<Response>): CliRuntimeLike {
  return {
    async fetch(request: Request) {
      return handler(request);
    },
  };
}

describe('reloadSkills (#333)', () => {
  it('hits POST /api/skills/reload', async () => {
    let seenMethod = '';
    let seenPath = '';
    const runtime = createMock(async (request) => {
      seenMethod = request.method;
      seenPath = new URL(request.url).pathname;
      return Response.json({ ok: true, builtin: 2, learned: 3, local: 1, installed: 1, total: 6 });
    });
    const result = await reloadSkills(runtime);
    expect(seenMethod).toBe('POST');
    expect(seenPath).toBe('/api/skills/reload');
    expect(result.ok).toBe(true);
    expect(result.builtin).toBe(2);
    expect(result.learned).toBe(3);
    expect(result.local).toBe(1);
    expect(result.installed).toBe(1);
    expect(result.total).toBe(6);
  });

  it('surfaces 404 with an upgrade hint', async () => {
    const runtime = createMock(async () => new Response('not found', { status: 404 }));
    const result = await reloadSkills(runtime);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/upgrade.*v0\.9\.0/);
  });

  it('surfaces non-OK responses cleanly', async () => {
    const runtime = createMock(async () => new Response('boom', { status: 500, statusText: 'Internal' }));
    const result = await reloadSkills(runtime);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it('surfaces fetch throws as a reload error', async () => {
    const runtime: CliRuntimeLike = {
      async fetch() {
        throw new Error('connection refused');
      },
    };
    const result = await reloadSkills(runtime);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection refused/);
  });

  it('returns ok:false when body has ok:false', async () => {
    const runtime = createMock(async () => Response.json({ ok: false, error: 'registry locked' }));
    const result = await reloadSkills(runtime);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/registry locked/);
  });

  it('formatReloadSkillsResult summarizes stats', () => {
    const text = formatReloadSkillsResult({
      ok: true,
      builtin: 1,
      learned: 2,
      local: 0,
      installed: 0,
      total: 3,
    });
    expect(text).toContain('Skills reloaded');
    expect(text).toContain('builtin');
    expect(text).toContain('learned');
    expect(text).toContain('total');
  });

  it('formatReloadSkillsResult shows error on failure', () => {
    const text = formatReloadSkillsResult({ ok: false, error: 'x' });
    expect(text).toMatch(/reload failed/);
  });
});

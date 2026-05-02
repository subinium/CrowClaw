import { describe, expect, it, vi } from 'vitest';
import { AtroposEnv, defaultAtroposReward } from '@crowclaw/learning';
import type { TrajectoryEntry } from '@crowclaw/learning';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('AtroposEnv', () => {
  it('registers, fetches prompts, and submits rollout completions', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({
        url: String(url),
        body,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      if (String(url).endsWith('/get_batch')) {
        return jsonResponse({ prompts: [{ prompt_id: 'p1', prompt: 'Solve it', metadata: { topic: 'math' } }] });
      }
      return jsonResponse({ ok: true });
    });
    const env = new AtroposEnv({
      baseUrl: 'https://atropos.local/',
      environment: 'crowclaw',
      apiKey: 'secret',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await env.register({ version: 'test' });
    const prompts = await env.getBatch(2);
    await env.submitRollout({ promptId: prompts[0]!.id, prompt: prompts[0]!.prompt, response: 'Done', reward: 0.75 });

    expect(prompts).toEqual([{ id: 'p1', prompt: 'Solve it', metadata: { topic: 'math' } }]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://atropos.local/register_environment',
      'https://atropos.local/get_batch',
      'https://atropos.local/batch_completions',
    ]);
    expect(calls.every((call) => call.auth === 'Bearer secret')).toBe(true);
    expect((calls[2]!.body.completions as Array<Record<string, unknown>>)[0]?.reward).toBe(0.75);
  });

  it('raises useful errors for Atropos endpoint failures', async () => {
    const env = new AtroposEnv({
      baseUrl: 'https://atropos.local',
      environment: 'crowclaw',
      fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch,
    });

    await expect(env.getBatch()).rejects.toThrow('Atropos /get_batch failed with 503');
  });

  it('uses trajectory scoring as the default reward adapter', () => {
    const trajectory: TrajectoryEntry = {
      id: 't1',
      prompt: 'hi',
      response: 'done',
      turns: [
        { role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'done', timestamp: '2026-01-01T00:00:01Z' },
      ],
      toolUsage: [],
      metadata: { sessionId: 's1', durationMs: 1, ok: true },
    };
    expect(defaultAtroposReward(trajectory)).toBeGreaterThan(0.8);
  });
});

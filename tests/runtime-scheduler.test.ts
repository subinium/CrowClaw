import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('runtime scheduler integration', () => {
  it('creates, lists, and ticks scheduler jobs in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const create = await runtime.fetch(new Request('http://localhost/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'job-1', everyMinutes: 5, task: 'sync memories' })
    }));
    expect((await create.json() as { id: string }).id).toBe('job-1');

    const list = await runtime.fetch(new Request('http://localhost/api/scheduler/jobs'));
    const jobs = await list.json() as Array<{ id: string }>;
    expect(jobs).toHaveLength(1);

    const tick = await runtime.fetch(new Request('http://localhost/api/scheduler/tick', {
      method: 'POST'
    }));
    const tickPayload = await tick.json() as { ok: boolean; results: unknown[] };
    expect(tickPayload.ok).toBe(true);
    expect(Array.isArray(tickPayload.results)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('runtime learning integration', () => {
  it('captures, auto-captures, lists, matches, and publishes learning drafts in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const create = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Deploy CrowClaw',
        messages: [
          { role: 'user', content: 'deploy crowclaw' },
          { role: 'assistant', content: 'done and completed' }
        ]
      })
    }));
    const created = await create.json() as { id: string; status: string; title: string };
    expect(created.status).toBe('draft');
    expect(created.title).toBe('Deploy CrowClaw');

    const autoCapture = await runtime.fetch(new Request('http://localhost/api/learning/auto-capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Auto CrowClaw Draft',
        messages: [
          { role: 'user', content: 'deploy crowclaw' },
          { role: 'assistant', content: 'all done and task complete' }
        ]
      })
    }));
    const autoPayload = await autoCapture.json() as { title: string } | null;
    expect(autoPayload).not.toBeNull();
    expect((autoPayload as { title: string }).title).toBe('Auto CrowClaw Draft');

    const list = await runtime.fetch(new Request('http://localhost/api/learning/drafts'));
    const drafts = await list.json() as Array<{ id: string }>;
    expect(drafts.length).toBeGreaterThanOrEqual(2);

    const publish = await runtime.fetch(new Request(`http://localhost/api/learning/drafts/${created.id}`, {
      method: 'POST'
    }));
    const published = await publish.json() as { status: string };
    expect(published.status).toBe('published');

    const match = await runtime.fetch(new Request('http://localhost/api/learning/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'deploy crowclaw', limit: 5 })
    }));
    const matches = await match.json() as Array<{ skill: { title: string } }>;
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

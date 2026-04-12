import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

describe('runtime action tools integration', () => {
  it('supports todo, clarify, and send-message routes in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const add = await runtime.fetch(new Request(localRoute(routePaths.actions.todo), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'todo-route-1', action: 'add', text: 'ship crowclaw' })
    }));
    const addPayload = await add.json() as { ok: boolean; output: string };
    expect(addPayload.ok).toBe(true);
    const created = JSON.parse(addPayload.output) as { id: string };

    const list = await runtime.fetch(new Request(localRoute(routePaths.actions.todo), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'todo-route-1', action: 'list' })
    }));
    expect((await list.json() as { output: string }).output).toContain('ship crowclaw');

    const done = await runtime.fetch(new Request(localRoute(routePaths.actions.todo), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'todo-route-1', action: 'complete', id: created.id })
    }));
    expect((await done.json() as { output: string }).output).toContain('"done": true');

    const clarify = await runtime.fetch(new Request(localRoute(routePaths.actions.clarify), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'deployment' })
    }));
    expect((await clarify.json() as { output: string }).output).toContain('deployment');

    const send = await runtime.fetch(new Request(localRoute(routePaths.actions.sendMessage), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'slack', channel: 'C123', text: 'hello team' })
    }));
    expect((await send.json() as { output: string }).output).toContain('"platform": "slack"');
  });
});

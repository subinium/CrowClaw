import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

describe('runtime terminal integration', () => {
  it('supports terminal exec/background/processes/kill routes in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const execResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'printf "hello-terminal"' })
    }));
    const execPayload = await execResponse.json() as { ok: boolean; output: string };
    expect(execPayload.ok).toBe(true);
    expect(execPayload.output).toContain('hello-terminal');

    const backgroundResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.background), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'sleep 5' })
    }));
    const backgroundPayload = await backgroundResponse.json() as { ok: boolean; metadata: { pid: number } };
    expect(backgroundPayload.ok).toBe(true);
    expect(backgroundPayload.metadata.pid).toEqual(expect.any(Number));

    const processes = await runtime.fetch(new Request(localRoute(routePaths.terminal.processes)));
    expect((await processes.json() as { output: string }).output).toContain('"pid"');

    const kill = await runtime.fetch(new Request(localRoute(routePaths.terminal.kill), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: backgroundPayload.metadata.pid })
    }));
    const killPayload = await kill.json() as { ok: boolean; output: string };
    expect(killPayload.ok).toBe(true);
    expect(killPayload.output).toContain('"killed"');
  });
});

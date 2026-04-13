import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

describe('runtime terminal integration', () => {
  it('supports terminal backend listing plus exec/background/processes/kill routes in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const backendsResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.backends)));
    const backendsPayload = await backendsResponse.json() as { ok: boolean; output: string };
    expect(backendsPayload.ok).toBe(true);
    expect(backendsPayload.output).toContain('"docker"');
    expect(backendsPayload.output).toContain('"modal"');

    const execResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'printf "hello-terminal"' })
    }));
    const execPayload = await execResponse.json() as { ok: boolean; output: string };
    expect(execPayload.ok).toBe(true);
    expect(execPayload.output).toContain('hello-terminal');

    const dockerPlanResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'docker', container: 'demo-app', command: 'printf "hello-terminal"', planOnly: true })
    }));
    const dockerPlanPayload = await dockerPlanResponse.json() as { ok: boolean; output: string };
    expect(dockerPlanPayload.ok).toBe(true);
    expect(dockerPlanPayload.output).toContain('docker exec demo-app');

    const backgroundResponse = await runtime.fetch(new Request(localRoute(routePaths.terminal.background), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'sleep 5' })
    }));
    const backgroundPayload = await backgroundResponse.json() as { ok: boolean; metadata: { pid: number } };
    expect(backgroundPayload.ok).toBe(true);
    expect(backgroundPayload.metadata.pid).toEqual(expect.any(Number));

    const processes = await runtime.fetch(new Request(localRoute(routePaths.terminal.processes)));
    const processesPayload = await processes.json() as { output: string };
    expect(processesPayload.output).toContain('"pid"');
    expect(processesPayload.output).toContain('"backend"');

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

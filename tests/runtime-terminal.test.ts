import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

const TEST_TOKEN = 'test-terminal-token';

function setEnvToken(token: string | undefined): void {
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
    ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
    env: {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
      CROWCLAW_DASHBOARD_TOKEN: token,
    },
  };
}

function authedRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${TEST_TOKEN}`);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(url, { ...init, headers });
}

describe('runtime terminal integration', () => {
  beforeEach(() => {
    setEnvToken(TEST_TOKEN);
  });

  it('supports terminal backend listing plus exec/background/processes/kill routes in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const backendsResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.backends)));
    const backendsPayload = await backendsResponse.json() as { ok: boolean; output: string };
    expect(backendsPayload.ok).toBe(true);
    expect(backendsPayload.output).toContain('"docker"');
    expect(backendsPayload.output).toContain('"modal"');

    const backendStatusResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.backendStatus)));
    const backendStatusPayload = await backendStatusResponse.json() as { ok: boolean; output: string };
    expect(backendStatusPayload.ok).toBe(true);
    expect(backendStatusPayload.output).toContain('"installed"');
    expect(backendStatusPayload.output).toContain('"local"');

    const probeResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.probe), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend: 'local' })
    }));
    const probePayload = await probeResponse.json() as { ok: boolean; output: string };
    expect(probePayload.ok).toBe(true);
    expect(probePayload.output).toContain('local-ok');

    // #128 — direct /api/terminal routes lack the AgentLoop approval gate, so
    // tests that exercise actual execution must opt-in via __approvalGranted
    // in the request body. Plan-only flows skip the gate by design.
    const tempCwd = await mkdtemp(join(tmpdir(), 'crowclaw-terminal-runtime-'));
    const cwdResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ command: 'pwd', cwd: tempCwd, __approvalGranted: true })
    }));
    const cwdPayload = await cwdResponse.json() as { ok: boolean; output: string };
    expect(cwdPayload.ok).toBe(true);
    expect(cwdPayload.output).toContain(tempCwd);

    const timeoutResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ command: 'sleep 1', timeoutMs: 10, __approvalGranted: true })
    }));
    const timeoutPayload = await timeoutResponse.json() as { ok: boolean; metadata?: { timeoutMs?: number } };
    expect(timeoutPayload.ok).toBe(false);
    expect(timeoutPayload.metadata?.timeoutMs).toBe(10);

    const execResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ command: 'printf "hello-terminal"', __approvalGranted: true })
    }));
    const execPayload = await execResponse.json() as { ok: boolean; output: string };
    expect(execPayload.ok).toBe(true);
    expect(execPayload.output).toContain('hello-terminal');

    const dockerPlanResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ backend: 'docker', container: 'demo-app', command: 'printf "hello-terminal"', planOnly: true })
    }));
    const dockerPlanPayload = await dockerPlanResponse.json() as { ok: boolean; output: string };
    expect(dockerPlanPayload.ok).toBe(true);
    // #129/#70/#71 — container quoted; --user pinned to non-root uid:gid.
    expect(dockerPlanPayload.output).toContain("docker exec --user 65534:65534 'demo-app'");

    const dockerRunPlanResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ backend: 'docker', image: 'alpine:latest', command: 'printf "hello-terminal"', planOnly: true })
    }));
    const dockerRunPlanPayload = await dockerRunPlanResponse.json() as { ok: boolean; output: string };
    expect(dockerRunPlanPayload.ok).toBe(true);
    expect(dockerRunPlanPayload.output).toContain('--read-only --security-opt no-new-privileges --cap-drop ALL --user 65534:65534 --network none');

    const singularityPlanResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.exec), {
      method: 'POST',
      body: JSON.stringify({ backend: 'singularity', image: 'library://alpine:latest', command: 'printf "hello-terminal"', planOnly: true })
    }));
    const singularityPlanPayload = await singularityPlanResponse.json() as { ok: boolean; output: string };
    expect(singularityPlanPayload.ok).toBe(true);
    expect(singularityPlanPayload.output).toContain("singularity exec --contain --cleanenv 'library://alpine:latest'");

    const backgroundResponse = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.background), {
      method: 'POST',
      body: JSON.stringify({ command: 'sleep 5', __approvalGranted: true })
    }));
    const backgroundPayload = await backgroundResponse.json() as { ok: boolean; metadata: { pid: number } };
    expect(backgroundPayload.ok).toBe(true);
    expect(backgroundPayload.metadata.pid).toEqual(expect.any(Number));

    const processes = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.processes)));
    const processesPayload = await processes.json() as { output: string };
    expect(processesPayload.output).toContain('"pid"');
    expect(processesPayload.output).toContain('"backend"');

    const kill = await runtime.fetch(authedRequest(localRoute(routePaths.terminal.kill), {
      method: 'POST',
      body: JSON.stringify({ pid: backgroundPayload.metadata.pid })
    }));
    const killPayload = await kill.json() as { ok: boolean; output: string };
    expect(killPayload.ok).toBe(true);
    expect(killPayload.output).toContain('"killed"');
  });
});

import { buildToolBridgeArtifacts } from '@crowclaw/sandbox-executor';
import type { ToolRegistry } from '@crowclaw/tools';
import {
  beginBridgeCall,
  endBridgeCall,
  ensureBridgeSession,
  getBridgeIdleInfo,
  getBridgeLeaseInfo,
  markBridgeHeartbeat,
  type CodeBridgeSession
} from './bridge-state.js';
import { routePaths } from './route-paths.js';
import { ensureBridgeProcess, terminateBridgeProcess, type BridgeProcessRecord } from './bridge-process.js';

const socketToolAliases: Record<string, string> = {
  'browser.wait': 'browser.waitFor',
  'browser.wait-for': 'browser.waitFor',
  'browser.click-ref': 'browser.clickRef'
};

function canonicalizeSocketToolName(name: string): string {
  return socketToolAliases[name] ?? name;
}

function getNestedSocketToolName(toolPayload: unknown): string | null {
  if (!toolPayload || typeof toolPayload !== 'object') {
    return null;
  }
  const named = toolPayload as { name?: unknown; arguments?: { name?: unknown } };
  if (named.name !== 'mcp.callTool') {
    return null;
  }
  return typeof named.arguments?.name === 'string' ? canonicalizeSocketToolName(named.arguments.name) : null;
}

function getNestedRequestedToolName(toolPayload: unknown): string | null {
  if (!toolPayload || typeof toolPayload !== 'object') {
    return null;
  }
  const named = toolPayload as { name?: unknown; arguments?: { name?: unknown } };
  if (named.name !== 'mcp.callTool') {
    return null;
  }
  return typeof named.arguments?.name === 'string' ? named.arguments.name : null;
}

function deriveNestedDirectTools(process?: BridgeProcessRecord): string[] {
  return (process?.supportedDirectTools ?? []).filter((toolName) => toolName !== 'mcp.callTool');
}

function deriveDirectToolGroups(process?: BridgeProcessRecord) {
  const nestedDirectTools = deriveNestedDirectTools(process);
  return {
    directToolCount: nestedDirectTools.length,
    directBrowserTools: nestedDirectTools.filter((toolName) => toolName.startsWith('browser.')),
    directMcpTools: nestedDirectTools.filter((toolName) => toolName.startsWith('mcp.')),
    directRuntimeTools: nestedDirectTools.filter((toolName) => !toolName.startsWith('browser.') && !toolName.startsWith('mcp.'))
  };
}

function deriveAliasSupport(process?: BridgeProcessRecord) {
  const supportedDirectTools = process?.supportedDirectTools ?? [];
  const aliasEntries = Object.entries(socketToolAliases) as Array<[string, string]>;
  const supportedRequestedAliases = aliasEntries
    .filter(([, target]) => supportedDirectTools.includes(target))
    .map(([alias]) => alias);
  const supportedAliasTargets = [...new Set(aliasEntries
    .filter(([, target]) => supportedDirectTools.includes(target))
    .map(([, target]) => target))];
  return {
    supportedRequestedAliasCount: supportedRequestedAliases.length,
    supportedAliasTargetCount: supportedAliasTargets.length,
    supportedRequestedAliases,
    supportedAliasTargets
  };
}

function summarizeTranscript(session?: CodeBridgeSession) {
  const transcript = session?.transcript ?? [];
  const byTransport = {
    runtime: transcript.filter((entry) => entry.transport === 'runtime').length,
    socket: transcript.filter((entry) => entry.transport === 'socket').length
  };
  const byExecutionMode = {
    runtime: transcript.filter((entry) => entry.executionMode === 'runtime').length,
    directSocket: transcript.filter((entry) => entry.executionMode === 'direct-socket').length,
    fallbackRuntime: transcript.filter((entry) => entry.executionMode === 'fallback-runtime').length
  };
  const toolUsageCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      counts.set(entry.toolName, (counts.get(entry.toolName) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedDirectToolCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.nestedDirectToolName) {
        counts.set(entry.nestedDirectToolName, (counts.get(entry.nestedDirectToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const nestedRequestedAliasCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.nestedAliasApplied && entry.nestedRequestedToolName) {
        counts.set(entry.nestedRequestedToolName, (counts.get(entry.nestedRequestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const directRequestedAliasCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.aliasApplied && entry.requestedToolName) {
        counts.set(entry.requestedToolName, (counts.get(entry.requestedToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const aliasUsageCounts = Object.fromEntries(
    [...transcript.reduce((counts, entry) => {
      if (entry.aliasApplied && entry.canonicalToolName) {
        counts.set(entry.canonicalToolName, (counts.get(entry.canonicalToolName) ?? 0) + 1);
      }
      if (entry.nestedAliasApplied && entry.nestedCanonicalToolName) {
        counts.set(entry.nestedCanonicalToolName, (counts.get(entry.nestedCanonicalToolName) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b))
  );
  const aliasAppliedEntries = transcript.filter((entry) => entry.aliasApplied).length;
  const nestedAliasAppliedEntries = transcript.filter((entry) => entry.nestedAliasApplied).length;
  return {
    transcriptSummary: {
      total: transcript.length,
      byTransport,
      byExecutionMode,
      aliasAppliedEntries,
      nestedAliasAppliedEntries,
      aliasUsageCounts,
      directRequestedAliasCounts,
      nestedRequestedAliasCounts,
      toolUsageCounts,
      nestedDirectToolCounts,
      lastEntry: transcript.at(-1) ?? null
    }
  };
}

async function requestBridgeSocket(socketPath: string, payload: unknown): Promise<{ ok: boolean; response?: unknown; error?: string }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)');
  try {
    const net = await dynamicImport('node:net') as {
      createConnection(options: { path: string }, listener?: () => void): {
        on(event: string, cb: (...args: unknown[]) => void): void;
        write(chunk: string): void;
        end(): void;
        destroy(): void;
      };
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await new Promise<{ ok: boolean; response?: unknown; error?: string }>((resolve) => {
        const client = net.createConnection({ path: socketPath }, () => {
          client.write(JSON.stringify(payload));
        });

        let data = '';
        let settled = false;
        const finish = (value: { ok: boolean; response?: unknown; error?: string }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        client.on('data', (chunk) => {
          data += String(chunk);
        });
        client.on('end', () => {
          try {
            finish({ ok: true, response: data ? JSON.parse(data) : null });
          } catch {
            finish({ ok: true, response: data });
          }
        });
        client.on('error', (error) => {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
        });
        setTimeout(() => {
          client.destroy();
          finish({ ok: false, error: 'Bridge socket ping timeout.' });
        }, 500);
      });

      if (result.ok) {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ok: false, error: 'Bridge socket not ready after retries.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function renderCodeExecCommand(language: string, code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }

  switch (language) {
    case 'javascript':
    case 'js':
      return `node -e ${JSON.stringify(trimmed)}`;
    case 'typescript':
    case 'ts':
      return `tsx -e ${JSON.stringify(trimmed)}`;
    case 'python':
    case 'py':
      return `python -c ${JSON.stringify(trimmed)}`;
    case 'bash':
    case 'sh':
      return `bash -lc ${JSON.stringify(trimmed)}`;
    default:
      return null;
  }
}

export function buildRuntimeToolBridgeArtifacts(sessionId: string, maxToolCalls?: number) {
  const normalized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const socketPath = `/tmp/crow-tool-bridge-${normalized}.sock`;
  const modulePath = `/workspace/.crowclaw/bridge/crow_tools_${normalized}.py`;
  const stubPath = `/workspace/.crowclaw/bridge/bootstrap_${normalized}.py`;
  const transcriptPath = `/workspace/.crowclaw/bridge/transcript_${normalized}.json`;
  const bootstrapPython = [
    'import json',
    'import socket',
    '',
    `SOCKET_PATH = ${JSON.stringify(socketPath)}`,
    '',
    'def call_tool(name, arguments=None):',
    '    payload = {"name": name, "arguments": arguments or {}}',
    `    payload["maxToolCalls"] = ${typeof maxToolCalls === 'number' ? maxToolCalls : 'None'}`,
    '    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:',
    '        client.connect(SOCKET_PATH)',
    '        client.sendall(json.dumps(payload).encode("utf-8"))',
    '        data = client.recv(65536)',
    '    return json.loads(data.decode("utf-8"))',
    '',
    '__all__ = ["call_tool"]'
  ].join('\n');

  return {
    sessionId,
    protocolVersion: 'crowclaw-tool-bridge/v1',
    modulePath,
    stubPath,
    socketPath,
    transcriptPath,
    bootstrapPython
  };
}

export function renderCodeExecRouteResult(
  toolName: 'code.exec' | 'node.exec' | 'python.exec',
  language: string,
  code: string,
  cwd?: string,
  timeoutMs?: number,
  toolBridge?: boolean,
  maxToolCalls?: number
) {
  const command = renderCodeExecCommand(language, code);
  if (!command) {
    return {
      toolName,
      runtime: 'sandbox' as const,
      ok: false,
      output: `Unsupported language or empty code: ${language}`,
      metadata: { language }
    };
  }

  return {
    toolName,
    runtime: 'sandbox' as const,
    ok: true,
    output: `[sandbox] Command queued for container execution: ${cwd ? `cd ${cwd} && ` : ''}${command}`,
    metadata: {
      language,
      simulated: true,
      exitCode: 0,
      command,
      cwd,
      timeoutMs,
      stdout: `[sandbox] Command queued for container execution: ${cwd ? `cd ${cwd} && ` : ''}${command}`,
      stderr: '',
      timedOut: false,
      toolBridgeRequested: Boolean(toolBridge),
      toolBridgeMode: toolBridge ? 'session-artifacts' : 'none',
      maxToolCalls,
      bridgeArtifacts: toolBridge ? buildToolBridgeArtifacts('node-runtime-route', maxToolCalls) : undefined
    }
  };
}

export interface HandleCodeBridgeRoutesOptions {
  agentId?: string;
  codeBridgeSessions: Map<string, CodeBridgeSession>;
  bridgeProcesses: Map<string, BridgeProcessRecord>;
  tools: ToolRegistry;
}

export async function handleCodeBridgeRoutes(
  request: Request,
  url: URL,
  options: HandleCodeBridgeRoutesOptions
): Promise<Response | null> {
  if (request.method === 'POST' && url.pathname === routePaths.code.exec) {
    const body = (await request.json()) as { language?: string; code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
    const language = typeof body.language === 'string' ? body.language : 'javascript';
    const code = typeof body.code === 'string' ? body.code : '';
    return Response.json(renderCodeExecRouteResult('code.exec', language, code, body.cwd, body.timeoutMs, body.toolBridge, body.maxToolCalls));
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridge) {
    const body = (await request.json()) as { sessionId?: string; maxToolCalls?: number; idleTimeoutMs?: number };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : crypto.randomUUID();
    ensureBridgeSession(options.codeBridgeSessions, sessionId, body.maxToolCalls, body.idleTimeoutMs);
    return Response.json(buildRuntimeToolBridgeArtifacts(sessionId, body.maxToolCalls));
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeSpawn) {
    const body = (await request.json()) as { sessionId?: string; maxToolCalls?: number; idleTimeoutMs?: number };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : crypto.randomUUID();
    ensureBridgeSession(options.codeBridgeSessions, sessionId, body.maxToolCalls, body.idleTimeoutMs);
    const artifacts = buildRuntimeToolBridgeArtifacts(sessionId, body.maxToolCalls);
    const process = await ensureBridgeProcess(options.bridgeProcesses, sessionId, artifacts.socketPath);
    return Response.json({
      ok: true,
      sessionId,
      artifacts,
      process: {
        ...process,
        directToolAliases: socketToolAliases,
        ...deriveAliasSupport(process)
      }
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeCall && url.searchParams.get('transport') === 'socket') {
    const body = (await request.json()) as { sessionId?: string; payload?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const process = sessionId ? options.bridgeProcesses.get(sessionId) : undefined;
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    if (!process) {
      return Response.json({ ok: false, error: 'Bridge process not found.', sessionId }, { status: 404 });
    }
    const socketResult = await requestBridgeSocket(process.socketPath, body.payload ?? { ping: true });
    let toolResult: unknown = (socketResult.response as { toolResult?: unknown } | undefined)?.toolResult ?? null;
    const echoedPayload = (socketResult.response as { received?: unknown } | undefined)?.received;
    const originalPayload = body.payload;
    const toolPayload = (
      echoedPayload
      && typeof echoedPayload === 'object'
      && 'name' in echoedPayload
      && typeof (echoedPayload as { name?: unknown }).name === 'string'
    ) ? echoedPayload : (
      originalPayload
      && typeof originalPayload === 'object'
      && 'name' in originalPayload
      && typeof (originalPayload as { name?: unknown }).name === 'string'
    ) ? originalPayload : null;
    const canonicalToolName = toolPayload
      && typeof toolPayload === 'object'
      && 'name' in toolPayload
      && typeof (toolPayload as { name?: unknown }).name === 'string'
      ? canonicalizeSocketToolName((toolPayload as { name: string }).name)
      : null;
    const directSocketToolExecution = Boolean((socketResult.response as { toolResult?: unknown } | undefined)?.toolResult);
    const nestedRequestedToolName = getNestedRequestedToolName(toolPayload);
    const nestedDirectToolName = getNestedSocketToolName(toolPayload);
    const nestedCanonicalToolName = nestedDirectToolName;
    const nestedDirectToolExecution = Boolean(
      directSocketToolExecution
      && nestedDirectToolName
      && process.supportedDirectTools.includes(nestedDirectToolName)
    );
    if (!toolResult && toolPayload) {
      const toolName = canonicalToolName ?? (toolPayload as { name: string }).name;
      const rawArgs = (toolPayload as { arguments?: Record<string, unknown> }).arguments ?? {};
      const args = toolName === 'mcp.callTool' && typeof rawArgs.name === 'string'
        ? {
            ...rawArgs,
            name: canonicalizeSocketToolName(rawArgs.name)
          }
        : rawArgs;
      toolResult = await options.tools.execute(toolName, args, {
        agentId: options.agentId ?? 'crowclaw-bridge-socket',
        sessionId
      });
    }

    if (session && toolResult && typeof toolResult === 'object') {
      const typed = toolResult as { toolName?: string; ok?: boolean; output?: string };
      const executionMode: 'direct-socket' | 'fallback-runtime' | 'none' = directSocketToolExecution
        ? 'direct-socket'
        : (toolResult ? 'fallback-runtime' : 'none');
      session.lastToolName = typed.toolName ?? session.lastToolName;
      session.lastActivityAt = new Date().toISOString();
      session.transcript.push({
        toolName: typed.toolName ?? 'socket-transport',
        ok: Boolean(typed.ok),
        output: typeof typed.output === 'string' ? typed.output : JSON.stringify(toolResult),
        createdAt: new Date().toISOString(),
        transport: 'socket',
        executionMode: executionMode === 'none' ? 'fallback-runtime' : executionMode,
        requestedToolName: toolPayload && typeof toolPayload === 'object' && 'name' in toolPayload && typeof (toolPayload as { name?: unknown }).name === 'string'
          ? (toolPayload as { name: string }).name
          : null,
        canonicalToolName,
        aliasApplied: Boolean(canonicalToolName && toolPayload && typeof toolPayload === 'object' && 'name' in toolPayload && canonicalToolName !== (toolPayload as { name?: unknown }).name),
        nestedDirectToolName,
        nestedRequestedToolName,
        nestedCanonicalToolName,
        nestedAliasApplied: Boolean(nestedCanonicalToolName && toolPayload && typeof toolPayload === 'object' && 'arguments' in toolPayload && typeof (toolPayload as { arguments?: { name?: unknown } }).arguments?.name === 'string' && nestedCanonicalToolName !== (toolPayload as { arguments?: { name?: string } }).arguments?.name),
        nestedDirectToolExecution
      });
    }

    return Response.json({
      sessionId,
      process: {
        protocolVersion: process.protocolVersion,
        pid: process.pid,
        mode: process.mode,
        socketPath: process.socketPath,
        socketReady: process.socketReady,
        directToolAliases: socketToolAliases,
        ...deriveAliasSupport(process),
        supportedDirectTools: process.supportedDirectTools,
        alive: process.alive
      },
      transport: 'socket',
      contract: {
        mode: 'socket-roundtrip',
        requestedToolName: toolPayload && typeof toolPayload === 'object' && 'name' in toolPayload ? (toolPayload as { name?: unknown }).name : null,
        aliasApplied: Boolean(canonicalToolName && toolPayload && typeof toolPayload === 'object' && 'name' in toolPayload && canonicalToolName !== (toolPayload as { name?: unknown }).name),
        echoedPayload: Boolean(echoedPayload),
        toolExecutionAttempted: Boolean(toolResult),
        fallbackToDirectToolExecution: Boolean(toolPayload) && !directSocketToolExecution,
        directSocketToolExecution,
        canonicalToolName,
        nestedRequestedToolName,
        nestedDirectToolName,
        nestedCanonicalToolName,
        nestedAliasApplied: Boolean(nestedCanonicalToolName && toolPayload && typeof toolPayload === 'object' && 'arguments' in toolPayload && typeof (toolPayload as { arguments?: { name?: unknown } }).arguments?.name === 'string' && nestedCanonicalToolName !== (toolPayload as { arguments?: { name?: string } }).arguments?.name),
        nestedDirectToolExecution,
        toolExecutionMode: directSocketToolExecution
          ? 'direct-socket'
          : (toolResult ? 'fallback-runtime' : 'none')
      },
      transcriptLength: session?.transcript.length ?? 0,
      toolResult,
      ...socketResult
    }, { status: socketResult.ok ? 200 : 502 });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeCall) {
    const body = (await request.json()) as { sessionId?: string; name?: string; arguments?: Record<string, unknown>; maxToolCalls?: number };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : crypto.randomUUID();
    const name = typeof body.name === 'string' ? body.name : '';
    const existing = options.codeBridgeSessions.get(sessionId);
    const session = existing
      ? existing
      : ensureBridgeSession(options.codeBridgeSessions, sessionId, body.maxToolCalls);

    if (!name) {
      return Response.json({ ok: false, error: 'Missing tool name.', sessionId }, { status: 400 });
    }

    if (session.status === 'closed') {
      return Response.json({ ok: false, error: 'Bridge session is closed.', sessionId }, { status: 409 });
    }

    if (typeof session.maxToolCalls === 'number' && session.transcript.length >= session.maxToolCalls) {
      return Response.json({
        ok: false,
        error: 'Tool bridge maxToolCalls exceeded.',
        sessionId,
        maxToolCalls: session.maxToolCalls,
        callsUsed: session.transcript.length
      }, { status: 429 });
    }

    beginBridgeCall(session, name);
    const result = await options.tools.execute(name, body.arguments ?? {}, {
      agentId: options.agentId ?? 'crowclaw-bridge',
      sessionId
    });

    session.transcript.push({
      toolName: result.toolName,
      ok: result.ok,
      output: result.output,
      createdAt: new Date().toISOString(),
      transport: 'runtime',
      executionMode: 'runtime'
    });
    endBridgeCall(session);

    return Response.json({
      sessionId,
      result,
      transcriptLength: session.transcript.length,
      status: session.status
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgePing) {
    const body = (await request.json()) as { sessionId?: string };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const process = sessionId ? options.bridgeProcesses.get(sessionId) : undefined;
    if (!process) {
      return Response.json({ ok: false, error: 'Bridge process not found.', sessionId }, { status: 404 });
    }
    const ping = await requestBridgeSocket(process.socketPath, { ping: true });
    return Response.json({
      sessionId,
      process: {
        pid: process.pid,
        mode: process.mode,
        socketPath: process.socketPath,
        socketReady: process.socketReady,
        alive: process.alive,
        directToolAliases: socketToolAliases,
        ...deriveAliasSupport(process)
      },
      ...ping
    }, { status: ping.ok ? 200 : 502 });
  }

  if (request.method === 'GET' && url.pathname === routePaths.code.bridgeStatus) {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    const process = sessionId ? options.bridgeProcesses.get(sessionId) : undefined;
    const idleInfo = getBridgeIdleInfo(session);
    const leaseInfo = getBridgeLeaseInfo(session);
    return Response.json({
      sessionId,
      exists: Boolean(session),
      status: session?.status ?? 'closed',
      runtimeMode: session?.runtimeMode,
      processId: session?.processId,
      openedAt: session?.openedAt,
      lastActivityAt: session?.lastActivityAt,
      lastHeartbeatAt: session?.lastHeartbeatAt,
      closedAt: session?.closedAt,
      reopenCount: session?.reopenCount ?? 0,
      activeCallCount: session?.activeCallCount ?? 0,
      lastToolName: session?.lastToolName,
      maxToolCalls: session?.maxToolCalls,
      transcriptLength: session?.transcript.length ?? 0,
      directToolAliases: socketToolAliases,
      ...deriveDirectToolGroups(process),
      ...deriveAliasSupport(process),
      ...summarizeTranscript(session),
      ...idleInfo,
      ...leaseInfo
    });
  }

  if (request.method === 'GET' && url.pathname === routePaths.code.bridgeProcess) {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    const process = sessionId ? options.bridgeProcesses.get(sessionId) : undefined;
    const idleInfo = getBridgeIdleInfo(session);
    const leaseInfo = getBridgeLeaseInfo(session);
    return Response.json({
      sessionId,
      exists: Boolean(session),
      runtimeMode: session?.runtimeMode,
      processId: process?.pid ?? session?.processId,
      status: session?.status ?? 'closed',
      startedAt: session?.openedAt,
      lastActivityAt: session?.lastActivityAt,
      lastHeartbeatAt: session?.lastHeartbeatAt,
      closedAt: session?.closedAt,
      activeCallCount: session?.activeCallCount ?? 0,
      lastToolName: session?.lastToolName,
      transcriptLength: session?.transcript.length ?? 0,
      process: process
        ? {
            protocolVersion: process.protocolVersion,
            pid: process.pid,
            mode: process.mode,
            socketPath: process.socketPath,
            socketReady: process.socketReady,
            supportedDirectTools: process.supportedDirectTools,
            alive: process.alive,
            startedAt: process.startedAt,
            exitedAt: process.exitedAt,
            exitCode: process.exitCode,
            spawnError: process.spawnError
          }
        : null,
      supportsNestedCallToolDirect: true,
      directToolAliases: socketToolAliases,
      ...deriveDirectToolGroups(process),
      ...deriveAliasSupport(process),
      ...summarizeTranscript(session),
      ...idleInfo,
      ...leaseInfo
    });
  }

  if (request.method === 'GET' && url.pathname === routePaths.code.bridgeCapabilities) {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const process = sessionId ? options.bridgeProcesses.get(sessionId) : undefined;
    return Response.json({
      sessionId,
      exists: Boolean(process),
      protocolVersion: process?.protocolVersion ?? 'crowclaw-tool-bridge/v1',
      runtimeMode: process?.mode ?? 'simulated',
      socketReady: process?.socketReady ?? false,
      supportedDirectTools: process?.supportedDirectTools ?? [],
      directToolAliases: socketToolAliases,
      nestedDirectTools: deriveNestedDirectTools(process),
      ...deriveDirectToolGroups(process),
      ...deriveAliasSupport(process),
      supportsNestedCallToolDirect: true
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeHeartbeat) {
    const body = (await request.json()) as { sessionId?: string };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    if (!session) {
      return Response.json({ ok: false, error: 'Bridge session not found.', sessionId }, { status: 404 });
    }
    if (session.status === 'closed') {
      return Response.json({ ok: false, error: 'Bridge session is closed.', sessionId }, { status: 409 });
    }
    markBridgeHeartbeat(session);
    const idleInfo = getBridgeIdleInfo(session);
    const leaseInfo = getBridgeLeaseInfo(session);
    return Response.json({
      ok: true,
      sessionId,
      status: session.status,
      runtimeMode: session.runtimeMode,
      processId: session.processId,
      lastHeartbeatAt: session.lastHeartbeatAt,
      lastActivityAt: session.lastActivityAt,
      ...idleInfo,
      ...leaseInfo
    });
  }

  if (request.method === 'GET' && url.pathname === routePaths.code.bridgeTranscript) {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    return Response.json({
      sessionId,
      status: session?.status ?? 'closed',
      runtimeMode: session?.runtimeMode,
      processId: session?.processId,
      openedAt: session?.openedAt,
      lastActivityAt: session?.lastActivityAt,
      lastHeartbeatAt: session?.lastHeartbeatAt,
      closedAt: session?.closedAt,
      activeCallCount: session?.activeCallCount ?? 0,
      lastToolName: session?.lastToolName,
      leaseExpiresAt: session?.leaseExpiresAt,
      maxToolCalls: session?.maxToolCalls,
      ...summarizeTranscript(session),
      transcript: session?.transcript ?? []
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeClose) {
    const body = (await request.json()) as { sessionId?: string };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const session = sessionId ? options.codeBridgeSessions.get(sessionId) : undefined;
    const transcriptLength = session?.transcript.length ?? 0;
    if (session?.activeCallCount) {
      return Response.json({
        ok: false,
        sessionId,
        error: 'Bridge session is busy.',
        activeCallCount: session.activeCallCount
      }, { status: 409 });
    }
    if (sessionId && session) {
      session.status = 'closed';
      session.closedAt = new Date().toISOString();
      session.lastActivityAt = session.closedAt;
    }
    return Response.json({
      ok: true,
      sessionId,
      closed: Boolean(sessionId),
      transcriptLength,
      status: session?.status ?? 'closed',
      reopenCount: session?.reopenCount ?? 0,
      activeCallCount: session?.activeCallCount ?? 0
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.bridgeTerminate) {
    const body = (await request.json()) as { sessionId?: string };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const process = sessionId ? terminateBridgeProcess(options.bridgeProcesses, sessionId) : undefined;
    return Response.json({
      ok: true,
      sessionId,
      terminated: Boolean(process),
      process: process
        ? {
            protocolVersion: process.protocolVersion,
            pid: process.pid,
            mode: process.mode,
            socketPath: process.socketPath,
            socketReady: process.socketReady,
            supportedDirectTools: process.supportedDirectTools,
            alive: process.alive,
            startedAt: process.startedAt,
            exitedAt: process.exitedAt,
            exitCode: process.exitCode,
            spawnError: process.spawnError
          }
        : null
    });
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.nodeExec) {
    const body = (await request.json()) as { code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
    const code = typeof body.code === 'string' ? body.code : '';
    return Response.json(renderCodeExecRouteResult('node.exec', 'javascript', code, body.cwd, body.timeoutMs, body.toolBridge, body.maxToolCalls));
  }

  if (request.method === 'POST' && url.pathname === routePaths.code.pythonExec) {
    const body = (await request.json()) as { code?: string; cwd?: string; timeoutMs?: number; toolBridge?: boolean; maxToolCalls?: number };
    const code = typeof body.code === 'string' ? body.code : '';
    return Response.json(renderCodeExecRouteResult('python.exec', 'python', code, body.cwd, body.timeoutMs, body.toolBridge, body.maxToolCalls));
  }

  return null;
}

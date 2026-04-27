export interface BridgeProcessRecord {
  sessionId: string;
  protocolVersion: string;
  pid?: number;
  command: string;
  mode: 'child-process' | 'simulated';
  socketPath: string;
  socketReady: boolean;
  supportedDirectTools: string[];
  alive: boolean;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  spawnError?: string;
  // #123: `removeAllListeners` is called on the handle during termination so
  //       the child process's event listeners (and their captured closures)
  //       can be released.
  handle?: {
    pid?: number;
    kill(signal?: string): boolean;
    unref?: () => void;
    on?: (event: string, callback: (code: number | null) => void) => void;
    removeAllListeners?: (event?: string) => void;
  } | null;
}

export async function ensureBridgeProcess(
  processes: Map<string, BridgeProcessRecord>,
  sessionId: string,
  socketPath: string
): Promise<BridgeProcessRecord> {
  const existing = processes.get(sessionId);
  if (existing?.alive) {
    return existing;
  }

  const nodeProcess = (globalThis as unknown as { process?: { execPath?: string } }).process;
  const execPath = nodeProcess?.execPath ?? 'node';
const serverScript = `
const fs = require('fs');
const net = require('net');
const socketPath = process.argv[1];
try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
function canonicalToolName(name) {
  const aliases = {
    'browser.wait': 'browser.waitFor',
    'browser.wait-for': 'browser.waitFor',
    'browser.click-ref': 'browser.clickRef'
  };
  return aliases[name] || name;
}
function directToolResult(name, args) {
  name = canonicalToolName(name);
  if (name === 'echo') {
    return {
      toolName: 'echo',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify(args || {})
    };
  }
  if (name === 'time') {
    return {
      toolName: 'time',
      runtime: 'sandbox',
      ok: true,
      output: new Date().toISOString()
    };
  }
  if (name === 'mcp.status') {
    return {
      toolName: 'mcp.status',
      runtime: 'worker',
      ok: true,
      output: JSON.stringify({
        transport: 'socket',
        simulated: true,
        supportsResources: true,
        supportsPrompts: true
      })
    };
  }
  if (name === 'mcp.listTools') {
    return {
      toolName: 'mcp.listTools',
      runtime: 'worker',
      ok: true,
      output: JSON.stringify([
        { name: 'mcp.status' },
        { name: 'mcp.listTools' },
        { name: 'mcp.inspect' },
        { name: 'mcp.callTool' },
        { name: 'browser.session' }
      ])
    };
  }
  if (name === 'mcp.inspect') {
    return {
      toolName: 'mcp.inspect',
      runtime: 'worker',
      ok: true,
      output: JSON.stringify({
        status: {
          transport: 'socket',
          simulated: true,
          supportsResources: true,
          supportsPrompts: true
        },
        tools: [
          { name: 'mcp.status' },
          { name: 'mcp.listTools' },
          { name: 'mcp.inspect' },
          { name: 'mcp.callTool' },
          { name: 'browser.session' }
        ],
        resources: [],
        prompts: []
      })
    };
  }
  if (name === 'mcp.listResources') {
    return {
      toolName: 'mcp.listResources',
      runtime: 'worker',
      ok: true,
      output: JSON.stringify([])
    };
  }
  if (name === 'mcp.listPrompts') {
    return {
      toolName: 'mcp.listPrompts',
      runtime: 'worker',
      ok: true,
      output: JSON.stringify([])
    };
  }
  if (name === 'browser.session') {
    return {
      toolName: 'browser.session',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        currentUrl: null,
        history: [],
        lastSnapshot: null,
        lastRefs: []
      })
    };
  }
  if (name === 'browser.open') {
    return {
      toolName: 'browser.open',
      runtime: 'sandbox',
      ok: true,
      output: \`Simulated browser navigation to \${typeof args?.url === 'string' ? args.url : 'about:blank'}\`
    };
  }
  if (name === 'browser.goto') {
    return {
      toolName: 'browser.goto',
      runtime: 'sandbox',
      ok: true,
      output: \`Simulated browser navigation to \${typeof args?.url === 'string' ? args.url : 'about:blank'}\`
    };
  }
  if (name === 'browser.navigate') {
    return {
      toolName: 'browser.navigate',
      runtime: 'sandbox',
      ok: true,
      output: \`Simulated browser navigation to \${typeof args?.url === 'string' ? args.url : 'about:blank'}\`
    };
  }
  if (name === 'browser.snapshot') {
    return {
      toolName: 'browser.snapshot',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        url: typeof args?.url === 'string' ? args.url : null,
        refs: ['@e1', '@e2'],
        snapshot: [
          '[@e1] heading "Example Domain"',
          '[@e2] link "More information..."'
        ]
      })
    };
  }
  if (name === 'browser.console') {
    return {
      toolName: 'browser.console',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify([
        {
          level: 'info',
          message: 'Simulated console log from direct socket bridge'
        }
      ])
    };
  }
  if (name === 'browser.images') {
    return {
      toolName: 'browser.images',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify([
        { ref: '@img1', src: '/api/browser/screenshot?ref=img1', alt: 'Screenshot 1' },
        { ref: '@img2', src: '/api/browser/screenshot?ref=img2', alt: 'Screenshot 2' }
      ])
    };
  }
  if (name === 'browser.vision') {
    return {
      toolName: 'browser.vision',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        summary: 'Simulated direct socket visual analysis',
        prompt: typeof args?.prompt === 'string' ? args.prompt : '',
        url: typeof args?.url === 'string' ? args.url : null
      })
    };
  }
  if (name === 'browser.back') {
    return {
      toolName: 'browser.back',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        steps: typeof args?.steps === 'number' ? args.steps : 1,
        finalUrl: 'about:blank'
      })
    };
  }
  if (name === 'browser.scroll') {
    return {
      toolName: 'browser.scroll',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        direction: typeof args?.direction === 'string' ? args.direction : 'down',
        amount: typeof args?.amount === 'number' ? args.amount : 1
      })
    };
  }
  if (name === 'browser.press') {
    return {
      toolName: 'browser.press',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        key: typeof args?.key === 'string' ? args.key : 'Enter'
      })
    };
  }
  if (name === 'browser.clickRef') {
    return {
      toolName: 'browser.clickRef',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        ref: typeof args?.ref === 'string' ? args.ref : '@e1',
        finalUrl: typeof args?.url === 'string' ? args.url : 'about:blank'
      })
    };
  }
  if (name === 'browser.waitFor') {
    return {
      toolName: 'browser.waitFor',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        selector: typeof args?.selector === 'string' ? args.selector : 'body',
        timeoutMs: typeof args?.timeoutMs === 'number' ? args.timeoutMs : 1000,
        matched: true
      })
    };
  }
  if (name === 'browser.extract') {
    return {
      toolName: 'browser.extract',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        selector: typeof args?.selector === 'string' ? args.selector : 'body',
        text: 'Simulated extracted content'
      })
    };
  }
  if (name === 'browser.click') {
    return {
      toolName: 'browser.click',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        selector: typeof args?.selector === 'string' ? args.selector : '#app',
        clicked: true
      })
    };
  }
  if (name === 'browser.type') {
    return {
      toolName: 'browser.type',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        selector: typeof args?.selector === 'string' ? args.selector : 'input',
        text: typeof args?.text === 'string' ? args.text : ''
      })
    };
  }
  if (name === 'browser.screenshot') {
    return {
      toolName: 'browser.screenshot',
      runtime: 'sandbox',
      ok: true,
      output: JSON.stringify({
        path: typeof args?.path === 'string' ? args.path : '/tmp/direct-screenshot.png',
        url: typeof args?.url === 'string' ? args.url : null
      })
    };
  }
  return null;
}
const server = net.createServer((socket) => {
  socket.on('data', (chunk) => {
    let parsed = null;
    try {
      parsed = JSON.parse(String(chunk));
    } catch {
      parsed = String(chunk);
    }
    let toolResult = null;
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      toolResult = directToolResult(parsed.name, parsed.arguments || {});
      if (!toolResult && parsed.name === 'mcp.callTool') {
        const nestedName = parsed.arguments && parsed.arguments.name ? canonicalToolName(parsed.arguments.name) : null;
        const nestedArgs = parsed.arguments && parsed.arguments.arguments ? parsed.arguments.arguments : {};
        const nestedResult = nestedName ? directToolResult(nestedName, nestedArgs) : null;
        toolResult = {
          toolName: 'mcp.callTool',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
            name: nestedName,
            arguments: nestedArgs,
            direct: Boolean(nestedResult),
            result: nestedResult
          })
        };
      }
    }
    socket.end(JSON.stringify({
      ok: true,
      simulated: true,
      transport: 'socket',
      received: parsed,
      toolResult
    }));
  });
});
server.listen(socketPath);
process.on('SIGTERM', () => {
  server.close(() => {
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch {}
    process.exit(0);
  });
});
setInterval(() => {}, 1000);
`;
  const command = `${execPath} -e ${JSON.stringify(serverScript)} ${JSON.stringify(socketPath)}`;
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    const childProcess = await dynamicImport('node:child_process') as {
      spawn: (
        command: string,
        args: string[],
        options: { stdio: 'ignore'; detached: boolean }
      ) => BridgeProcessRecord['handle'];
    };
    const child = childProcess.spawn(execPath, ['-e', serverScript, socketPath], {
      stdio: 'ignore',
      detached: true
    });
    if (!child) {
      throw new Error('Failed to spawn bridge process.');
    }
    child.unref?.();

    const record: BridgeProcessRecord = {
      sessionId,
      protocolVersion: 'crowclaw-tool-bridge/v1',
      pid: child.pid,
      command,
      mode: 'child-process',
      socketPath,
      socketReady: true,
      supportedDirectTools: ['echo', 'time', 'mcp.status', 'mcp.listTools', 'mcp.inspect', 'mcp.listResources', 'mcp.listPrompts', 'mcp.callTool', 'browser.session', 'browser.open', 'browser.goto', 'browser.navigate', 'browser.snapshot', 'browser.console', 'browser.images', 'browser.vision', 'browser.back', 'browser.scroll', 'browser.press', 'browser.clickRef', 'browser.waitFor', 'browser.extract', 'browser.click', 'browser.type', 'browser.screenshot'],
      alive: true,
      startedAt: new Date().toISOString(),
      handle: child
    };
    child.on?.('exit', (code) => {
      record.alive = false;
      record.exitCode = code;
      record.exitedAt = new Date().toISOString();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    processes.set(sessionId, record);
    return record;
  } catch (error) {
    const record: BridgeProcessRecord = {
      sessionId,
      protocolVersion: 'crowclaw-tool-bridge/v1',
      command,
      mode: 'simulated',
      socketPath,
      socketReady: false,
      supportedDirectTools: ['echo', 'time', 'mcp.status', 'mcp.listTools', 'mcp.inspect', 'mcp.listResources', 'mcp.listPrompts', 'mcp.callTool', 'browser.session', 'browser.open', 'browser.goto', 'browser.navigate', 'browser.snapshot', 'browser.console', 'browser.images', 'browser.vision', 'browser.back', 'browser.scroll', 'browser.press', 'browser.clickRef', 'browser.waitFor', 'browser.extract', 'browser.click', 'browser.type', 'browser.screenshot'],
      alive: false,
      startedAt: new Date().toISOString(),
      spawnError: error instanceof Error ? error.message : String(error)
    };
    processes.set(sessionId, record);
    return record;
  }
}

export function terminateBridgeProcess(
  processes: Map<string, BridgeProcessRecord>,
  sessionId: string
): BridgeProcessRecord | undefined {
  const record = processes.get(sessionId);
  if (!record) {
    return undefined;
  }
  if (record.alive && record.handle?.kill) {
    try {
      record.handle.kill('SIGTERM');
    } catch {
      // best-effort shutdown
    }
  }
  record.alive = false;
  record.socketReady = false;
  record.exitedAt = new Date().toISOString();
  // #123: Detach all event listeners we registered on the child handle and
  //       null the handle itself. The 'exit' listener captures `record`,
  //       which keeps the entry retained even after the child has exited.
  //       Combined with the `processes.delete(sessionId)` below this lets
  //       the GC reclaim both the handle and the closure.
  if (record.handle?.removeAllListeners) {
    try { record.handle.removeAllListeners(); } catch { /* best-effort */ }
  }
  record.handle = null;
  // #116: Drop the Map entry. Long-running runtimes accumulate dead
  //       BridgeProcessRecords (each holding a transcript + spawn metadata)
  //       because previously terminate() only flipped `alive=false` and
  //       `pruneStaleBridgeSessions` only operated on `codeBridgeSessions`.
  processes.delete(sessionId);
  return record;
}

/**
 * #116: Drop dead or stale bridge process records. Companion to
 * `pruneStaleBridgeSessions` (in `bridge-state.ts`) which only handles the
 * transcript-side `codeBridgeSessions` Map; this function targets the
 * `bridgeProcesses` Map which holds the spawned-child metadata.
 *
 * Removes entries that are either:
 *   - already marked `alive = false` (terminated but never deleted), OR
 *   - older than `maxAgeMs` based on `startedAt`.
 *
 * Returns the number of entries removed.
 */
export function pruneDeadBridgeProcesses(
  processes: Map<string, BridgeProcessRecord>,
  maxAgeMs: number = 60 * 60 * 1000, // 1h, mirrors session prune default
  now: number = Date.now(),
): number {
  let removed = 0;
  for (const [key, record] of processes) {
    // Only drop records that ACTUALLY ran and then exited (have `exitedAt`).
    // Simulated / spawn-error records (alive=false from birth) stay visible
    // to operators — they're the only signal that a bridge failed to spawn,
    // and aggressively pruning them silently swallows the diagnostic.
    if (!record.alive && record.exitedAt) {
      processes.delete(key);
      removed++;
      continue;
    }
    const ts = new Date(record.startedAt).getTime();
    if (!Number.isFinite(ts)) continue;
    if (now - ts > maxAgeMs) {
      // Best-effort terminate so we don't leave a zombie child handle.
      if (record.handle?.kill) {
        try { record.handle.kill('SIGTERM'); } catch { /* best-effort */ }
      }
      if (record.handle?.removeAllListeners) {
        try { record.handle.removeAllListeners(); } catch { /* best-effort */ }
      }
      record.handle = null;
      processes.delete(key);
      removed++;
    }
  }
  return removed;
}

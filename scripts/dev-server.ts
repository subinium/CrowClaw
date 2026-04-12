/**
 * CrowClaw local development server.
 * Serves the dashboard and all API routes without Cloudflare dependencies.
 *
 * Usage: npx tsx scripts/dev-server.ts
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { AgentLoop, InMemoryCheckpointStore, createCheckpoint, restoreFromCheckpoint, createReplaySession } from '../packages/core/src/index.js';
import { OpenAICompatibleProvider } from '../packages/providers/src/index.js';
import {
  ToolRegistry,
  createEchoTool,
  createTimeTool,
  createToolListTool,
  createWebFetchTool,
  createWebSearchTool,
  createWebExtractMetadataTool,
  createWebExtractLinksTool,
  createWebExtractTextTool,
  createTodoTool,
  createClarifyTool,
  createTextPatchTool,
  createLinePatchTool,
} from '../packages/tools/src/index.js';
import { InMemorySessionStore } from '../packages/storage/src/index.js';
import { McpClient, mcpPresets as mcpPresetConfigs, type McpStdioServerConfig } from '../packages/mcp/src/index.js';
import { McpJsonRpcStdioTransport } from '../packages/mcp/src/stdio-transport.js';
import type { ParsedSkillFile } from '../packages/core/src/index.js';

const PORT = Number(process.env.PORT ?? 4000);

// Mutable runtime state (simulates RuntimeConfigStore for dev mode)
const runtimeState = {
  activePreset: null as string | null,
  agentPreset: null as { role: string; goal: string; backstory?: string } | null,
  activeToolset: null as string | null,
  disabledSkills: new Set<string>(),
  gatewayTokens: new Map<string, string>(),
  mcpConnections: new Map<string, { status: string; connectedAt?: string }>(),
};

// Live MCP client instances
const mcpClients = new Map<string, McpClient>();

async function loadModules() {
  const { DASHBOARD_HTML } = await import('../packages/web/src/index.js');
  const { getBuiltInSkills } = await import('../packages/learning/src/built-in-skills.js');
  const { listAgentPresets } = await import('../packages/core/src/agent-presets.js');
  const { listToolsetPresets } = await import('../packages/tools/src/index.js');
  const { listMcpPresetNames, getMcpPresetDescription } = await import('../packages/mcp/src/presets.js');
  return { DASHBOARD_HTML, getBuiltInSkills, listAgentPresets, listToolsetPresets, listMcpPresetNames, getMcpPresetDescription };
}

const mods = await loadModules();
const dashboardHtml = mods.DASHBOARD_HTML as string;

// Pre-load skills
const builtInSkills = mods.getBuiltInSkills();

// Pre-load presets
const agentPresets = mods.listAgentPresets();
const toolsetPresets = mods.listToolsetPresets();
const mcpPresetNames = mods.listMcpPresetNames();
const mcpPresetList = mcpPresetNames.map((name: string) => ({
  name,
  description: mods.getMcpPresetDescription(name),
}));

// Real agent infrastructure
const sessionStore = new InMemorySessionStore();
const checkpointStore = new InMemoryCheckpointStore();
const toolRegistry = new ToolRegistry();

// Register safe dev tools (no workspace/terminal for safety)
toolRegistry.register(createEchoTool());
toolRegistry.register(createTimeTool());
toolRegistry.register(createToolListTool(toolRegistry));
toolRegistry.register(createTodoTool());
toolRegistry.register(createClarifyTool());
toolRegistry.register(createTextPatchTool());
toolRegistry.register(createLinePatchTool());
toolRegistry.register(createWebFetchTool());
toolRegistry.register(createWebSearchTool());
toolRegistry.register(createWebExtractMetadataTool());
toolRegistry.register(createWebExtractLinksTool());
toolRegistry.register(createWebExtractTextTool());

function createProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseUrl = process.env.OPENROUTER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'anthropic/claude-sonnet-4';
  return new OpenAICompatibleProvider({ apiKey, baseUrl, model });
}

function createAgentLoop(): AgentLoop {
  const provider = createProvider();
  const skills: ParsedSkillFile[] = builtInSkills.map((s: Record<string, unknown>) => ({
    manifest: {
      name: s.slug as string,
      description: s.summary as string,
      triggers: s.triggerPhrases as string[],
      tools: [] as string[],
    },
    instructions: (s.steps as string[] || []).join('\n'),
    raw: '',
  }));
  return new AgentLoop(provider, toolRegistry, sessionStore, {
    maxToolIterations: 8,
    stopOnToolError: false,
    concurrentToolCalls: true,
    runtimeName: 'dev-server',
    skills,
    agentPreset: runtimeState.agentPreset ?? undefined,
  });
}

// In-memory sessions
const sessions: Record<string, { messages: Array<{ role: string; content: string; name?: string; createdAt: string }> }> = {};

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function safeJson(raw: string): Record<string, unknown> {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE endpoint — long-lived connection, must not be wrapped in try-catch
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    // Send initial connected event
    res.write(`event: status\ndata: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      const sessionCount = Object.keys(sessions).length;
      const data = {
        timestamp: new Date().toISOString(),
        sessions: sessionCount,
        activePreset: runtimeState.activePreset,
        activeToolset: runtimeState.activeToolset,
        mcpConnections: runtimeState.mcpConnections.size,
      };
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    // Clean up on close
    req.on('close', () => {
      clearInterval(heartbeat);
    });

    return; // Don't fall through to 404
  }

  try {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Dashboard
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml);
    return;
  }

  // Static files from docs/
  if (req.method === 'GET' && url.pathname.startsWith('/docs/')) {
    const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp' };
    const filePath = join(process.cwd(), url.pathname);
    const mime = mimeTypes[extname(filePath)] || 'application/octet-stream';
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' });
      res.end(data);
      return;
    } catch { /* fall through to 404 */ }
  }

  // Health
  if (req.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, service: 'crowclaw', runtime: 'node', version: '0.1.0', uptime: Math.floor(process.uptime()) });
  }

  // System status
  if (req.method === 'GET' && url.pathname === '/api/system/status') {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
    const model = process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'anthropic/claude-sonnet-4';
    const provider = apiKey ? 'openrouter' : 'none';
    return json({
      ok: true,
      service: 'crowclaw',
      runtime: 'node',
      version: '0.1.0',
      deployment: 'dev',
      tools: toolRegistry.list(),
      model: apiKey ? model : 'not configured',
      provider,
      mcp: { toolsRevision: 0, cachedTools: 0, supportsResources: false, supportsPrompts: false, degraded: false },
      plugins: [],
      activePreset: runtimeState.activePreset,
      activeToolset: runtimeState.activeToolset,
      disabledSkillCount: runtimeState.disabledSkills.size,
      configuredGateways: [...runtimeState.gatewayTokens.keys()],
      mcpConnections: Object.fromEntries(runtimeState.mcpConnections),
    });
  }

  // Skills
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    return json({
      skills: builtInSkills.map((s: Record<string, unknown>) => ({
        slug: s.slug, title: s.title, summary: s.summary,
        triggerPhrases: s.triggerPhrases, steps: s.steps, status: s.status,
      })),
      count: builtInSkills.length,
    });
  }

  // Presets
  if (req.method === 'GET' && url.pathname === '/api/presets') {
    return json({ agents: agentPresets, toolsets: toolsetPresets, mcp: mcpPresetList });
  }

  // Gateway status
  if (req.method === 'GET' && url.pathname === '/api/gateway/status') {
    return json({
      platforms: [
        { name: 'telegram', route: '/webhooks/telegram', status: 'webhook-ready', outbound: true },
        { name: 'discord', route: '/webhooks/discord', status: 'webhook-ready', outbound: true },
        { name: 'slack', route: '/webhooks/slack', status: 'webhook-ready', outbound: true },
        { name: 'whatsapp', route: '/webhooks/whatsapp', status: 'webhook-ready', outbound: true },
        { name: 'signal', route: '/webhooks/signal', status: 'webhook-ready', outbound: false },
        { name: 'email', route: '/webhooks/email', status: 'webhook-ready', outbound: true },
        { name: 'matrix', route: '/webhooks/matrix', status: 'webhook-ready', outbound: true },
        { name: 'sms', route: '/webhooks/sms', status: 'webhook-ready', outbound: false },
      ],
    });
  }

  // Skill toggle
  const skillToggle = url.pathname.match(/^\/api\/skills\/([^/]+)\/toggle$/);
  if (req.method === 'POST' && skillToggle) {
    const slug = skillToggle[1];
    const body = safeJson(await readBody(req));
    if (body.enabled) { runtimeState.disabledSkills.delete(slug); }
    else { runtimeState.disabledSkills.add(slug); }
    return json({ ok: true, slug, enabled: body.enabled });
  }

  // Agent preset
  if (req.method === 'POST' && url.pathname === '/api/agent/preset') {
    const body = safeJson(await readBody(req));
    runtimeState.activePreset = body.name;
    runtimeState.agentPreset = body.name ? { role: body.role || '', goal: body.goal || '', backstory: body.backstory } : null;
    return json({ ok: true, activePreset: runtimeState.activePreset });
  }

  // Toolset select
  if (req.method === 'POST' && url.pathname === '/api/toolset/select') {
    const body = safeJson(await readBody(req));
    runtimeState.activeToolset = body.name;
    return json({ ok: true, activeToolset: runtimeState.activeToolset });
  }

  // Gateway platform config
  const gwConfig = url.pathname.match(/^\/api\/gateway\/([^/]+)\/config$/);
  if (req.method === 'POST' && gwConfig) {
    const platform = gwConfig[1];
    const body = safeJson(await readBody(req));
    if (body.token) runtimeState.gatewayTokens.set(platform, body.token);
    return json({ ok: true, platform, configured: runtimeState.gatewayTokens.has(platform) });
  }

  // Gateway probe (simulated)
  const probeMatch = url.pathname.match(/^\/api\/gateway\/([^/]+)\/probe$/);
  if (req.method === 'POST' && probeMatch) {
    const platform = probeMatch[1];
    const body = safeJson(await readBody(req));
    // In dev mode, simulate probe results
    if (body.token || body.webhookUrl) {
      return json({ ok: true, platform, identity: `dev-${platform}-bot`, details: { simulated: true } });
    }
    return json({ ok: false, platform, error: 'Missing token' });
  }

  // Gateway policy
  const policyMatch = url.pathname.match(/^\/api\/gateway\/([^/]+)\/policy$/);
  if (req.method === 'POST' && policyMatch) {
    const platform = policyMatch[1];
    const body = safeJson(await readBody(req));
    return json({ ok: true, platform, policy: body });
  }

  // Pairing
  if (req.method === 'GET' && url.pathname === '/api/gateway/pairings') {
    return json({ pairings: [] });
  }
  if (req.method === 'POST' && url.pathname === '/api/gateway/pairing/approve') {
    return json({ ok: false, error: 'No pending pairings in dev mode' });
  }

  // MCP connect
  if (req.method === 'POST' && url.pathname === '/api/mcp/connect') {
    const body = safeJson(await readBody(req));
    const presetName = body.preset as string;
    if (!presetName) return json({ error: 'Missing preset name' }, 400);

    try {
      // Get preset config
      const presetFn = (mcpPresetConfigs as Record<string, (config?: unknown) => McpStdioServerConfig>)[presetName];
      if (!presetFn) return json({ error: `Unknown preset: ${presetName}` }, 400);

      // Generate config (use defaults for presets that need no config)
      let config: McpStdioServerConfig;
      if (presetName === 'filesystem') {
        config = presetFn({ roots: [process.cwd()] });
      } else if (presetName === 'github') {
        config = presetFn({ token: process.env.GITHUB_TOKEN });
      } else if (presetName === 'braveSearch') {
        const apiKey = process.env.BRAVE_API_KEY;
        if (!apiKey) return json({ error: 'BRAVE_API_KEY not set' }, 400);
        config = presetFn({ apiKey });
      } else {
        config = presetFn();
      }

      // Create client and connect
      const transport = new McpJsonRpcStdioTransport(config, {
        onStderr: (data) => console.error(`[mcp:${presetName}] ${data.trim()}`),
        onClose: (code) => {
          console.log(`[mcp:${presetName}] process exited with code ${code}`);
          mcpClients.delete(presetName);
          runtimeState.mcpConnections.set(presetName, { status: 'disconnected' });
        },
      });
      await transport.connect();
      const client = new McpClient(transport, { toolPrefix: presetName });
      const tools = await client.refreshTools();

      mcpClients.set(presetName, client);
      runtimeState.mcpConnections.set(presetName, {
        status: 'connected',
        connectedAt: new Date().toISOString(),
      });

      return json({
        ok: true,
        preset: presetName,
        status: 'connected',
        tools: tools.map((t) => ({ name: t.registeredName, description: t.description })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      runtimeState.mcpConnections.set(presetName, { status: 'error' });
      return json({ ok: false, preset: presetName, error: msg }, 500);
    }
  }

  // MCP disconnect
  if (req.method === 'POST' && url.pathname === '/api/mcp/disconnect') {
    const body = safeJson(await readBody(req));
    const presetName = body.preset as string;
    if (!presetName) return json({ error: 'Missing preset name' }, 400);

    const client = mcpClients.get(presetName);
    if (client) {
      // Disconnect transport (client doesn't expose disconnect, so access transport)
      mcpClients.delete(presetName);
    }
    runtimeState.mcpConnections.delete(presetName);
    return json({ ok: true, preset: presetName, status: 'disconnected' });
  }

  // List tools from connected MCP servers
  if (req.method === 'GET' && url.pathname === '/api/mcp/tools') {
    const allTools: Array<{ server: string; name: string; description?: string }> = [];
    for (const [name, client] of mcpClients) {
      const tools = await client.listTools();
      tools.forEach((t) => allTools.push({ server: name, name: t.registeredName, description: t.description }));
    }
    return json({ tools: allTools, count: allTools.length });
  }

  // MCP server status
  if (req.method === 'GET' && url.pathname === '/api/mcp/status') {
    const servers: Record<string, unknown> = {};
    for (const [name, client] of mcpClients) {
      servers[name] = client.getStatus();
    }
    return json({ servers, count: mcpClients.size });
  }

  // Provider config (from onboarding)
  if (req.method === 'POST' && url.pathname === '/api/config/provider') {
    const body = safeJson(await readBody(req));
    if (body.apiKey) process.env.OPENROUTER_API_KEY = body.apiKey as string;
    if (body.baseUrl) process.env.OPENROUTER_BASE_URL = body.baseUrl as string;
    if (body.model) process.env.OPENROUTER_MODEL = body.model as string;
    return json({ ok: true, model: body.model, provider: 'openrouter' });
  }

  // Config snapshot
  if (req.method === 'GET' && url.pathname === '/api/config/snapshot') {
    return json({
      ok: true,
      activePreset: runtimeState.activePreset,
      agentPreset: runtimeState.agentPreset,
      activeToolset: runtimeState.activeToolset,
      disabledSkills: [...runtimeState.disabledSkills],
      mcpConnections: Object.fromEntries(runtimeState.mcpConnections),
      gatewayPlatforms: Object.fromEntries([...runtimeState.gatewayTokens].map(([k]) => [k, { configured: true }])),
    });
  }

  // List all sessions
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json({
      sessions: Object.entries(sessions).map(([id, s]) => ({
        sessionId: id,
        messageCount: s.messages.length,
        updatedAt: s.messages.at(-1)?.createdAt || new Date().toISOString(),
        preview: s.messages.at(-1)?.content?.slice(0, 100) || '',
      })),
    });
  }

  // Session message POST
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'POST' && sessionMatch) {
    const sessionId = sessionMatch[1];
    const body = safeJson(await readBody(req));
    const userMessage = body.userMessage as string;
    if (!userMessage) return json({ error: 'Missing userMessage' }, 400);

    // Track in local sessions map for listing
    if (!sessions[sessionId]) sessions[sessionId] = { messages: [] };

    try {
      const loop = createAgentLoop();
      const result = await loop.run({
        agentId: 'crowclaw-dev',
        sessionId,
        userMessage,
      });

      // Sync local session map
      sessions[sessionId].messages = result.session.messages.map((m) => ({
        role: m.role,
        content: m.content,
        name: m.name,
        createdAt: m.createdAt,
      }));

      return json({
        ok: true,
        response: result.finalResponse,
        sessionId,
        toolResults: result.toolResults.map((r) => ({
          toolName: r.toolName,
          ok: r.ok,
          output: r.output.slice(0, 500),
        })),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg }, 500);
    }
  }

  // Session history GET
  const historyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
  if (req.method === 'GET' && historyMatch) {
    const sessionId = historyMatch[1];
    // Try real session store first
    const realSession = await sessionStore.get(sessionId);
    if (realSession) {
      return json({ messages: realSession.messages });
    }
    return json({ messages: sessions[sessionId]?.messages ?? [] });
  }

  // Session memories GET
  const memoriesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/memories$/);
  if (req.method === 'GET' && memoriesMatch) {
    return json({ records: [] });
  }

  // POST /api/sessions/:id/checkpoint — save checkpoint
  const checkpointMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/checkpoint$/);
  if (req.method === 'POST' && checkpointMatch) {
    const sessionId = checkpointMatch[1];
    const session = await sessionStore.get(sessionId);
    if (!session) return json({ error: 'Session not found' }, 404);
    const body = safeJson(await readBody(req));
    const cp = createCheckpoint(
      session,
      [],
      session.messages.length,
      (body.trigger as string) ?? 'manual',
      body.label as string,
    );
    await checkpointStore.save(cp);
    return json({
      ok: true,
      checkpoint: {
        id: cp.id,
        iteration: cp.iteration,
        trigger: cp.metadata.trigger,
        label: cp.metadata.label,
        createdAt: cp.createdAt,
        messageCount: cp.metadata.messageCount,
      },
    });
  }

  // GET /api/sessions/:id/checkpoints — list checkpoints
  const checkpointsListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/checkpoints$/);
  if (req.method === 'GET' && checkpointsListMatch) {
    const sessionId = checkpointsListMatch[1];
    const checkpoints = await checkpointStore.listBySession(sessionId);
    return json({
      checkpoints: checkpoints.map((cp) => ({
        id: cp.id,
        iteration: cp.iteration,
        trigger: cp.metadata.trigger,
        label: cp.metadata.label,
        createdAt: cp.createdAt,
        messageCount: cp.metadata.messageCount,
        toolCallCount: cp.metadata.toolCallCount,
      })),
    });
  }

  // POST /api/sessions/:id/restore — restore to checkpoint
  const restoreMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restore$/);
  if (req.method === 'POST' && restoreMatch) {
    const sessionId = restoreMatch[1];
    const body = safeJson(await readBody(req));
    const cpId = body.checkpointId as string;
    if (!cpId) return json({ error: 'Missing checkpointId' }, 400);
    const checkpoint = await checkpointStore.get(cpId);
    if (!checkpoint) return json({ error: 'Checkpoint not found' }, 404);
    const session = await sessionStore.get(sessionId);
    if (!session) return json({ error: 'Session not found' }, 404);
    const restored = restoreFromCheckpoint(checkpoint, session);
    await sessionStore.put(restored.session);
    return json({ ok: true, restoredTo: cpId, messageCount: restored.session.messages.length });
  }

  // POST /api/sessions/:id/replay — create replay session from checkpoint
  const replayMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/replay$/);
  if (req.method === 'POST' && replayMatch) {
    const sessionId = replayMatch[1];
    const body = safeJson(await readBody(req));
    const cpId = body.checkpointId as string;
    if (!cpId) return json({ error: 'Missing checkpointId' }, 400);
    const checkpoint = await checkpointStore.get(cpId);
    if (!checkpoint) return json({ error: 'Checkpoint not found' }, 404);
    const replaySession = createReplaySession(checkpoint, body.newSessionId as string);
    await sessionStore.put(replaySession);
    return json({ ok: true, sessionId: replaySession.sessionId, messageCount: replaySession.messages.length });
  }

  json({ error: 'Not found' }, 404);
  } catch (err) {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// Graceful MCP shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down MCP connections...');
  for (const [name] of mcpClients) {
    console.log(`  Disconnecting ${name}...`);
    mcpClients.delete(name);
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`CrowClaw dev server running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});

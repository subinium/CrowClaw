/**
 * CrowClaw local development server.
 * Serves the dashboard and all API routes without Cloudflare dependencies.
 *
 * Usage: npx tsx scripts/dev-server.ts
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { AgentLoop, InMemoryCheckpointStore, createCheckpoint, restoreFromCheckpoint, createReplaySession, PersonaRegistry, parseIdentity } from '../packages/core/src/index.js';
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
  createWorkspaceReadTool,
  createWorkspaceWriteTool,
  createWorkspaceListTool,
  createWorkspaceSearchFilesTool,
  createWorkspaceExistsTool,
  createWorkspaceDeleteTool,
  createWorkspaceRenameTool,
  createWorkspacePatchTool,
  createWorkspacePatchTextTool,
} from '../packages/tools/src/index.js';
import { InMemorySessionStore } from '../packages/storage/src/index.js';
import { FileWorkspaceStore } from '../packages/workspace/src/index.js';
import { InMemorySchedulerStore, SchedulerExecutor, AutonomousScheduler, createScheduledAgentJob } from '../packages/scheduler/src/index.js';
import { McpClient, mcpPresets as mcpPresetConfigs, verifyPresetAvailability, type McpStdioServerConfig } from '../packages/mcp/src/index.js';
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

// Persona registry
const personaRegistry = new PersonaRegistry();

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

// Real filesystem workspace store rooted at cwd
const workspaceStore = new FileWorkspaceStore(process.cwd());

// Scheduler infrastructure for dev mode
const schedulerStore = new InMemorySchedulerStore();
const schedulerExecutor = new SchedulerExecutor(
  schedulerStore,
  async (input) => {
    // In dev mode, use a simple echo response for scheduled jobs
    return {
      finalResponse: `[dev-mode] Executed scheduled task: ${input.userMessage}`,
      toolResults: [],
    };
  },
);
const autonomousScheduler = new AutonomousScheduler(schedulerExecutor);

// Register dev tools (including workspace tools backed by real filesystem)
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
toolRegistry.register(createWorkspaceReadTool(workspaceStore));
toolRegistry.register(createWorkspaceWriteTool(workspaceStore));
toolRegistry.register(createWorkspaceListTool(workspaceStore));
toolRegistry.register(createWorkspaceSearchFilesTool(workspaceStore));
toolRegistry.register(createWorkspaceExistsTool(workspaceStore));
toolRegistry.register(createWorkspaceDeleteTool(workspaceStore));
toolRegistry.register(createWorkspaceRenameTool(workspaceStore));
toolRegistry.register(createWorkspacePatchTool(workspaceStore));
toolRegistry.register(createWorkspacePatchTextTool(workspaceStore));

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
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
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

  // Auth verification endpoint
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const dt = process.env.CROWCLAW_DASHBOARD_TOKEN;
    if (!dt) { return json({ ok: true, bypass: true }); }
    const body = safeJson(await readBody(req));
    return json({ ok: body.token === dt });
  }

  // Auth middleware for /api/* routes
  const dt = process.env.CROWCLAW_DASHBOARD_TOKEN;
  if (dt && url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/verify' && url.pathname !== '/api/events') {
    const ah = req.headers['authorization'];
    const tk = typeof ah === 'string' && ah.startsWith('Bearer ') ? ah.slice(7) : null;
    if (tk !== dt) { return json({ error: 'Unauthorized' }, 401); }
  }

  // Session rename
  const rnMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/rename$/);
  if (req.method === 'POST' && rnMatch) {
    const body = safeJson(await readBody(req));
    return json({ ok: true, sessionId: rnMatch[1], name: body.name });
  }

  // Session delete
  const delSessMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'DELETE' && delSessMatch) {
    delete sessions[delSessMatch[1]];
    return json({ ok: true, sessionId: delSessMatch[1] });
  }

  // Memory delete
  const delMemMatch = url.pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (req.method === 'DELETE' && delMemMatch) {
    return json({ ok: true, memoryId: delMemMatch[1] });
  }

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

  // Capabilities — runtime status of each subsystem
  if (req.method === 'GET' && url.pathname === '/api/capabilities') {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '';
    const model = process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || '';
    const hasRealProvider = Boolean(apiKey);
    const hasGatewayTokens = runtimeState.gatewayTokens.size > 0;
    const hasMcpConnections = mcpClients.size > 0;
    const toolCount = toolRegistry.list().length;
    const skillCount = builtInSkills.length;

    return json({
      provider: {
        status: hasRealProvider ? 'live' : 'simulated',
        detail: hasRealProvider ? model || 'configured' : 'EchoProvider (no API key)',
      },
      chat: { status: hasRealProvider ? 'live' : 'simulated' },
      streaming: { status: 'live' },
      tools: { status: 'live', detail: `${toolCount} registered` },
      memory: { status: 'simulated', detail: 'In-memory only' },
      skills: { status: 'live', detail: `${skillCount} built-in` },
      scheduler: { status: 'live' },
      gateway: {
        status: hasGatewayTokens ? 'live' : 'disconnected',
        detail: hasGatewayTokens
          ? `${runtimeState.gatewayTokens.size} platform(s) configured`
          : 'No platforms configured',
      },
      mcp: {
        status: hasMcpConnections ? 'live' : 'disconnected',
        detail: hasMcpConnections
          ? `${mcpClients.size} server(s) connected`
          : 'No servers connected',
      },
      browser: { status: 'simulated' },
      workspace: { status: 'live', detail: 'File-backed' },
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

  // Persona API
  if (req.method === 'GET' && url.pathname === '/api/personas') {
    return json({ personas: personaRegistry.list() });
  }

  if (req.method === 'GET' && url.pathname === '/api/persona/active') {
    const active = personaRegistry.getActive();
    const identity = active.files.identity ? parseIdentity(active.files.identity) : {};
    return json({ name: active.name, identity });
  }

  if (req.method === 'POST' && url.pathname === '/api/persona/switch') {
    const body = safeJson(await readBody(req));
    const name = body.name as string;
    if (!name) return json({ ok: false, error: 'Missing persona name' }, 400);
    try {
      const profile = personaRegistry.switchTo(name);
      return json({ ok: true, active: profile.name });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg }, 400);
    }
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

      // Run verification after connecting
      const verify = await client.verify();

      return json({
        ok: true,
        preset: presetName,
        status: 'connected',
        tools: tools.map((t) => ({ name: t.registeredName, description: t.description })),
        verify,
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

  // MCP verify a connected server
  if (req.method === 'POST' && url.pathname === '/api/mcp/verify') {
    const body = safeJson(await readBody(req));
    const presetName = body.preset as string;
    if (!presetName) return json({ error: 'Missing preset name' }, 400);
    const client = mcpClients.get(presetName);
    if (!client) return json({ ok: false, error: `Server '${presetName}' not connected`, latencyMs: 0 });
    const result = await client.verify();
    return json(result);
  }

  // MCP preset availability status
  if (req.method === 'GET' && url.pathname === '/api/mcp/presets/status') {
    const results = await Promise.all(
      mcpPresetNames.map(async (name: string) => {
        const result = await verifyPresetAvailability(name);
        return { name, ...result };
      })
    );
    return json(results);
  }

  // Provider config (from onboarding)
  if (req.method === 'POST' && url.pathname === '/api/config/provider') {
    const body = safeJson(await readBody(req));
    if (body.apiKey) process.env.OPENROUTER_API_KEY = body.apiKey as string;
    if (body.baseUrl) process.env.OPENROUTER_BASE_URL = body.baseUrl as string;
    if (body.model) process.env.OPENROUTER_MODEL = body.model as string;
    return json({ ok: true, model: body.model, provider: body.provider || 'openrouter' });
  }

  // Provider connection test (onboarding step 3)
  if (req.method === 'POST' && url.pathname === '/api/config/provider/test') {
    const body = safeJson(await readBody(req));
    const apiKey = body.apiKey as string;
    const baseUrl = (body.baseUrl as string) || 'https://openrouter.ai/api/v1';
    const provider = (body.provider as string) || 'openrouter';
    if (!apiKey) return json({ ok: false, error: 'Missing API key' }, 400);
    try {
      let testUrl: string;
      const headers: Record<string, string> = {};
      if (provider === 'anthropic') {
        testUrl = baseUrl.replace(/\/$/, '') + '/v1/messages';
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['content-type'] = 'application/json';
        const testResp = await fetch(testUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'claude-haiku-4', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
        });
        if (testResp.ok || testResp.status === 400) {
          // 400 means auth worked but request was invalid — that's fine for a test
          return json({ ok: true, provider, models: ['claude-sonnet-4', 'claude-4', 'claude-haiku-4'] });
        }
        const errBody = await testResp.text();
        return json({ ok: false, error: `HTTP ${testResp.status}: ${errBody.slice(0, 200)}` });
      } else {
        // OpenAI-compatible (OpenAI, OpenRouter, Custom)
        testUrl = baseUrl.replace(/\/$/, '') + '/chat/completions';
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['content-type'] = 'application/json';
        const testResp = await fetch(testUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
        });
        if (testResp.ok) {
          // Try to list models
          let modelList: string[] = [];
          try {
            const modelsResp = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
              headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (modelsResp.ok) {
              const modelsData = await modelsResp.json() as { data?: Array<{ id: string }> };
              modelList = (modelsData.data || []).slice(0, 20).map((m) => m.id);
            }
          } catch { /* model list is optional */ }
          return json({ ok: true, provider, models: modelList });
        }
        if (testResp.status === 401) {
          return json({ ok: false, error: 'Invalid API key' });
        }
        const errBody = await testResp.text();
        return json({ ok: false, error: `HTTP ${testResp.status}: ${errBody.slice(0, 200)}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, error: msg });
    }
  }

  // --- Provider Config API (fallback chain) ---
  // In-memory provider config for dev mode
  if (!('devProviderConfig' in runtimeState)) {
    (runtimeState as Record<string, unknown>).devProviderConfig = null;
  }

  if (req.method === 'GET' && url.pathname === '/api/providers/config') {
    const cfg = (runtimeState as Record<string, unknown>).devProviderConfig as Record<string, unknown> | null;
    return json({
      ok: true,
      config: cfg ?? null,
      slots: {
        primary: cfg ? (cfg as Record<string, unknown>).primary ?? null : null,
        fallback: cfg ? (cfg as Record<string, unknown>).fallback ?? null : null,
        vision: cfg ? (cfg as Record<string, unknown>).vision ?? null : null,
        compression: cfg ? (cfg as Record<string, unknown>).compression ?? null : null,
        embedding: cfg ? (cfg as Record<string, unknown>).embedding ?? null : null,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/providers/config') {
    const body = safeJson(await readBody(req));
    if (!body.primary || typeof (body.primary as Record<string, unknown>).provider !== 'string') {
      return json({ ok: false, error: 'primary slot with provider and model is required' }, 400);
    }
    (runtimeState as Record<string, unknown>).devProviderConfig = body;
    return json({ ok: true, config: body });
  }

  if (req.method === 'POST' && url.pathname === '/api/providers/test') {
    const body = safeJson(await readBody(req));
    const providerType = body.provider as string;
    const model = body.model as string;
    const apiKey = body.apiKey as string;
    const baseUrl = (body.baseUrl as string) || '';
    const slot = (body.slot as string) || 'test';
    if (!providerType || !model) {
      return json({ ok: false, error: 'provider and model are required' }, 400);
    }
    try {
      const { OpenAICompatibleProvider: OAI, AnthropicProvider: AP } = await import('../packages/providers/src/index.js');
      const testProvider = providerType === 'anthropic'
        ? new AP({ apiKey, baseUrl: baseUrl || 'https://api.anthropic.com', model })
        : new OAI({ apiKey, baseUrl: baseUrl || 'https://api.openai.com/v1', model });
      const testResponse = await testProvider.generate({
        messages: [{ role: 'user', content: 'Say "ok" in one word.', createdAt: new Date().toISOString() }],
        availableTools: [],
      });
      return json({ ok: true, slot, response: (testResponse.assistantMessage ?? '').slice(0, 100) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ ok: false, slot, error: msg });
    }
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

  // Session streaming POST (SSE)
  const streamMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/);
  if (req.method === 'POST' && streamMatch) {
    const sessionId = streamMatch[1];
    const body = safeJson(await readBody(req));
    const userMessage = body.message as string;
    if (!userMessage) { json({ error: 'Missing message' }, 400); return; }

    if (!sessions[sessionId]) sessions[sessionId] = { messages: [] };

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    const abortController = new AbortController();
    req.on('close', () => { abortController.abort(); });

    try {
      const loop = createAgentLoop();

      // Build a session state for streaming
      const existingSession = await sessionStore.get(sessionId);
      const sessionState = existingSession ?? {
        agentId: 'crowclaw-dev',
        sessionId,
        messages: sessions[sessionId].messages.map((m) => ({
          role: m.role as import('../packages/core/src/index.js').Role,
          content: m.content,
          createdAt: m.createdAt,
          name: m.name,
        })),
        updatedAt: new Date().toISOString(),
      };

      if (typeof loop.runStreaming === 'function') {
        for await (const event of loop.runStreaming({
          userMessage,
          sessionState,
          signal: abortController.signal,
        })) {
          if (abortController.signal.aborted) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === 'done') {
            // Sync session messages
            sessions[sessionId].messages.push(
              { role: 'user', content: userMessage, createdAt: new Date().toISOString() },
              { role: 'assistant', content: event.response, createdAt: new Date().toISOString() },
            );
          }
        }
      } else {
        // Fallback to non-streaming
        const result = await loop.run({
          agentId: 'crowclaw-dev',
          sessionId,
          userMessage,
        });
        sessions[sessionId].messages = result.session.messages.map((m) => ({
          role: m.role,
          content: m.content,
          name: m.name,
          createdAt: m.createdAt,
        }));
        res.write(`data: ${JSON.stringify({ type: 'done', response: result.finalResponse })}\n\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
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

  // ---------------------------------------------------------------------------
  // Scheduler routes
  // ---------------------------------------------------------------------------

  if (req.method === 'GET' && url.pathname === '/api/scheduler/jobs') {
    return json(await schedulerStore.listJobs());
  }

  if (req.method === 'POST' && url.pathname === '/api/scheduler/jobs') {
    const body = safeJson(await readBody(req));
    const schedule = (body.schedule as string) ?? `every:${body.everyMinutes ?? 5}m`;
    const job = createScheduledAgentJob({
      id: body.id as string,
      schedule,
      task: body.task as string,
      skillSlugs: body.skillSlugs as string[] | undefined,
      model: body.model as string | undefined,
      maxRuns: body.maxRuns as number | undefined,
      timeoutMs: body.timeoutMs as number | undefined,
    });
    await schedulerStore.saveJob(job);
    return json(job);
  }

  if (req.method === 'POST' && url.pathname === '/api/scheduler/tick') {
    const results = await schedulerExecutor.tick();
    return json({ ok: true, results });
  }

  {
    const jobActionMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)\/(pause|resume|history|dry-run)$/);
    const jobDeleteMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)$/);

    if (req.method === 'POST' && jobActionMatch) {
      const jobId = decodeURIComponent(jobActionMatch[1]);
      const action = jobActionMatch[2];

      if (action === 'pause') {
        const result = await schedulerExecutor.pauseJob(jobId);
        if (!result) return json({ error: 'Job not found' }, 404);
        return json(result);
      }

      if (action === 'resume') {
        const result = await schedulerExecutor.resumeJob(jobId);
        if (!result) return json({ error: 'Job not found' }, 404);
        return json(result);
      }

      if (action === 'dry-run') {
        try {
          const record = await schedulerExecutor.dryRun(jobId);
          return json(record);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg }, 404);
        }
      }
    }

    if (req.method === 'GET' && jobActionMatch) {
      const jobId = decodeURIComponent(jobActionMatch[1]);
      const action = jobActionMatch[2];

      if (action === 'history') {
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        const history = await schedulerStore.getRunHistory(jobId, limit);
        return json(history);
      }
    }

    if (req.method === 'DELETE' && jobDeleteMatch) {
      const jobId = decodeURIComponent(jobDeleteMatch[1]);
      const deleted = await schedulerExecutor.deleteJob(jobId);
      if (!deleted) return json({ error: 'Job not found' }, 404);
      return json({ ok: true });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/scheduler/start') {
    autonomousScheduler.start();
    return json({ ok: true, running: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/scheduler/stop') {
    autonomousScheduler.stop();
    return json({ ok: true, running: false });
  }

  if (req.method === 'GET' && url.pathname === '/api/scheduler/status') {
    return json({
      running: autonomousScheduler.isRunning(),
      interval: autonomousScheduler.interval,
      lastTick: autonomousScheduler.lastTick,
    });
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

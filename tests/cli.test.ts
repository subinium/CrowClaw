import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliInteractiveController, parseCliArgs, renderCliHelp, runCli, runCliInputLine, suggestCliCommands } from '../packages/cli/src/index.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('cli package', () => {
  it('parses chat/session/continue arguments', () => {
    const parsed = parseCliArgs(['chat', '-q', 'hello', '--session', 'demo', '--continue']);
    expect(parsed.command).toBe('chat');
    expect(parsed.query).toBe('hello');
    expect(parsed.sessionId).toBe('demo');
    expect(parsed.continueSession).toBe(true);
  });

  it('renders help text', () => {
    expect(renderCliHelp()).toContain('CrowClaw CLI');
    expect(renderCliHelp()).toContain('version');
    expect(renderCliHelp()).toContain('status');
    expect(renderCliHelp()).toContain('doctor');
    expect(renderCliHelp()).toContain('preflight');
  });

  it('suggests slash commands by prefix', () => {
    expect(suggestCliCommands('/mcp-')).toEqual(['/mcp-tools', '/mcp-status', '/mcp-inspect', '/mcp-resources', '/mcp-prompts', '/mcp-server-tools', '/mcp-server-call', '/mcp-auth', '/mcp-add', '/mcp-list', '/mcp-remove']);
    expect(suggestCliCommands('/bridge-')).toEqual(['/bridge-status', '/bridge-spawn', '/bridge-ping', '/bridge-terminate', '/bridge-capabilities', '/bridge-process', '/bridge-transcript']);
    expect(suggestCliCommands('/terminal-')).toEqual(['/terminal-backends', '/terminal-backend-status', '/terminal-probe', '/terminal-exec', '/terminal-background', '/terminal-processes', '/terminal-kill']);
    expect(suggestCliCommands('/pre')).toEqual(['/preflight']);
    expect(suggestCliCommands('/ver')).toEqual(['/version']);
    expect(suggestCliCommands('/release')).toEqual(['/release-check']);
    expect(suggestCliCommands('/ov')).toEqual(['/overview']);
  });

  it('runs status and tools flows', async () => {
    const status = await runCli(['status']);
    expect(status).toContain('status');

    const tools = await runCli(['tools']);
    expect(typeof tools).toBe('string');
  });

  it('supports slash-command style cli input lines', async () => {
    const cliToken = 'cli-test-token';
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: cliToken,
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mcp.example.com/tools')) {
        return Response.json({ tools: [{ name: 'echo', description: 'Echo tool' }] });
      }
      if (url.includes('mcp.example.com/resources')) {
        return Response.json({ resources: [] });
      }
      if (url.includes('mcp.example.com/prompts')) {
        return Response.json({ prompts: [] });
      }
      return Response.json({});
    }));

    const runtime = createNodeRuntime({
      configStorePath: null,
      initialProviderConfig: {
        primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o' },
        fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-haiku-4' }
      }
    });
    const initial = { sessionId: 'cli-line-demo' };

    const help = await runCliInputLine('/help', initial, { runtime });
    expect(help.output).toContain('CrowClaw CLI');

    const version = await runCliInputLine('/version', initial, { runtime });
    expect(version.output).toContain('"version": "0.1.0"');

    const status = await runCliInputLine('/status', initial, { runtime });
    expect(status.output).toContain('status: ok');

    const doctor = await runCliInputLine('/doctor', initial, { runtime });
    expect(doctor.output).toContain('"service": "crowclaw"');

    const preflight = await runCliInputLine('/preflight', initial, { runtime });
    expect(preflight.output).toContain('"bridgeReady": true');

    const releaseCheck = await runCliInputLine('/release-check', initial, { runtime });
    expect(releaseCheck.output).toContain('"recommendation"');
    expect(releaseCheck.output).toContain('"browser"');
    expect(releaseCheck.output).toContain('"bridgeCapabilities"');
    expect(releaseCheck.output).toContain('"nestedDirectTools"');
    expect(releaseCheck.output).toContain('"directBrowserTools"');
    expect(releaseCheck.output).toContain('"directToolCount"');
    expect(releaseCheck.output).toContain('"transcriptSummary"');
    expect(releaseCheck.output).toContain('"bridgeSummary"');
    expect(releaseCheck.output).toContain('"averageTranscriptEntriesPerSession"');
    expect(releaseCheck.output).toContain('"sessionsWithDirectSocketTraffic"');
    expect(releaseCheck.output).toContain('"toolUsageCounts"');
    expect(releaseCheck.output).toContain('"directToolAliases"');
    expect(releaseCheck.output).toContain('"aliasUsageCounts"');
    expect(releaseCheck.output).toContain('"nestedRequestedAliasCounts"');
    expect(releaseCheck.output).toContain('"directRequestedAliasCounts"');
    expect(releaseCheck.output).toContain('"supportedRequestedAliases"');
    expect(releaseCheck.output).toContain('"directBrowserToolCount"');
    expect(releaseCheck.output).toContain('"supportedRequestedAliasCount"');

    const bridgeStatus = await runCliInputLine('/bridge-status', initial, { runtime });
    expect(bridgeStatus.output).toContain('"status"');
    expect(bridgeStatus.output).toContain('"transcriptSummary"');
    expect(bridgeStatus.output).toContain('"toolUsageCounts"');
    expect(bridgeStatus.output).toContain('"aliasAppliedEntries"');
    expect(bridgeStatus.output).toContain('"directToolAliases"');

    const bridgeSpawn = await runCliInputLine('/bridge-spawn', initial, { runtime });
    expect(bridgeSpawn.output).toContain('"process"');
    expect(bridgeSpawn.output).toContain('"supportedRequestedAliases"');

    const bridgePing = await runCliInputLine('/bridge-ping', initial, { runtime });
    expect(bridgePing.output).toContain('"sessionId"');
    expect(bridgePing.output).toContain('"supportedAliasTargets"');

    const bridgeProcess = await runCliInputLine('/bridge-process', initial, { runtime });
    expect(bridgeProcess.output).toContain('"exists": true');
    expect(bridgeProcess.output).toContain('"directBrowserTools"');
    expect(bridgeProcess.output).toContain('"directToolAliases"');
    expect(bridgeProcess.output).toContain('"supportedRequestedAliases"');
    expect(bridgeProcess.output).toContain('"supportedRequestedAliasCount"');

    const bridgeTranscript = await runCliInputLine('/bridge-transcript', initial, { runtime });
    expect(bridgeTranscript.output).toContain('"transcript"');
    expect(bridgeTranscript.output).toContain('"byTransport"');
    expect(bridgeTranscript.output).toContain('"toolUsageCounts"');
    expect(bridgeTranscript.output).toContain('"nestedAliasAppliedEntries"');

    const bridgeTerminate = await runCliInputLine('/bridge-terminate', initial, { runtime });
    expect(bridgeTerminate.output).toContain('"terminated": true');

    const bridgeCapabilities = await runCliInputLine('/bridge-capabilities', initial, { runtime });
    expect(bridgeCapabilities.output).toContain('"supportedDirectTools"');
    expect(bridgeCapabilities.output).toContain('"supportsNestedCallToolDirect"');
    expect(bridgeCapabilities.output).toContain('"directBrowserTools"');
    expect(bridgeCapabilities.output).toContain('"browser.wait-for"');
    expect(bridgeCapabilities.output).toContain('"supportedAliasTargets"');
    expect(bridgeCapabilities.output).toContain('"supportedAliasTargetCount"');

    const browserSession = await runCliInputLine('/browser-session', initial, { runtime });
    expect(browserSession.output).toContain('"sessionId"');

    const tools = await runCliInputLine('/tools', initial, { runtime });
    expect(tools.output).toContain('echo');

    const mcpTools = await runCliInputLine('/mcp-tools', initial, { runtime });
    expect(mcpTools.output).toContain('echo');

    const mcpStatus = await runCliInputLine('/mcp-status', initial, { runtime });
    expect(mcpStatus.output).toContain('supportsResources');

    const mcpInspect = await runCliInputLine('/mcp-inspect', initial, { runtime });
    expect(mcpInspect.output).toContain('"status"');
    expect(mcpInspect.output).toContain('"tools"');

    const mcpResources = await runCliInputLine('/mcp-resources', initial, { runtime });
    expect(mcpResources.output).toContain('[]');

    const mcpPrompts = await runCliInputLine('/mcp-prompts', initial, { runtime });
    expect(mcpPrompts.output).toContain('[]');

    const mcpServerTools = await runCliInputLine('/mcp-server-tools', initial, { runtime });
    expect(mcpServerTools.output).toContain('crowclaw.chat');

    const mcpServerCall = await runCliInputLine('/mcp-server-call crowclaw.chat hello-from-cli-mcp', initial, { runtime });
    expect(mcpServerCall.output).toContain('CrowClaw received');

    const acpInfo = await runCliInputLine('/acp-info', initial, { runtime });
    expect(acpInfo.output).toContain('"display_name"');

    const acpCreate = await runCliInputLine('/acp-create CLI ACP Session', initial, { runtime });
    expect(acpCreate.output).toContain('"title": "CLI ACP Session"');

    const acpSessions = await runCliInputLine('/acp-sessions', initial, { runtime });
    expect(acpSessions.output).toContain('"sessions"');

    const acpPrompt = await runCliInputLine('/acp-prompt hello-from-cli-acp', initial, { runtime });
    expect(acpPrompt.output).toContain('CrowClaw received');

    const acpRequest = await runCliInputLine('/acp-request {"jsonrpc":"2.0","id":"acp-cli","method":"agent/info"}', initial, { runtime });
    expect(acpRequest.output).toContain('"display_name"');

    const acpDelete = await runCliInputLine('/acp-delete missing-session', initial, { runtime });
    expect(acpDelete.output).toContain('"deleted": false');

    const providerModels = await runCliInputLine('/provider-models', initial, { runtime });
    expect(providerModels.output).toContain('gpt-4o');

    const prevOpenRouter = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-primary-7890';
    const providerPool = await runCliInputLine('/provider-pool openrouter', initial, { runtime });
    expect(providerPool.output).toContain('"provider": "openrouter"');
    expect(providerPool.output).toContain('"configured": true');
    expect(providerPool.output).toContain('7890');
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;

    await runtime.fetch(new Request('http://localhost/api/providers/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o' },
        fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-haiku-4' }
      })
    }));
    const providerPlan = await runCliInputLine('/provider-plan', initial, { runtime });
    expect(providerPlan.output).toContain('"executionPlan"');
    expect(providerPlan.output).toContain('"fallbackChain"');

    const providerFailoverPreview = await runCliInputLine('/provider-failover-preview', initial, { runtime });
    expect(providerFailoverPreview.output).toContain('"simulation"');
    expect(providerFailoverPreview.output).toContain('"fallback-attempt"');

    const providerFailoverSimulate = await runCliInputLine('/provider-failover-simulate prove fallback order', initial, { runtime });
    expect(providerFailoverSimulate.output).toContain('"attempts"');
    expect(providerFailoverSimulate.output).toContain('"slot": "fallback"');

    const providerRoute = await runCliInputLine('/provider-route debug this tool', initial, { runtime });
    expect(providerRoute.output).toContain('"selectedTier"');
    expect(providerRoute.output).toContain('"fallbackTier"');
    expect(providerRoute.output).toContain('"recommendedModels"');

    const skills = await runCliInputLine('/skills', initial, { runtime });
    expect(skills.output).toContain('"skills"');

    const draftCreateRuntime = createNodeRuntime({ configStorePath: null });
    await draftCreateRuntime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cliToken}` },
      body: JSON.stringify({
        title: 'Deploy CrowClaw',
        messages: [
          { role: 'user', content: 'deploy crowclaw' },
          { role: 'assistant', content: 'done and completed' }
        ]
      })
    }));
    const drafts = await runCliInputLine('/drafts', initial, { runtime: draftCreateRuntime });
    expect(drafts.output).toContain('Deploy CrowClaw');

    const createdDraft = await draftCreateRuntime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cliToken}` },
      body: JSON.stringify({
        title: 'Auth Setup',
        messages: [
          { role: 'user', content: 'set up auth' },
          { role: 'assistant', content: 'all done' }
        ]
      })
    }));
    const createdDraftPayload = await createdDraft.json() as { id: string };

    const publishDraft = await runCliInputLine(`/publish-draft ${createdDraftPayload.id}`, initial, { runtime: draftCreateRuntime });
    expect(publishDraft.output).toContain('"published"');

    const matchSkills = await runCliInputLine('/match-skills auth setup', initial, { runtime: draftCreateRuntime });
    expect(matchSkills.output).toContain('Auth Setup');

    const unpublishDraft = await runCliInputLine(`/unpublish-draft ${createdDraftPayload.id}`, initial, { runtime: draftCreateRuntime });
    expect(unpublishDraft.output).toContain('"draft"');

    await draftCreateRuntime.fetch(new Request('http://localhost/api/sessions/cli-line-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${cliToken}` },
      body: JSON.stringify({ userMessage: 'deploy crowclaw' })
    }));
    const autoCapture = await runCliInputLine('/auto-capture', { sessionId: 'cli-line-demo' }, { runtime: draftCreateRuntime });
    expect(autoCapture.output).toContain('auto-cli-line-demo');

    const refineDraft = await runCliInputLine(`/refine-draft ${createdDraftPayload.id} add preview deployment verification`, initial, { runtime: draftCreateRuntime });
    expect(refineDraft.output).toContain('"version": 2');

    const skillShow = await runCliInputLine('/skill-show auth-setup', initial, { runtime: draftCreateRuntime });
    expect(skillShow.output).toContain('"slug": "auth-setup"');

    const skillRate = await runCliInputLine('/skill-rate auth-setup helpful', initial, { runtime: draftCreateRuntime });
    expect(skillRate.output).toContain('"rating": "helpful"');

    const skillVersions = await runCliInputLine('/skill-versions auth-setup', initial, { runtime: draftCreateRuntime });
    expect(skillVersions.output).toContain('"versions"');

    const tempDir = await mkdtemp(join(tmpdir(), 'crowclaw-skill-'));
    const skillPath = join(tempDir, 'SKILL.md');
    await writeFile(skillPath, [
      '# Imported Skill',
      '',
      '## Summary',
      'Imported from disk.',
      '',
      '## Trigger phrases',
      '- imported skill',
      '',
      '## Steps',
      '1. Open file',
      '2. Import skill'
    ].join('\n'), 'utf-8');
    const importSkill = await runCliInputLine(`/skill-import-file ${skillPath}`, initial, { runtime: draftCreateRuntime });
    expect(importSkill.output).toContain('"ok": true');
    expect(importSkill.output).toContain('"slug": "imported-skill"');

    const skillToggle = await runCliInputLine('/skill-toggle git-commit-workflow off', initial, { runtime });
    expect(skillToggle.output).toContain('"enabled": false');

    const resumed = await runCliInputLine('/resume cli-line-2', initial, { runtime });
    expect(resumed.state.sessionId).toBe('cli-line-2');
    expect(resumed.output).toContain('Resumed cli-line-2');

    const reset = await runCliInputLine('/new', resumed.state, { runtime });
    expect(reset.output).toContain('Started new session');
    expect(reset.state.sessionId).not.toBe('cli-line-2');

    const chat = await runCliInputLine('hello from slash cli', reset.state, { runtime });
    expect(chat.output).toContain('CrowClaw received');
    expect(chat.state.sessionId).toBe(reset.state.sessionId);

    const history = await runCliInputLine('/history', chat.state, { runtime });
    // /history now shows persistent CLI command history, not session chat history
    expect(history.output).toMatch(/No command history|Last \d+ commands/);


    const memories = await runCliInputLine('/memories', chat.state, { runtime });
    expect(memories.output).toContain('[');

    const overview = await runCliInputLine('/overview', chat.state, { runtime });
    expect(overview.output).toContain('"system"');
    expect(overview.output).toContain('"preflight"');
    expect(overview.output).toContain('"bridge"');
    expect(overview.output).toContain('"browser"');
    expect(overview.output).toContain('"mcp"');

    const todoAdd = await runCliInputLine('/todo add ship crowclaw', chat.state, { runtime });
    expect(todoAdd.output).toContain('ship crowclaw');

    const todoList = await runCliInputLine('/todo list', chat.state, { runtime });
    expect(todoList.output).toContain('ship crowclaw');

    const clarify = await runCliInputLine('/clarify deployment', chat.state, { runtime });
    expect(clarify.output).toContain('deployment');

    const send = await runCliInputLine('/send slack C123 hello-team', chat.state, { runtime });
    expect(send.output).toContain('"platform": "slack"');

    const vision = await runCliInputLine('/vision describe the image', chat.state, { runtime });
    expect(vision.output).toContain('vision.analyze');

    const image = await runCliInputLine('/image a crowclaw icon', chat.state, { runtime });
    expect(image.output).toContain('image.generate');

    const terminalBackends = await runCliInputLine('/terminal-backends', chat.state, { runtime });
    expect(terminalBackends.output).toContain('"docker"');
    expect(terminalBackends.output).toContain('"daytona"');

    const terminalBackendStatus = await runCliInputLine('/terminal-backend-status', chat.state, { runtime });
    expect(terminalBackendStatus.output).toContain('"installed"');
    expect(terminalBackendStatus.output).toContain('"local"');

    const terminalProbe = await runCliInputLine('/terminal-probe local', chat.state, { runtime });
    expect(terminalProbe.output).toContain('local-ok');

    // #129/#70/#71 — docker container is shell-quoted and pinned to non-root --user.
    const terminalExecPlan = await runCliInputLine('/terminal-exec --backend docker --container demo --cwd /workspace --plan printf hello-terminal-cli', chat.state, { runtime });
    expect(terminalExecPlan.output).toContain("docker exec --user 1000:1000 'demo'");
    expect(terminalExecPlan.output).toContain('/workspace');

    // #128 — Without an explicit approval marker, terminal.exec / terminal.background
    // return approvalRequired:true. Plan-only flows (above) skip the gate by design.
    const cliTempCwd = await mkdtemp(join(tmpdir(), 'crowclaw-cli-terminal-'));
    const terminalExecCwd = await runCliInputLine(`/terminal-exec --cwd ${cliTempCwd} pwd`, chat.state, { runtime });
    expect(terminalExecCwd.output).toContain('Tool requires approval');

    const terminalBackground = await runCliInputLine('/terminal-background sleep 5', chat.state, { runtime });
    expect(terminalBackground.output).toContain('Tool requires approval');

    const terminalProcesses = await runCliInputLine('/terminal-processes', chat.state, { runtime });
    expect(terminalProcesses.output).toContain('"count": 0');
  });

  it('tracks an interactive transcript with stream chunks', async () => {
    const interactiveToken = 'interactive-token';
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: interactiveToken,
      },
    };

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mcp.example.com/tools')) {
        return Response.json({ tools: [{ name: 'echo', description: 'Echo tool' }] });
      }
      if (url.includes('mcp.example.com/resources')) {
        return Response.json({ resources: [] });
      }
      if (url.includes('mcp.example.com/prompts')) {
        return Response.json({ prompts: [] });
      }
      return Response.json({});
    }));

    const controller = new CliInteractiveController({ sessionId: 'interactive-1' }, { runtime: createNodeRuntime() });
    expect(controller.suggest('/st')).toEqual(expect.arrayContaining(['/status', '/stream']));

    const output = await controller.execute('hello interactive');
    expect(output).toContain('CrowClaw received');

    controller.beginStream('tool');
    controller.pushStreamChunk('chunk-1');
    controller.pushStreamChunk('chunk-2');
    controller.endStream();

    const transcript = controller.getTranscript();
    expect(transcript.some((entry) => entry.kind === 'input' && entry.content === 'hello interactive')).toBe(true);
    expect(transcript.some((entry) => entry.kind === 'output' && entry.content.includes('CrowClaw received'))).toBe(true);
    expect(transcript.filter((entry) => entry.kind === 'stream')).toHaveLength(2);
  });
});

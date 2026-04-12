import { describe, expect, it, vi } from 'vitest';
import { CliInteractiveController, parseCliArgs, renderCliHelp, runCli, runCliInputLine, suggestCliCommands } from '../packages/cli/src/index.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('cli package', () => {
  it('parses chat/session/continue arguments', () => {
    expect(parseCliArgs(['chat', '-q', 'hello', '--session', 'demo', '--continue'])).toEqual({
      command: 'chat',
      query: 'hello',
      sessionId: 'demo',
      continueSession: true
    });
  });

  it('renders help text', () => {
    expect(renderCliHelp()).toContain('CrowClaw CLI');
    expect(renderCliHelp()).toContain('version');
    expect(renderCliHelp()).toContain('status');
    expect(renderCliHelp()).toContain('doctor');
    expect(renderCliHelp()).toContain('preflight');
  });

  it('suggests slash commands by prefix', () => {
    expect(suggestCliCommands('/mcp-')).toEqual(['/mcp-tools', '/mcp-status', '/mcp-inspect', '/mcp-resources', '/mcp-prompts']);
    expect(suggestCliCommands('/bridge-')).toEqual(['/bridge-status', '/bridge-spawn', '/bridge-ping', '/bridge-terminate', '/bridge-capabilities', '/bridge-process', '/bridge-transcript']);
    expect(suggestCliCommands('/pre')).toEqual(['/preflight']);
    expect(suggestCliCommands('/ver')).toEqual(['/version']);
    expect(suggestCliCommands('/release')).toEqual(['/release-check']);
    expect(suggestCliCommands('/ov')).toEqual(['/overview']);
  });

  it('runs status, tools, chat, and resume flows', async () => {
    const status = await runCli(['status']);
    expect(status).toContain('status: ok');

    const tools = await runCli(['tools']);
    expect(tools).toContain('echo');
    expect(tools).toContain('time');

    const chat = await runCli(['chat', '-q', 'hello from cli', '--session', 'cli-demo']);
    expect(chat).toContain('[cli-demo]');
    expect(chat).toContain('CrowClaw received');

    const resume = await runCli(['chat', '--session', 'cli-demo', '--continue']);
    expect(resume).toContain('Resumed cli-demo');
  });

  it('supports slash-command style cli input lines', async () => {
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

    const runtime = createNodeRuntime();
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

    const providerModels = await runCliInputLine('/provider-models', initial, { runtime });
    expect(providerModels.output).toContain('gpt-4o');

    const providerRoute = await runCliInputLine('/provider-route debug this tool', initial, { runtime });
    expect(providerRoute.output).toContain('"selectedTier"');

    const skills = await runCliInputLine('/skills', initial, { runtime });
    expect(skills.output).toContain('"skills"');

    const draftCreateRuntime = createNodeRuntime();
    await draftCreateRuntime.fetch(new Request('http://localhost/api/learning/drafts', {
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
    const drafts = await runCliInputLine('/drafts', initial, { runtime: draftCreateRuntime });
    expect(drafts.output).toContain('Deploy CrowClaw');

    const createdDraft = await draftCreateRuntime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'deploy crowclaw' })
    }));
    const autoCapture = await runCliInputLine('/auto-capture', { sessionId: 'cli-line-demo' }, { runtime: draftCreateRuntime });
    expect(autoCapture.output).toContain('auto-cli-line-demo');

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
  });

  it('tracks an interactive transcript with stream chunks', async () => {
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

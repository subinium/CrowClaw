import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, createClarifyTool, createImageGenerateTool, createSendMessageTool, createSkillPreviewTool, createTextPatchTool, createTodoTool, createVisionAnalyzeTool, createWebCrawlTool, createWebExtractTextTool, createWebFetchTool, createWebSearchTool, createTerminalExecTool, createTerminalBackgroundTool, createTerminalBackendsTool, createTerminalBackendStatusTool, createTerminalProbeTool, createTerminalProcessesTool, createTerminalKillTool } from '@crowclaw/tools';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('tool breadth extensions', () => {
  it('fetches text content with the web.fetch tool', async () => {
    const fetchMock = vi.fn(async () => new Response('hello from web', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebFetchTool());
    const result = await registry.execute('web.fetch', { url: 'https://example.com' }, {
      agentId: 'crowclaw',
      sessionId: 'web-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('hello from web');
    expect(result.metadata).toMatchObject({ status: 200, url: 'https://example.com' });
  });

  it('fetches reader-mode markdown with a byte cap', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '<html><body><h1>CrowClaw</h1><p>Readable <a href="/docs">docs</a> content.</p><script>skip()</script></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebFetchTool());
    const result = await registry.execute('web.fetch', {
      url: 'https://example.com',
      format: 'markdown',
      maxBytes: 200,
    }, {
      agentId: 'crowclaw',
      sessionId: 'web-reader'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('# CrowClaw');
    expect(result.output).toContain('[docs](/docs)');
    expect(result.output).not.toContain('skip()');
    expect(result.metadata).toMatchObject({ mode: 'markdown', maxBytes: 200, truncated: false });
  });

  it('defaults web.fetch to a 200KB byte cap', async () => {
    const fetchMock = vi.fn(async () => new Response('x'.repeat(250_000), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebFetchTool());
    const result = await registry.execute('web.fetch', {
      url: 'https://example.com/large',
    }, {
      agentId: 'crowclaw',
      sessionId: 'web-default-cap'
    });

    expect(result.output).toHaveLength(200_000);
    expect(result.metadata).toMatchObject({ maxBytes: 200_000, truncated: true, format: 'raw' });
  });

  it('truncates web.fetch output at maxBytes', async () => {
    const fetchMock = vi.fn(async () => new Response('abcdefghijklmnopqrstuvwxyz', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebFetchTool());
    const result = await registry.execute('web.fetch', {
      url: 'https://example.com',
      maxBytes: 5,
    }, {
      agentId: 'crowclaw',
      sessionId: 'web-cap'
    });

    expect(result.output).toBe('abcde');
    expect(result.metadata).toMatchObject({ bytesRead: 5, truncated: true });
  });

  it('respects web.fetch response charset', async () => {
    const fetchMock = vi.fn(async () => new Response(
      new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
      { status: 200, headers: { 'content-type': 'text/plain; charset=windows-1252' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebFetchTool());
    const result = await registry.execute('web.fetch', {
      url: 'https://example.com/latin1',
    }, {
      agentId: 'crowclaw',
      sessionId: 'web-charset'
    });

    expect(result.output).toBe('café');
  });

  it('applies deterministic replacements with the text.patch tool', async () => {
    const registry = new ToolRegistry().register(createTextPatchTool());
    const result = await registry.execute('text.patch', {
      text: 'hello old world',
      replacements: [
        { from: 'old', to: 'new' },
        { from: 'hello', to: 'hi' }
      ]
    }, {
      agentId: 'crowclaw',
      sessionId: 'patch-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('hi new world');
  });

  it('extracts readable text content with the web.extractText tool', async () => {
    const fetchMock = vi.fn(async () => new Response(`
      <html>
        <head>
          <title>CrowClaw</title>
          <style>.hidden { display:none; }</style>
        </head>
        <body>
          <h1>CrowClaw</h1>
          <p>Readable content here.</p>
          <script>console.log('skip me')</script>
        </body>
      </html>
    `, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebExtractTextTool());
    const result = await registry.execute('web.extractText', { url: 'https://example.com/page' }, {
      agentId: 'crowclaw',
      sessionId: 'text-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('CrowClaw');
    expect(result.output).toContain('Readable content here.');
    expect(result.output).not.toContain('console.log');
  });

  it('returns normalized search results with the web.search tool', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('q=crowclaw');
      return new Response(`
        <html><body>
          <a href="https://example.com/a">CrowClaw Result A</a>
          <a href="https://example.com/b">CrowClaw Result B</a>
        </body></html>
      `, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebSearchTool());
    const result = await registry.execute('web.search', { query: 'crowclaw', limit: 2 }, {
      agentId: 'crowclaw',
      sessionId: 'search-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('CrowClaw Result A');
    expect(result.output).toContain('https://example.com/a');
    expect(result.metadata).toMatchObject({ provider: 'duckduckgo' });
  });

  it('falls back across structured web.search providers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/brave')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('/tavily')) {
        return new Response(JSON.stringify({
          results: [{ title: 'Tavily Result', url: 'https://example.com/tavily', content: 'structured snippet' }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebSearchTool());
    const result = await registry.execute('web.search', {
      query: 'crowclaw',
      providers: [
        { name: 'brave', baseUrl: 'https://example.com/brave', apiKey: 'brave-key' },
        { name: 'tavily', baseUrl: 'https://example.com/tavily', apiKey: 'tavily-key' },
      ],
    }, {
      agentId: 'crowclaw',
      sessionId: 'search-fallback'
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ provider: 'tavily', count: 1 });
    expect(result.output).toContain('Tavily Result');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('crawls linked pages with the web.crawl tool', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://example.com/root') {
        return new Response(`
          <html><body>
            <p>Root page</p>
            <a href="/a">A</a>
          </body></html>
        `, { status: 200 });
      }
      if (url === 'https://example.com/a') {
        return new Response(`
          <html><body>
            <p>Child page</p>
          </body></html>
        `, { status: 200 });
      }
      return new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry().register(createWebCrawlTool());
    const result = await registry.execute('web.crawl', { url: 'https://example.com/root', maxPages: 2 }, {
      agentId: 'crowclaw',
      sessionId: 'crawl-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('https://example.com/root');
    expect(result.output).toContain('https://example.com/a');
    expect(result.output).toContain('Root page');
    expect(result.output).toContain('Child page');
  });

  it('manages todo items per session', async () => {
    const registry = new ToolRegistry().register(createTodoTool());
    const add = await registry.execute('todo.manage', { action: 'add', text: 'ship crowclaw' }, {
      agentId: 'crowclaw',
      sessionId: 'todo-1'
    });
    expect(add.ok).toBe(true);
    const added = JSON.parse(add.output) as { id: string };

    const done = await registry.execute('todo.manage', { action: 'complete', id: added.id }, {
      agentId: 'crowclaw',
      sessionId: 'todo-1'
    });
    expect(done.output).toContain('"done": true');

    const listed = await registry.execute('todo.manage', { action: 'list' }, {
      agentId: 'crowclaw',
      sessionId: 'todo-1'
    });
    expect(listed.output).toContain('ship crowclaw');
  });

  it('generates clarify questions and outbound message payloads', async () => {
    const registry = new ToolRegistry()
      .register(createClarifyTool())
      .register(createSendMessageTool());

    const clarify = await registry.execute('clarify.ask', { topic: 'deployment', unknowns: ['provider', 'region'] }, {
      agentId: 'crowclaw',
      sessionId: 'clarify-1'
    });
    expect(clarify.output).toContain('deployment');

    const send = await registry.execute('send.message', { platform: 'slack', channel: 'C123', text: 'hello team' }, {
      agentId: 'crowclaw',
      sessionId: 'send-1'
    });
    expect(send.ok).toBe(true);
    expect(send.output).toContain('"platform": "slack"');
    expect(send.output).toContain('"url": "https://slack.com/api/chat.postMessage"');
    expect(send.output).toContain('"channel": "C123"');

    const telegram = await registry.execute('send.message', { platform: 'telegram', channel: '99', text: 'hello telegram', botToken: 'abc123' }, {
      agentId: 'crowclaw',
      sessionId: 'send-2'
    });
    expect(telegram.output).toContain('https://api.telegram.org/botabc123/sendMessage');
  });

  it('returns foundation outputs for vision and image generation tools', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/chat/completions')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Vision analysis result' } }]
        }), { status: 200 });
      }
      if (url.includes('/images/generations')) {
        return new Response(JSON.stringify({
          data: [{ url: 'https://example.com/generated.png', revised_prompt: 'revised' }]
        }), { status: 200 });
      }
      return new Response('', { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1024' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry()
      .register(createVisionAnalyzeTool({ apiKey: 'vision-key', providerBaseUrl: 'https://api.openai.com/v1' }))
      .register(createImageGenerateTool({ apiKey: 'image-key', providerBaseUrl: 'https://api.openai.com/v1' }));

    const vision = await registry.execute('vision.analyze', {
      url: 'https://example.com/image.png',
      prompt: 'describe the UI'
    }, {
      agentId: 'crowclaw',
      sessionId: 'vision-1'
    });
    expect(vision.ok).toBe(true);
    expect(vision.output).toContain('Vision analysis result');

    const image = await registry.execute('image.generate', {
      prompt: 'a crowclaw logo in pixel art',
      style: 'pixel-art',
      size: '512x512'
    }, {
      agentId: 'crowclaw',
      sessionId: 'image-1'
    });
    expect(image.ok).toBe(true);
    expect(image.output).toContain('"revisedPrompt": "revised"');
    expect(image.output).toContain('"size": "512x512"');
  });

  it('auto-selects Gemini and Replicate from environment keys', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'google-key');
    vi.stubEnv('REPLICATE_API_TOKEN', 'replicate-key');
    vi.stubEnv('OPENAI_API_KEY', '');

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemini analysis' }] } }]
        }), { status: 200 });
      }
      if (url.includes('api.replicate.com')) {
        return new Response(JSON.stringify({ output: ['https://example.com/replicate.png'] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry()
      .register(createVisionAnalyzeTool())
      .register(createImageGenerateTool());

    const vision = await registry.execute('vision.analyze', {
      url: 'data:image/png;base64,ZmFrZQ==',
    }, {
      agentId: 'crowclaw',
      sessionId: 'vision-env'
    });
    expect(vision.ok).toBe(true);
    expect(vision.metadata).toMatchObject({ provider: 'gemini', model: 'gemini-1.5-flash' });

    const image = await registry.execute('image.generate', {
      prompt: 'a fallback image',
    }, {
      agentId: 'crowclaw',
      sessionId: 'image-env'
    });
    expect(image.ok).toBe(true);
    expect(image.metadata).toMatchObject({ provider: 'replicate' });
  });

  it('supports local terminal exec/background/processes/kill foundations', async () => {
    const registry = new ToolRegistry()
      .register(createTerminalExecTool())
      .register(createTerminalBackgroundTool())
      .register(createTerminalBackendsTool())
      .register(createTerminalBackendStatusTool())
      .register(createTerminalProbeTool())
      .register(createTerminalProcessesTool())
      .register(createTerminalKillTool());

    const backends = await registry.execute('terminal.backends', {}, {
      agentId: 'crowclaw',
      sessionId: 'term-0'
    });
    expect(backends.ok).toBe(true);
    expect(backends.output).toContain('"docker"');
    expect(backends.output).toContain('"ssh"');
    expect(backends.output).toContain('"daytona"');

    const backendStatus = await registry.execute('terminal.backendStatus', {}, {
      agentId: 'crowclaw',
      sessionId: 'term-status'
    });
    expect(backendStatus.ok).toBe(true);
    expect(backendStatus.output).toContain('"installed"');
    expect(backendStatus.output).toContain('"local"');

    const localProbe = await registry.execute('terminal.probe', { backend: 'local' }, {
      agentId: 'crowclaw',
      sessionId: 'term-probe'
    });
    expect(localProbe.ok).toBe(true);
    expect(localProbe.output).toContain('local-ok');

    // #128 — direct registry.execute() lacks the AgentLoop approval gate, so
    // tests that exercise actual execution must opt-in via __approvalGranted.
    const execResult = await registry.execute('terminal.exec', { command: 'printf "hello"', __approvalGranted: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-1'
    });
    expect(execResult.ok).toBe(true);
    expect(execResult.output).toContain('hello');

    const tempCwd = await mkdtemp(join(tmpdir(), 'crowclaw-terminal-tool-'));
    const cwdResult = await registry.execute('terminal.exec', { command: 'pwd', cwd: tempCwd, __approvalGranted: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-cwd'
    });
    expect(cwdResult.ok).toBe(true);
    expect(cwdResult.output).toContain(tempCwd);

    const timeoutResult = await registry.execute('terminal.exec', { command: 'sleep 1', timeoutMs: 10, __approvalGranted: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-timeout'
    });
    expect(timeoutResult.ok).toBe(false);
    expect(String(timeoutResult.metadata?.timeoutMs)).toBe('10');

    const dockerPlan = await registry.execute('terminal.exec', { backend: 'docker', container: 'app', command: 'printf "hello"', planOnly: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-1'
    });
    expect(dockerPlan.ok).toBe(true);
    // #129/#70/#71 — container quoted, --user pinned to non-root uid:gid.
    expect(dockerPlan.output).toContain("docker exec --user 65534:65534 'app'");

    const sshPlan = await registry.execute('terminal.exec', { backend: 'ssh', target: 'demo@example.com', command: 'uname -a', planOnly: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-1'
    });
    expect(sshPlan.ok).toBe(true);
    expect(sshPlan.output).toContain("ssh 'demo@example.com'");

    const background = await registry.execute('terminal.background', { command: 'sleep 5', __approvalGranted: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-2'
    });
    expect(background.ok).toBe(true);
    const bgPayload = JSON.parse(background.output) as { pid: number };

    const processes = await registry.execute('terminal.processes', {}, {
      agentId: 'crowclaw',
      sessionId: 'term-2'
    });
    expect(processes.output).toContain('"pid"');
    expect(processes.output).toContain('"backend"');

    const kill = await registry.execute('terminal.kill', { pid: bgPayload.pid }, {
      agentId: 'crowclaw',
      sessionId: 'term-2'
    });
    expect(kill.ok).toBe(true);
    expect(kill.output).toContain('"killed"');
  });

  it('isolates terminal background process tracking by session', async () => {
    const registry = new ToolRegistry()
      .register(createTerminalBackgroundTool())
      .register(createTerminalProcessesTool())
      .register(createTerminalKillTool());

    const started = await registry.execute('terminal.background', { command: 'sleep 5', __approvalGranted: true }, {
      agentId: 'crowclaw',
      sessionId: 'term-isolated-a'
    });
    expect(started.ok).toBe(true);
    const payload = JSON.parse(started.output) as { pid: number };

    const sameSession = await registry.execute('terminal.processes', {}, {
      agentId: 'crowclaw',
      sessionId: 'term-isolated-a'
    });
    expect(sameSession.output).toContain(String(payload.pid));

    const otherSession = await registry.execute('terminal.processes', {}, {
      agentId: 'crowclaw',
      sessionId: 'term-isolated-b'
    });
    expect(otherSession.output).not.toContain(String(payload.pid));

    await registry.execute('terminal.kill', { pid: payload.pid }, {
      agentId: 'crowclaw',
      sessionId: 'term-isolated-a'
    });
  });

  it('previews skill manifests without installing or executing them', async () => {
    const registry = new ToolRegistry().register(createSkillPreviewTool());
    const result = await registry.execute('skill.preview', {
      content: `---\nname: demo-skill\ndescription: Demo skill\ntriggers:\n  - demo\ntools:\n  - workspace.read\n---\nUse this skill to inspect a workspace safely.`,
      maxChars: 20,
    }, {
      agentId: 'crowclaw',
      sessionId: 'skill-preview'
    });

    expect(result.ok).toBe(true);
    const preview = JSON.parse(result.output) as { name: string; tools: string[]; instructionPreview: string };
    expect(preview.name).toBe('demo-skill');
    expect(preview.tools).toEqual(['workspace.read']);
    expect(preview.instructionPreview.length).toBeLessThanOrEqual(20);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserBackTool,
  CloudflareSandboxExecutor,
  createBrowserClickTool,
  createBrowserClickRefTool,
  createBrowserConsoleTool,
  createBrowserExtractTool,
  createBrowserGotoTool,
  createBrowserImagesTool,
  createBrowserNavigateTool,
  createBrowserOpenTool,
  createBrowserPressTool,
  createBrowserScrollTool,
  createBrowserSnapshotTool,
  createBrowserTypeTool,
  createBrowserVisionTool,
  createBrowserWaitForTool,
  createCodeExecTool,
  createFileDeleteTool,
  createFileExistsTool,
  createFileReadTool,
  createFileWriteTool,
  createNodeExecTool,
  createPythonExecTool,
  createTerminalTool
} from '@crowclaw/sandbox-executor';

const { getSandboxMock } = vi.hoisted(() => ({
  getSandboxMock: vi.fn()
}));

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: getSandboxMock
}));

describe('sandbox tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses executor fallback for terminal.exec when sandbox binding is absent', async () => {
    const executor = new CloudflareSandboxExecutor();
    const tool = createTerminalTool(executor);

    const result = await tool.execute({ command: 'pwd', cwd: '/workspace/demo' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-1',
      workspaceId: 'workspace-1'
    });

    expect(result.ok).toBe(true);
    expect(result.runtime).toBe('sandbox');
    expect(result.output).toContain('[sandbox] Command queued for Cloudflare container execution: cd /workspace/demo && pwd');
    expect(result.metadata).toMatchObject({ exitCode: 0 });
  });

  it('uses bound sandbox for terminal.exec when available', async () => {
    getSandboxMock.mockReturnValue({
      exec: vi.fn(async (command: string, options?: { cwd?: string }) => ({
        success: true,
        stdout: `ran:${command}:${options?.cwd ?? ''}`,
        stderr: '',
        exitCode: 0
      }))
    });

    const tool = createTerminalTool(new CloudflareSandboxExecutor());
    const result = await tool.execute({ command: 'ls', cwd: '/workspace/app' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-2',
      workspaceId: 'workspace-2',
      env: { Sandbox: {} }
    });

    expect(getSandboxMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.output).toContain('ran:ls:/workspace/app');
    expect(result.metadata).toMatchObject({ exitCode: 0 });
  });

  it('reads and writes files through a bound sandbox', async () => {
    getSandboxMock.mockReturnValue({
      readFile: vi.fn(async (path: string) => ({
        success: true,
        content: `content:${path}`,
        mimeType: 'text/plain'
      })),
      writeFile: vi.fn(async (_path: string, _content: string) => ({
        success: true
      }))
    });

    const executor = new CloudflareSandboxExecutor();
    const readTool = createFileReadTool(executor);
    const writeTool = createFileWriteTool(executor);
    const context = {
      agentId: 'crowclaw',
      sessionId: 'sandbox-3',
      workspaceId: 'workspace-3',
      env: { Sandbox: {} }
    };

    const read = await readTool.execute({ path: '/workspace/README.md' }, context);
    expect(read.ok).toBe(true);
    expect(read.output).toBe('content:/workspace/README.md');
    expect(read.metadata).toMatchObject({ path: '/workspace/README.md', mimeType: 'text/plain' });

    const write = await writeTool.execute({ path: '/workspace/output.txt', content: 'hello' }, context);
    expect(write.ok).toBe(true);
    expect(write.output).toContain('Wrote /workspace/output.txt');
  });

  it('checks existence and deletes files through a bound sandbox', async () => {
    getSandboxMock.mockReturnValue({
      readFile: vi.fn(async (path: string) => ({
        success: path === '/workspace/found.txt',
        content: path === '/workspace/found.txt' ? 'found' : '',
        mimeType: 'text/plain'
      })),
      deleteFile: vi.fn(async (_path: string) => ({
        success: true
      }))
    });

    const executor = new CloudflareSandboxExecutor();
    const existsTool = createFileExistsTool(executor);
    const deleteTool = createFileDeleteTool(executor);
    const context = {
      agentId: 'crowclaw',
      sessionId: 'sandbox-3b',
      workspaceId: 'workspace-3b',
      env: { Sandbox: {} }
    };

    const exists = await existsTool.execute({ path: '/workspace/found.txt' }, context);
    expect(exists.ok).toBe(true);
    expect(exists.output).toContain('"exists":true');

    const deleted = await deleteTool.execute({ path: '/workspace/found.txt' }, context);
    expect(deleted.ok).toBe(true);
    expect(deleted.output).toContain('Deleted /workspace/found.txt');
  });

  it('uses local fs fallback when file sandbox binding is absent', async () => {
    const executor = new CloudflareSandboxExecutor();
    const readTool = createFileReadTool(executor);
    const existsTool = createFileExistsTool(executor);
    const deleteTool = createFileDeleteTool(executor);
    const context = {
      agentId: 'crowclaw',
      sessionId: 'sandbox-4',
      workspaceId: 'workspace-4'
    };

    const read = await readTool.execute({ path: '/workspace/missing-nonexistent-xyz.txt' }, context);
    expect(read.ok).toBe(false);
    expect(read.output).toContain('Failed to read file');

    const exists = await existsTool.execute({ path: '/workspace/missing-nonexistent-xyz.txt' }, context);
    expect(exists.ok).toBe(true);
    expect(exists.output).toContain('"exists":false');

    const deleted = await deleteTool.execute({ path: '/workspace/missing-nonexistent-xyz.txt' }, context);
    expect(deleted.ok).toBe(false);
    expect(deleted.output).toContain('Failed to delete');
  });

  it('returns a useful error when sandbox delete is unsupported', async () => {
    getSandboxMock.mockReturnValue({
      readFile: vi.fn(async () => ({
        success: true,
        content: 'found',
        mimeType: 'text/plain'
      }))
    });

    const deleteTool = createFileDeleteTool(new CloudflareSandboxExecutor());
    const result = await deleteTool.execute({ path: '/workspace/file.txt' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-5',
      workspaceId: 'workspace-5',
      env: { Sandbox: {} }
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('delete operation is not supported');
  });

  it('executes code through executor fallback when sandbox binding is absent', async () => {
    const tool = createCodeExecTool(new CloudflareSandboxExecutor());

    const result = await tool.execute({
      language: 'python',
      code: 'print(\"hi\")',
      cwd: '/workspace/demo',
      timeoutMs: 2500,
      toolBridge: true,
      maxToolCalls: 3
    }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-6',
      workspaceId: 'workspace-6'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('python -c');
    expect(result.metadata).toMatchObject({
      language: 'python',
      timeoutMs: 2500,
      toolBridgeRequested: true,
      toolBridgeMode: 'session-artifacts',
      maxToolCalls: 3,
      timedOut: false
    });
    expect(result.metadata).toHaveProperty('stdout');
    expect(result.metadata).toHaveProperty('stderr');
    expect(result.metadata).toHaveProperty('command');
    expect(result.metadata).toHaveProperty('bridgeArtifacts');
    expect((result.metadata as { bridgeArtifacts?: { protocolVersion: string; socketPath: string; bootstrapPython: string } }).bridgeArtifacts).toMatchObject({
      protocolVersion: 'crowclaw-tool-bridge/v1'
    });
    expect((result.metadata as { bridgeArtifacts?: { socketPath: string; bootstrapPython: string } }).bridgeArtifacts?.socketPath).toContain('crow-tool-bridge');
    expect((result.metadata as { bridgeArtifacts?: { bootstrapPython: string } }).bridgeArtifacts?.bootstrapPython).toContain('def call_tool');
  });

  it('executes code through a bound sandbox when available', async () => {
    getSandboxMock.mockReturnValue({
      exec: vi.fn(async (command: string, options?: { cwd?: string }) => ({
        success: true,
        stdout: `code:${command}:${options?.cwd ?? ''}`,
        stderr: '',
        exitCode: 0
      }))
    });

    const tool = createCodeExecTool(new CloudflareSandboxExecutor());
    const result = await tool.execute({
      language: 'javascript',
      code: 'console.log(\"hi\")',
      cwd: '/workspace/app'
    }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-7',
      workspaceId: 'workspace-7',
      env: { Sandbox: {} }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('node -e');
    expect(result.output).toContain('/workspace/app');
    expect(result.metadata).toMatchObject({ language: 'javascript', exitCode: 0 });
  });

  it('returns a useful error for unsupported code languages', async () => {
    const tool = createCodeExecTool(new CloudflareSandboxExecutor());
    const result = await tool.execute({
      language: 'ruby',
      code: 'puts :hi'
    }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-8',
      workspaceId: 'workspace-8'
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Unsupported language');
  });

  it('executes node.exec and python.exec through the shared code runner', async () => {
    const nodeTool = createNodeExecTool(new CloudflareSandboxExecutor());
    const pythonTool = createPythonExecTool(new CloudflareSandboxExecutor());

    const nodeResult = await nodeTool.execute({
      code: 'console.log("hi")',
      cwd: '/workspace/node-app',
      timeoutMs: 1800,
      toolBridge: true,
      maxToolCalls: 2
    }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-8a',
      workspaceId: 'workspace-8a'
    });

    const pythonResult = await pythonTool.execute({
      code: 'print("hi")',
      cwd: '/workspace/python-app'
    }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-8b',
      workspaceId: 'workspace-8b'
    });

    expect(nodeResult.ok).toBe(true);
    expect(nodeResult.toolName).toBe('node.exec');
    expect(nodeResult.output).toContain('node -e');
    expect(nodeResult.metadata).toMatchObject({
      language: 'javascript',
      timeoutMs: 1800,
      toolBridgeRequested: true,
      maxToolCalls: 2,
      toolBridgeMode: 'session-artifacts'
    });
    expect((nodeResult.metadata as { bridgeArtifacts?: { modulePath: string } }).bridgeArtifacts?.modulePath).toContain('crow_tools_');

    expect(pythonResult.ok).toBe(true);
    expect(pythonResult.toolName).toBe('python.exec');
    expect(pythonResult.output).toContain('python -c');
    expect(pythonResult.metadata).toMatchObject({ language: 'python', toolBridgeRequested: false });
  });

  it('navigates through browser.goto with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserGotoTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-9'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('Simulated browser navigation');

    getSandboxMock.mockReturnValue({
      goto: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/final`,
        title: 'Example Title'
      }))
    });

    const boundTool = createBrowserGotoTool();
    const bound = await boundTool.execute({ url: 'https://example.com' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Opened https://example.com/final');
    expect(bound.metadata).toMatchObject({ finalUrl: 'https://example.com/final', title: 'Example Title' });
  });

  it('opens through browser.open with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserOpenTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com/open' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10a'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.toolName).toBe('browser.open');
    expect(fallback.output).toContain('Simulated browser navigation');

    getSandboxMock.mockReturnValue({
      goto: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/opened`,
        title: 'Opened Title'
      }))
    });

    const boundTool = createBrowserOpenTool();
    const bound = await boundTool.execute({ url: 'https://example.com/open' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10b',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Opened https://example.com/open/opened');
    expect(bound.metadata).toMatchObject({ finalUrl: 'https://example.com/open/opened', title: 'Opened Title' });
  });

  it('navigates through browser.navigate with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserNavigateTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com/navigate' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10ba'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.toolName).toBe('browser.navigate');
    expect(fallback.output).toContain('Simulated browser navigation');

    getSandboxMock.mockReturnValue({
      goto: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/navigated`,
        title: 'Navigate Title'
      }))
    });

    const boundTool = createBrowserNavigateTool();
    const bound = await boundTool.execute({ url: 'https://example.com/navigate' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10bb',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Opened https://example.com/navigate/navigated');
    expect(bound.metadata).toMatchObject({ finalUrl: 'https://example.com/navigate/navigated', title: 'Navigate Title' });
  });

  it('captures browser.snapshot with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserSnapshotTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com', full: true }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10bc'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('[@e1]');
    expect(fallback.metadata).toMatchObject({ simulated: true, full: true });

    getSandboxMock.mockReturnValue({
      snapshot: vi.fn(async (_url: string, options?: { full?: boolean }) => ({
        success: true,
        snapshot: options?.full ? '[@e1] button \"Run\"' : '[@e1] link \"Home\"',
        refs: ['@e1'],
        title: 'Snapshot Title',
        full: options?.full ?? false
      }))
    });

    const boundTool = createBrowserSnapshotTool();
    const bound = await boundTool.execute({ url: 'https://example.com', full: false }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10bd',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toBe('[@e1] link \"Home\"');
    expect(bound.metadata).toMatchObject({ refs: ['@e1'], title: 'Snapshot Title', full: false });
  });

  it('waits through browser.waitFor with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserWaitForTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com', selector: '#ready', timeoutMs: 1500 }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10c'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('Simulated wait');
    expect(fallback.metadata).toMatchObject({ selector: '#ready', timeoutMs: 1500, matched: true });

    getSandboxMock.mockReturnValue({
      waitFor: vi.fn(async (url: string, options?: { selector?: string; timeoutMs?: number }) => ({
        success: true,
        selector: options?.selector,
        timeoutMs: options?.timeoutMs,
        finalUrl: `${url}/ready`,
        matched: true
      }))
    });

    const boundTool = createBrowserWaitForTool();
    const bound = await boundTool.execute({ url: 'https://example.com', selector: '#ready', timeoutMs: 1500 }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-10d',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Waited for #ready');
    expect(bound.metadata).toMatchObject({ selector: '#ready', timeoutMs: 1500, finalUrl: 'https://example.com/ready', matched: true });
  });

  it('extracts content through browser.extract with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserExtractTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com', selector: '#main' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-11'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('Simulated extraction');

    getSandboxMock.mockReturnValue({
      extract: vi.fn(async (_url: string, options?: { selector?: string }) => ({
        success: true,
        content: `content:${options?.selector ?? 'body'}`
      }))
    });

    const boundTool = createBrowserExtractTool();
    const bound = await boundTool.execute({ url: 'https://example.com', selector: '#main' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-12',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toBe('content:#main');
    expect(bound.metadata).toMatchObject({ selector: '#main', url: 'https://example.com' });
  });

  it('clicks through browser.click with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserClickTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com', selector: '#submit' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-13'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('Simulated click');

    getSandboxMock.mockReturnValue({
      click: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/clicked`
      }))
    });

    const boundTool = createBrowserClickTool();
    const bound = await boundTool.execute({ url: 'https://example.com', selector: '#submit' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-14',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Clicked #submit at https://example.com');
    expect(bound.metadata).toMatchObject({ selector: '#submit', finalUrl: 'https://example.com/clicked' });
  });

  it('types through browser.type with fallback and bound sandbox behavior', async () => {
    const fallbackTool = createBrowserTypeTool();
    const fallback = await fallbackTool.execute({ url: 'https://example.com', selector: '#input', text: 'hello' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-15'
    });
    expect(fallback.ok).toBe(true);
    expect(fallback.output).toContain('Simulated typing');

    getSandboxMock.mockReturnValue({
      type: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/typed`
      }))
    });

    const boundTool = createBrowserTypeTool();
    const bound = await boundTool.execute({ url: 'https://example.com', selector: '#input', text: 'hello' }, {
      agentId: 'crowclaw',
      sessionId: 'sandbox-16',
      env: { Sandbox: {} }
    });
    expect(bound.ok).toBe(true);
    expect(bound.output).toContain('Typed into #input');
    expect(bound.metadata).toMatchObject({ selector: '#input', text: 'hello', finalUrl: 'https://example.com/typed' });
  });

  it('supports advanced browser actions with fallback and bound sandbox behavior', async () => {
    const back = await createBrowserBackTool().execute({ steps: 2 }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-1' });
    const scroll = await createBrowserScrollTool().execute({ url: 'https://example.com', direction: 'down', amount: 3 }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-2' });
    const press = await createBrowserPressTool().execute({ url: 'https://example.com', key: 'Enter' }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-3' });
    const consoleResult = await createBrowserConsoleTool().execute({ url: 'https://example.com' }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-4' });
    const vision = await createBrowserVisionTool().execute({ url: 'https://example.com', prompt: 'Summarize' }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-5' });
    const images = await createBrowserImagesTool().execute({ url: 'https://example.com', limit: 1 }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-6' });
    const clickRef = await createBrowserClickRefTool().execute({ url: 'https://example.com', ref: '@e1' }, { agentId: 'crowclaw', sessionId: 'sandbox-adv-7' });

    expect(back.metadata).toMatchObject({ simulated: true, steps: 2 });
    expect(scroll.output).toContain('Simulated scroll down');
    expect(press.output).toContain('Simulated key press Enter');
    expect(consoleResult.output).toContain('Simulated console log');
    expect(vision.output).toContain('Simulated vision analysis');
    expect(images.output).toContain('@img1');
    expect(clickRef.output).toContain('Simulated click on ref @e1');

    getSandboxMock.mockReturnValue({
      back: vi.fn(async (options?: { steps?: number }) => ({ success: true, steps: options?.steps ?? 1, finalUrl: 'https://example.com/back' })),
      scroll: vi.fn(async (_url: string, options?: { direction?: string; amount?: number }) => ({ success: true, direction: options?.direction, amount: options?.amount, finalUrl: 'https://example.com/scrolled' })),
      press: vi.fn(async (_url: string, options?: { key?: string }) => ({ success: true, key: options?.key, finalUrl: 'https://example.com/pressed' })),
      consoleMessages: vi.fn(async () => ({ success: true, logs: [{ level: 'warn', message: 'warn log' }] })),
      vision: vi.fn(async (_url: string, options?: { prompt?: string }) => ({ success: true, analysis: `analysis:${options?.prompt}` })),
      images: vi.fn(async () => ({ success: true, images: [{ ref: '@img9', src: 'https://example.com/asset.png', alt: 'Asset' }] })),
      clickRef: vi.fn(async (_url: string, options?: { ref?: string }) => ({ success: true, ref: options?.ref, finalUrl: 'https://example.com/ref-clicked' }))
    });

    const context = { agentId: 'crowclaw', sessionId: 'sandbox-adv-8', env: { Sandbox: {} } };
    const boundBack = await createBrowserBackTool().execute({ steps: 2 }, context);
    const boundScroll = await createBrowserScrollTool().execute({ url: 'https://example.com', direction: 'down', amount: 3 }, context);
    const boundPress = await createBrowserPressTool().execute({ url: 'https://example.com', key: 'Enter' }, context);
    const boundConsole = await createBrowserConsoleTool().execute({ url: 'https://example.com' }, context);
    const boundVision = await createBrowserVisionTool().execute({ url: 'https://example.com', prompt: 'Summarize' }, context);
    const boundImages = await createBrowserImagesTool().execute({ url: 'https://example.com', limit: 1 }, context);
    const boundClickRef = await createBrowserClickRefTool().execute({ url: 'https://example.com', ref: '@e1' }, context);

    expect(boundBack.metadata).toMatchObject({ steps: 2, finalUrl: 'https://example.com/back' });
    expect(boundScroll.metadata).toMatchObject({ direction: 'down', amount: 3, finalUrl: 'https://example.com/scrolled' });
    expect(boundPress.metadata).toMatchObject({ key: 'Enter', finalUrl: 'https://example.com/pressed' });
    expect(boundConsole.output).toContain('warn log');
    expect(boundVision.output).toBe('analysis:Summarize');
    expect(boundImages.output).toContain('@img9');
    expect(boundClickRef.metadata).toMatchObject({ ref: '@e1', finalUrl: 'https://example.com/ref-clicked' });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ToolRegistry,
  createTerminalExecTool,
  createTerminalBackgroundTool,
  createWebFetchTool,
  createWebExtractMetadataTool,
  createWebExtractLinksTool,
  createWebExtractTextTool,
  createWebSearchTool,
  createWebCrawlTool,
} from '@crowclaw/tools';

/**
 * v0.6.0 — packages/tools security sweep:
 *   #129 — shell-quote / regex-validate docker image+container, ssh target
 *   #70  — docker run hardening flags (no-new-privileges, cap-drop ALL)
 *   #71  — uid/gid pinning on docker exec/run via --user
 *   #128 — defensive in-tool approval gate for terminal.exec / terminal.background
 *   #138 — DNS-rebinding-aware SSRF preflight (resolveAndValidateUrl) and
 *          redirect: 'manual' on every web.* fetch site
 */

const baseCtx = { agentId: 'crowclaw', sessionId: 'tools-v06-security' };

// ---------------------------------------------------------------------------
// #129 — shell-quote + allowlist on docker container/image and ssh target
// ---------------------------------------------------------------------------

describe('#129 docker / ssh identifier validation', () => {
  it('rejects docker container names with shell metacharacters', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      container: 'evil; rm -rf /',
      command: 'whoami',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Docker container name rejected');
  });

  it('rejects docker container names that start with a hyphen (flag injection)', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      container: '--privileged',
      command: 'whoami',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Docker container name rejected');
  });

  it('rejects docker images with whitespace / shell separators', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      image: 'alpine; curl evil.com',
      command: 'whoami',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Docker image name rejected');
  });

  it('rejects ssh targets with shell metacharacters', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'ssh',
      target: 'user@host;rm -rf /',
      command: 'uname -a',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('SSH target rejected');
  });

  it('accepts a normal docker image and shell-quotes it', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      image: 'node:20-alpine',
      command: 'node -v',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    // Image must appear single-quoted in the resolved command
    expect(result.output).toContain("'node:20-alpine'");
  });

  it('accepts a normal ssh target and shell-quotes it', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'ssh',
      target: 'deploy@host.example.com',
      command: 'uname -a',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("'deploy@host.example.com'");
  });
});

// ---------------------------------------------------------------------------
// #70 / #71 — docker hardening flags (no-new-privileges, cap-drop ALL, --user)
// ---------------------------------------------------------------------------

describe('#70 / #71 docker hardening flags on run/exec', () => {
  it('docker run includes --security-opt no-new-privileges, --cap-drop ALL, and --user', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      image: 'alpine',
      command: 'echo hello',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('--security-opt no-new-privileges');
    expect(result.output).toContain('--cap-drop ALL');
    expect(result.output).toContain('--user 1000:1000');
  });

  it('docker exec includes --user 1000:1000 (uid/gid on cross-boundary call)', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      backend: 'docker',
      container: 'demo-app',
      command: 'echo hello',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('--user 1000:1000');
  });

  it('terminal.background docker plan also gets hardening flags', async () => {
    const registry = new ToolRegistry().register(createTerminalBackgroundTool());
    const result = await registry.execute('terminal.background', {
      backend: 'docker',
      image: 'busybox',
      command: 'sleep 30',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('--security-opt no-new-privileges');
    expect(result.output).toContain('--cap-drop ALL');
    expect(result.output).toContain('--user 1000:1000');
  });
});

// ---------------------------------------------------------------------------
// #128 — defensive approval gate
// ---------------------------------------------------------------------------

describe('#128 defensive in-tool approval gate', () => {
  it('terminal.exec returns approvalRequired:true when no gate context is present', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', { command: 'echo hi' }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Tool requires approval');
    expect(result.metadata).toMatchObject({ approvalRequired: true });
  });

  it('terminal.background returns approvalRequired:true when no gate context is present', async () => {
    const registry = new ToolRegistry().register(createTerminalBackgroundTool());
    const result = await registry.execute('terminal.background', { command: 'sleep 1' }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Tool requires approval');
    expect(result.metadata).toMatchObject({ approvalRequired: true });
  });

  it('planOnly bypasses the approval gate (no execution happens)', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      command: 'echo hi',
      planOnly: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ planOnly: true });
  });

  it('input.__approvalGranted=true bypasses the gate', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', {
      command: 'printf "approved-ok"',
      __approvalGranted: true,
    }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('approved-ok');
  });

  it('context.env.crowclawApprovalGranted=true bypasses the gate', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', { command: 'printf "env-ok"' }, {
      ...baseCtx,
      env: { crowclawApprovalGranted: true },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('env-ok');
  });

  it('context.approval callback function bypasses the gate', async () => {
    const registry = new ToolRegistry().register(createTerminalExecTool());
    const result = await registry.execute('terminal.exec', { command: 'printf "cb-ok"' }, {
      ...baseCtx,
      // Cast: forward-compat with a future ToolExecutionContext shape that
      // adds an approval callback.
      approval: async () => true,
    } as unknown as Parameters<typeof registry.execute>[2]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('cb-ok');
  });
});

// ---------------------------------------------------------------------------
// #138 — DNS-rebinding-aware SSRF preflight + redirect:'manual'
// ---------------------------------------------------------------------------

describe('#138 web.* fetch sites use SSRF preflight + redirect:manual', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cases: Array<{ name: string; build: () => ToolRegistry; input: Record<string, unknown> }> = [
    { name: 'web.fetch', build: () => new ToolRegistry().register(createWebFetchTool()), input: { url: 'http://127.0.0.1/' } },
    { name: 'web.extractMetadata', build: () => new ToolRegistry().register(createWebExtractMetadataTool()), input: { url: 'http://10.0.0.1/' } },
    { name: 'web.extractLinks', build: () => new ToolRegistry().register(createWebExtractLinksTool()), input: { url: 'http://192.168.1.1/' } },
    { name: 'web.extractText', build: () => new ToolRegistry().register(createWebExtractTextTool()), input: { url: 'http://localhost/' } },
    { name: 'web.search', build: () => new ToolRegistry().register(createWebSearchTool()), input: { query: 'test', providerBaseUrl: 'http://127.0.0.1/' } },
    { name: 'web.crawl', build: () => new ToolRegistry().register(createWebCrawlTool()), input: { url: 'http://169.254.169.254/' } },
  ];

  for (const tc of cases) {
    it(`${tc.name} blocks private URLs before any fetch call`, async () => {
      const fetchSpy = vi.fn(async () => new Response('should not be reached'));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await tc.build().execute(tc.name, tc.input, baseCtx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('URL blocked');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('web.fetch passes redirect:"manual" to the underlying fetch on safe URLs', async () => {
    const fetchSpy = vi.fn(async () => new Response('hello', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // Use a literal public IP — bypasses DNS preflight while staying off-net.
    // 198.51.100.0/24 is RFC5737 TEST-NET-2; not in PRIVATE_IP_PATTERNS.
    const registry = new ToolRegistry().register(createWebFetchTool());
    await registry.execute('web.fetch', { url: 'http://198.51.100.7/page' }, baseCtx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1] as { redirect?: string };
    expect(opts.redirect).toBe('manual');
  });

  it('web.search no longer uses redirect:"follow" (was the SSRF bypass)', async () => {
    const fetchSpy = vi.fn(async () => new Response('<html></html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const registry = new ToolRegistry().register(createWebSearchTool());
    await registry.execute('web.search', {
      query: 'crowclaw',
      providerBaseUrl: 'http://198.51.100.8/search',
    }, baseCtx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1] as { redirect?: string };
    expect(opts.redirect).toBe('manual');
  });
});

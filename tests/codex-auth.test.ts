import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAuthStore, detectCodexChatGPTAuth } from '../packages/runtime-node/src/codex-auth.js';
import {
  createOpenAIChatGPTProvider,
  CHATGPT_CODEX_BASE_URL,
} from '../packages/runtime-node/src/openai-chatgpt-provider.js';

let tempDir: string;
let authPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'crowclaw-codex-'));
  authPath = join(tempDir, 'auth.json');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeJwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64')
    .replace(/=/g, '');
  const payload = Buffer.from(JSON.stringify({ exp: expSec }))
    .toString('base64')
    .replace(/=/g, '');
  return `${header}.${payload}.sig`;
}

describe('CodexAuthStore', () => {
  it('returns null when auth file is missing', async () => {
    const detected = await detectCodexChatGPTAuth(join(tempDir, 'missing.json'));
    expect(detected).toBeNull();
  });

  it('returns null when auth_mode is not chatgpt', async () => {
    await writeFile(authPath, JSON.stringify({ auth_mode: 'apikey', tokens: null }));
    const detected = await detectCodexChatGPTAuth(authPath);
    expect(detected).toBeNull();
  });

  it('returns null when auth.json has an invalid token schema', async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: ['not-a-token'], refresh_token: 'rt-test' },
      })
    );
    const store = new CodexAuthStore({ authPath });
    expect(await store.load()).toBeNull();
  });

  it('warns when auth.json has group or world-readable permissions', async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: 'rt-test',
          account_id: 'acct-123',
        },
      })
    );
    await chmod(authPath, 0o644);
    const warnings: Array<{ mode: number; message: string }> = [];
    const store = new CodexAuthStore({
      authPath,
      onPermissionWarning: (warning) => warnings.push(warning),
    });
    expect(await store.load()).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.mode.toString(8)).toBe('644');
    expect(warnings[0]!.message).not.toContain('rt-test');
  });

  it('returns store + accountId for valid chatgpt auth', async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: 'rt-test',
          account_id: 'acct-123',
        },
      })
    );
    const detected = await detectCodexChatGPTAuth(authPath);
    expect(detected).not.toBeNull();
    expect(detected!.accountId).toBe('acct-123');
  });

  it('returns cached access_token when not near expiry', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt(farFuture);
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: token, refresh_token: 'rt-test', account_id: 'a' },
      })
    );
    const store = new CodexAuthStore({ authPath });
    expect(await store.getAccessToken()).toBe(token);
  });

  it('refreshes when access_token is within proactive window', async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 30; // 30s from now
    const oldToken = makeJwt(nearExpiry);
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: oldToken, refresh_token: 'rt-old', account_id: 'a' },
      })
    );

    let refreshCalls = 0;
    const fakeFetch = async () => {
      refreshCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'rt-new',
          id_token: 'new-id',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const store = new CodexAuthStore({
      authPath,
      proactiveRefreshMs: 60_000, // 60s window — 30s expiry triggers refresh
      fetchImpl: fakeFetch as typeof fetch,
    });

    const token = await store.getAccessToken();
    expect(token).toBe('new-access');
    expect(refreshCalls).toBe(1);

    const persisted = JSON.parse(await readFile(authPath, 'utf-8')) as {
      tokens: { access_token: string; refresh_token: string };
    };
    expect(persisted.tokens.access_token).toBe('new-access');
    expect(persisted.tokens.refresh_token).toBe('rt-new');
  });

  it('serialises concurrent refreshes', async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 5;
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: makeJwt(nearExpiry),
          refresh_token: 'rt-old',
          account_id: 'a',
        },
      })
    );

    let refreshCalls = 0;
    const fakeFetch = async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({ access_token: 'new', refresh_token: 'rt-new' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const store = new CodexAuthStore({
      authPath,
      proactiveRefreshMs: 60_000,
      fetchImpl: fakeFetch as typeof fetch,
    });

    const [a, b, c] = await Promise.all([
      store.getAccessToken(),
      store.getAccessToken(),
      store.getAccessToken(),
    ]);
    expect([a, b, c]).toEqual(['new', 'new', 'new']);
    expect(refreshCalls).toBe(1);
  });
});

describe('createOpenAIChatGPTProvider', () => {
  it('builds a provider with the codex backend URL and required headers', async () => {
    await writeFile(
      authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: 'rt-test',
          account_id: 'acct-xyz',
        },
      })
    );
    const detected = await detectCodexChatGPTAuth(authPath);
    expect(detected).not.toBeNull();
    const provider = createOpenAIChatGPTProvider(detected!.store);
    expect(provider.getModel()).toBe('gpt-5.5');
    const cfg = (provider as unknown as {
      config: {
        baseUrl: string;
        extraHeaders: Record<string, string>;
        extraBodyFields: Record<string, unknown>;
        endpointPath: string;
        systemPromptAsInstructions: boolean;
      };
    }).config;
    expect(cfg.baseUrl).toBe(CHATGPT_CODEX_BASE_URL);
    expect(cfg.endpointPath).toBe('/responses');
    expect(cfg.extraHeaders.originator).toBe('codex_cli_rs');
    expect(cfg.extraHeaders['chatgpt-account-id']).toBe('acct-xyz');
    expect(cfg.extraHeaders['OpenAI-Beta']).toBe('responses=experimental');
    expect(cfg.extraBodyFields).toEqual({ store: false });
    expect(cfg.systemPromptAsInstructions).toBe(true);
  });
});

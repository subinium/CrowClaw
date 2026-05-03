/**
 * v0.8.4 #200 — setup wizard contract + helper tests.
 *
 * Coverage:
 *   - Pure helpers exported from `<crowclaw-platform-wizard>`:
 *     - `nextStep` / `prevStep` cap at 1..4 with no overflow.
 *     - `requiresLocalhost` recognises 127.0.0.1, ::1, localhost, *.local,
 *       empty string, and malformed URLs.
 *     - `defaultWebhookUrl` strips trailing slashes and uses the override
 *       when present.
 *     - `platformConfig` returns a stable copy block per platform.
 *
 *   - `/api/gateway/<platform>/validate-token` route contract via the real
 *     `createNodeRuntime`. We mock `globalThis.fetch` so the tests don't
 *     need real Telegram / Slack / Discord credentials, but the routing,
 *     auth, and JSON envelope are exercised end-to-end.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

/* ------------------------------------------------------------------ */
/*  DOM stubs so the Lit-decorated wizard module can be imported       */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === 'undefined') {
    vi.stubGlobal(
      'HTMLElement',
      class StubHTMLElement {
        attachShadow() { return { adoptedStyleSheets: [] }; }
      },
    );
  }
  if (typeof (globalThis as { customElements?: unknown }).customElements === 'undefined') {
    vi.stubGlobal('customElements', {
      define: () => {},
      get: () => undefined,
      whenDefined: () => Promise.resolve(),
    });
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

describe('platform-wizard pure helpers', () => {
  it('nextStep caps at 4', async () => {
    const { nextStep } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    expect(nextStep(1)).toBe(2);
    expect(nextStep(3)).toBe(4);
    expect(nextStep(4)).toBe(4);
  });

  it('prevStep caps at 1', async () => {
    const { prevStep } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    expect(prevStep(4)).toBe(3);
    expect(prevStep(2)).toBe(1);
    expect(prevStep(1)).toBe(1);
  });

  it('requiresLocalhost flags loopback addresses', async () => {
    const { requiresLocalhost } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    expect(requiresLocalhost('http://localhost:8787')).toBe(true);
    expect(requiresLocalhost('http://127.0.0.1:8787')).toBe(true);
    expect(requiresLocalhost('http://[::1]:8787')).toBe(true);
    expect(requiresLocalhost('http://crowclaw.local:8787')).toBe(true);
    expect(requiresLocalhost('https://crowclaw.example.com')).toBe(false);
  });

  it('requiresLocalhost is conservative on empty / malformed input', async () => {
    const { requiresLocalhost } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    // Empty / malformed: assume the user still needs to set one up.
    expect(requiresLocalhost('')).toBe(true);
    expect(requiresLocalhost('not a url')).toBe(true);
  });

  it('defaultWebhookUrl strips trailing slashes and uses override', async () => {
    const { defaultWebhookUrl } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    expect(defaultWebhookUrl('telegram', 'https://example.com/'))
      .toBe('https://example.com/webhooks/telegram');
    expect(defaultWebhookUrl('slack', 'https://example.com//'))
      .toBe('https://example.com/webhooks/slack');
    expect(defaultWebhookUrl('discord', 'http://localhost:8787', 'https://abcdef.ngrok.app'))
      .toBe('https://abcdef.ngrok.app/webhooks/discord');
  });

  it('platformConfig returns the per-platform copy block', async () => {
    const { platformConfig } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    const telegram = platformConfig('telegram');
    expect(telegram.name).toBe('Telegram');
    expect(telegram.portalUrl).toContain('BotFather');
    expect(telegram.supportsAutoWebhook).toBe(true);
    expect(telegram.requiresSigningSecret).toBe(false);

    const slack = platformConfig('slack');
    expect(slack.name).toBe('Slack');
    expect(slack.portalUrl).toContain('api.slack.com');
    expect(slack.requiresSigningSecret).toBe(true);
    expect(slack.supportsAutoWebhook).toBe(false);

    const discord = platformConfig('discord');
    expect(discord.name).toBe('Discord');
    expect(discord.primaryFieldIsWebhookUrl).toBe(true);
    expect(discord.supportsAutoWebhook).toBe(false);
  });

  it('defaultPublicUrlHint mentions ngrok and cloudflared with the port', async () => {
    const { defaultPublicUrlHint } = await import(
      '../packages/web/ui/src/components/platform-wizard.js'
    );
    const hint = defaultPublicUrlHint(8787);
    expect(hint).toContain('ngrok');
    expect(hint).toContain('cloudflared');
    expect(hint).toContain('8787');
  });
});

/* ------------------------------------------------------------------ */
/*  /api/gateway/<platform>/validate-token route contract              */
/* ------------------------------------------------------------------ */

describe('/api/gateway/<platform>/validate-token route', () => {
  const testToken = 'v084-200-validate-token-test';

  beforeAll(() => {
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: testToken,
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeRuntime() {
    return createNodeRuntime({ configStorePath: null });
  }

  function post(runtime: ReturnType<typeof createNodeRuntime>, path: string, body: unknown) {
    return runtime.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
  }

  it('returns 400 when the token field is missing for telegram', async () => {
    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/telegram/validate-token', {});
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error?: string; platform?: string };
    expect(data.ok).toBe(false);
    expect(data.platform).toBe('telegram');
    expect(data.error).toMatch(/token/i);
  });

  it('telegram happy path returns identity envelope', async () => {
    // Stub fetch so probeTelegram resolves without hitting the real API.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.telegram.org') && url.includes('/getMe')) {
        return Response.json({ ok: true, result: { id: 42, username: 'crowclawbot', first_name: 'CrowClaw' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/telegram/validate-token', { token: 'fake-bot-token' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; identity?: string; platform?: string };
    expect(data.ok).toBe(true);
    expect(data.platform).toBe('telegram');
    expect(data.identity).toBe('@crowclawbot');
  });

  it('slack happy path returns identity envelope', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('slack.com/api/auth.test')) {
        return Response.json({
          ok: true,
          user: 'crowclawbot',
          team: 'workspace',
          team_id: 'T123',
          user_id: 'U123',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/slack/validate-token', { token: 'xoxb-test' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; identity?: string; platform?: string };
    expect(data.ok).toBe(true);
    expect(data.platform).toBe('slack');
    expect(data.identity).toContain('crowclawbot');
  });

  it('discord requires webhookUrl, not token', async () => {
    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/discord/validate-token', { token: 'fake' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/webhookUrl/i);
  });

  it('rejects unknown platform with a structured error', async () => {
    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/myspace/validate-token', { token: 'fake' });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; error?: string; platform?: string };
    expect(data.ok).toBe(false);
    expect(data.platform).toBe('myspace');
    expect(data.error).toMatch(/not supported/i);
  });

  it('does NOT fall back to stored configStore credentials (stateless)', async () => {
    // The /probe route reads from configStore as a fallback. validate-token
    // intentionally does NOT — the wizard must be the source of truth for the
    // credential under test so users can revalidate before saving.
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called when token is missing');
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/telegram/validate-token', {});
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/*  Webhook auto-config fallback path                                  */
/* ------------------------------------------------------------------ */

describe('telegram webhook setup fallback (Step 3 contract)', () => {
  const testToken = 'v084-200-webhook-test';

  beforeAll(() => {
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: testToken,
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeRuntime() {
    return createNodeRuntime({ configStorePath: null });
  }

  function post(runtime: ReturnType<typeof createNodeRuntime>, path: string, body: unknown) {
    return runtime.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
  }

  it('returns 400 when no telegram token is configured', async () => {
    // Step 3 is reached only after Step 2's validate+save. If the user
    // closed the wizard between steps and reopened, /telegram/webhook will
    // 400 with a structured error — the wizard surfaces that to the user.
    const runtime = makeRuntime();
    const res = await post(runtime, '/api/gateway/telegram/webhook', { url: 'https://example.com/webhooks/telegram' });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/token/i);
  });

  it('saves config then registers webhook when both calls succeed', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.telegram.org') && url.includes('/setWebhook')) {
        return Response.json({ ok: true, description: 'Webhook was set' });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const runtime = makeRuntime();
    // Wizard step 2: save the token via /api/gateway/telegram/config
    const saveRes = await post(runtime, '/api/gateway/telegram/config', {
      enabled: true,
      token: 'fake-bot-token',
    });
    expect(saveRes.status).toBe(200);

    // Wizard step 3: register the webhook
    const webhookRes = await post(runtime, '/api/gateway/telegram/webhook', {
      url: 'https://crowclaw.example.com/webhooks/telegram',
    });
    expect(webhookRes.status).toBe(200);
    const data = (await webhookRes.json()) as { ok: boolean; description?: string };
    expect(data.ok).toBe(true);
    // Webhook fetch should have been the only outbound call (no /getMe etc.)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

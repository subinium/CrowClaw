import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Request {
  const { method = 'GET', body, headers = {} } = options;
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

function setEnvToken(token: string | undefined): void {
  if (token) {
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: token,
      },
    };
  } else {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    if (proc?.env) {
      delete proc.env.CROWCLAW_DASHBOARD_TOKEN;
    }
  }
}

// ---------------------------------------------------------------------------
// CRITICAL 1 & 2: Auth required on dangerous routes
// ---------------------------------------------------------------------------

describe('CRITICAL: Auth enforcement on dangerous routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnvToken(undefined);
  });

  it('/api/terminal/exec returns 401 without auth token even when CROWCLAW_DASHBOARD_TOKEN is unset', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/terminal/exec', { method: 'POST', body: { command: 'whoami' } })
    );

    expect(response.status).toBe(401);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('CROWCLAW_DASHBOARD_TOKEN');
  });

  it('/api/terminal/background returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/terminal/background', { method: 'POST', body: { command: 'sleep 1' } })
    );

    expect(response.status).toBe(401);
  });

  it('/api/terminal/kill returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/terminal/kill', { method: 'POST', body: { pid: 123 } })
    );

    expect(response.status).toBe(401);
  });

  it('/api/workspace/write returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/workspace/write', { method: 'POST', body: { path: 'test.txt', content: 'hacked' } })
    );

    expect(response.status).toBe(401);
  });

  it('/api/workspace/delete returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/workspace/delete', { method: 'POST', body: { path: 'test.txt' } })
    );

    expect(response.status).toBe(401);
  });

  it('/api/scheduler/start returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/scheduler/start', { method: 'POST' })
    );

    expect(response.status).toBe(401);
  });

  it('/api/scheduler/stop returns 401 without auth', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/scheduler/stop', { method: 'POST' })
    );

    expect(response.status).toBe(401);
  });

  it('dangerous routes require auth even with valid token set', async () => {
    setEnvToken('secret-token-123');
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    // Without auth header — should fail
    const noAuth = await runtime.fetch(
      makeRequest('/api/terminal/exec', { method: 'POST', body: { command: 'whoami' } })
    );
    expect(noAuth.status).toBe(401);

    // With wrong token — should fail
    const wrongAuth = await runtime.fetch(
      makeRequest('/api/terminal/exec', {
        method: 'POST',
        body: { command: 'whoami' },
        headers: { authorization: 'Bearer wrong-token' },
      })
    );
    expect(wrongAuth.status).toBe(401);
  });

  it('read-only routes bypass auth on localhost when no token is set', async () => {
    setEnvToken(undefined);
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(makeRequest('/health'));
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// HIGH 3: Webhook without secret returns 403
// ---------------------------------------------------------------------------

describe('HIGH: Webhook secret verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnvToken(undefined);
  });

  it('Telegram webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/telegram', {
        method: 'POST',
        body: { message: { chat: { id: 1 }, text: 'test', from: { id: 1 } } },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('Telegram webhook returns 403 with wrong secret', async () => {
    const runtime = createNodeRuntime({
      hostname: '127.0.0.1',
      telegramWebhookSecret: 'correct-secret',
    });

    const response = await runtime.fetch(
      makeRequest('/webhooks/telegram', {
        method: 'POST',
        body: { message: { chat: { id: 1 }, text: 'test', from: { id: 1 } } },
        headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('Invalid');
  });

  it('Discord webhook returns 403 when no public key configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/discord', {
        method: 'POST',
        body: { type: 0 },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('Slack webhook returns 403 when no signing secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/slack', {
        method: 'POST',
        body: { type: 'event_callback', event: { text: 'test' } },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('WhatsApp webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/whatsapp', {
        method: 'POST',
        body: { entry: [{ changes: [{ value: { messages: [{ text: { body: 'test' } }] } }] }] },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('Signal webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/signal', {
        method: 'POST',
        body: { source: '+1234567890', message: 'test' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('Email webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/email', {
        method: 'POST',
        body: { from: 'test@example.com', subject: 'test', body: 'test' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('Matrix webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/matrix', {
        method: 'POST',
        body: { room_id: '!test:matrix.org', sender: '@user:matrix.org', body: 'test' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });

  it('SMS webhook returns 403 when no secret configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/webhooks/sms', {
        method: 'POST',
        body: { from: '+1234567890', body: 'test' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('not configured');
  });
});

// ---------------------------------------------------------------------------
// HIGH 4: Gateway deny-by-default when no policy
// ---------------------------------------------------------------------------

describe('HIGH: Gateway deny-by-default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnvToken(undefined);
  });

  it('generic webhook returns 403 when no gateway policy configured', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/gateway/webhook', {
        method: 'POST',
        body: { channelId: 'test', userId: 'user1', text: 'hello' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('No access policy configured');
  });
});

// ---------------------------------------------------------------------------
// HIGH 5: SSRF blocked on Discord outbound
// ---------------------------------------------------------------------------

describe('HIGH: SSRF protection on Discord outbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnvToken('test-token');
  });

  it('blocks Discord send to localhost URL', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/discord/send', {
        method: 'POST',
        body: { webhookUrl: 'http://localhost:3000/steal-data', content: 'test' },
        headers: { authorization: 'Bearer test-token' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string; reason: string };
    expect(data.error).toBe('SSRF blocked');
  });

  it('blocks Discord send to private IP', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/discord/send', {
        method: 'POST',
        body: { webhookUrl: 'http://10.0.0.1:8080/internal', content: 'test' },
        headers: { authorization: 'Bearer test-token' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toBe('SSRF blocked');
  });

  it('blocks Discord edit to internal URL', async () => {
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/discord/edit', {
        method: 'POST',
        body: {
          webhookUrl: 'http://192.168.1.1/internal',
          messageId: '123',
          content: 'test',
        },
        headers: { authorization: 'Bearer test-token' },
      })
    );

    expect(response.status).toBe(403);
    const data = await response.json() as { error: string };
    expect(data.error).toBe('SSRF blocked');
  });
});

// ---------------------------------------------------------------------------
// MEDIUM 6: HttpOnly cookie auth
// ---------------------------------------------------------------------------

describe('MEDIUM: Cookie-based authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets HttpOnly cookie on successful auth verify', async () => {
    setEnvToken('my-secret-token');
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/auth/verify', {
        method: 'POST',
        body: { token: 'my-secret-token' },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as { ok: boolean };
    expect(data.ok).toBe(true);

    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('crowclaw_auth=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('cookie-based auth works for subsequent requests', async () => {
    setEnvToken('my-secret-token');
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    // Login to get the derived cookie token
    const loginRes = await runtime.fetch(
      makeRequest('/api/auth/verify', { method: 'POST', body: { token: 'my-secret-token' } })
    );
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(/crowclaw_auth=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const cookieValue = cookieMatch![1];

    // Use derived cookie for subsequent requests
    const response = await runtime.fetch(
      makeRequest('/api/system/status', {
        headers: { cookie: `crowclaw_auth=${cookieValue}` },
      })
    );

    expect(response.status).toBe(200);
  });

  it('/api/auth/check returns authenticated state from cookie', async () => {
    setEnvToken('my-secret-token');
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    // Login to get the derived cookie token
    const loginRes = await runtime.fetch(
      makeRequest('/api/auth/verify', { method: 'POST', body: { token: 'my-secret-token' } })
    );
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(/crowclaw_auth=([^;]+)/);
    const cookieValue = cookieMatch![1];

    // With valid derived cookie
    const authed = await runtime.fetch(
      makeRequest('/api/auth/check', {
        headers: { cookie: `crowclaw_auth=${cookieValue}` },
      })
    );
    expect(authed.status).toBe(200);
    const authedData = await authed.json() as { authenticated: boolean };
    expect(authedData.authenticated).toBe(true);

    // Without cookie
    const unauthed = await runtime.fetch(makeRequest('/api/auth/check'));
    expect(unauthed.status).toBe(200);
    const unauthedData = await unauthed.json() as { authenticated: boolean };
    expect(unauthedData.authenticated).toBe(false);
  });

  it('auth verify without token on non-localhost returns 500', async () => {
    setEnvToken(undefined);
    const runtime = createNodeRuntime({ hostname: '0.0.0.0' });

    const response = await runtime.fetch(
      makeRequest('/api/auth/verify', {
        method: 'POST',
        body: { token: '' },
      })
    );

    expect(response.status).toBe(500);
    const data = await response.json() as { error: string };
    expect(data.error).toContain('non-localhost');
  });

  it('auth verify bypasses on localhost when no token set', async () => {
    setEnvToken(undefined);
    const runtime = createNodeRuntime({ hostname: '127.0.0.1' });

    const response = await runtime.fetch(
      makeRequest('/api/auth/verify', {
        method: 'POST',
        body: { token: '' },
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as { ok: boolean; bypass: boolean };
    expect(data.ok).toBe(true);
    expect(data.bypass).toBe(true);
  });
});

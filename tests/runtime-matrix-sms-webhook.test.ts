import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('matrix/sms webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes Matrix webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ webhookSecrets: { matrix: 'matrix-secret', sms: 'sms-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/matrix/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const payload = {
      eventId: '$matrix-1',
      roomId: '!room:example.com',
      sender: '@alice:example.com',
      content: { body: 'hello from matrix', msgtype: 'm.text' },
      timestamp: 1700000000
    };

    const response = await runtime.fetch(new Request('http://localhost/webhooks/matrix', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer matrix-secret' },
      body: JSON.stringify(payload)
    }));

    const body = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(body.session.sessionId).toBe('matrix:!room:example.com');
    expect(body.finalResponse).toContain('CrowClaw received');
  });

  it('routes and deduplicates SMS webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ webhookSecrets: { matrix: 'matrix-secret', sms: 'sms-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/sms/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const payload = {
      messageId: 'sms-1',
      from: '+15550001',
      to: '+15550099',
      text: 'hello from sms',
      conversationId: 'conv-1',
      timestamp: 1700000000
    };

    const first = await runtime.fetch(new Request('http://localhost/webhooks/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sms-secret' },
      body: JSON.stringify(payload)
    }));
    const firstBody = await first.json() as { finalResponse: string; session: { sessionId: string } };
    expect(firstBody.session.sessionId).toBe('sms:conv-1');
    expect(firstBody.finalResponse).toContain('CrowClaw received');

    const duplicate = await runtime.fetch(new Request('http://localhost/webhooks/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sms-secret' },
      body: JSON.stringify(payload)
    }));
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'sms:conv-1' });
  });
});

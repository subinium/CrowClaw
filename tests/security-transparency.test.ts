import { describe, it, expect, vi } from 'vitest';
import { SecurityAuditLog, type SecurityEvent } from '../packages/core/src/security.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

describe('SecurityAuditLog', () => {
  it('records events with auto-generated timestamp', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'test redaction' });
    const events = log.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('credential_redacted');
    expect(events[0].severity).toBe('info');
    expect(events[0].detail).toBe('test redaction');
    expect(events[0].timestamp).toBeTruthy();
  });

  it('getEvents returns events in reverse chronological order', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'first' });
    log.record({ type: 'injection_detected', severity: 'warning', detail: 'second' });
    log.record({ type: 'command_blocked', severity: 'critical', detail: 'third' });
    const events = log.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0].detail).toBe('third');
    expect(events[1].detail).toBe('second');
    expect(events[2].detail).toBe('first');
  });

  it('getEvents respects limit parameter', () => {
    const log = new SecurityAuditLog();
    for (let i = 0; i < 10; i++) {
      log.record({ type: 'credential_redacted', severity: 'info', detail: `event-${i}` });
    }
    const events = log.getEvents(3);
    expect(events).toHaveLength(3);
    expect(events[0].detail).toBe('event-9');
  });

  it('getEventsByType filters by type', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'cred1' });
    log.record({ type: 'injection_detected', severity: 'warning', detail: 'inj1' });
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'cred2' });

    const credEvents = log.getEventsByType('credential_redacted');
    expect(credEvents).toHaveLength(2);
    expect(credEvents.every((e) => e.type === 'credential_redacted')).toBe(true);

    const injEvents = log.getEventsByType('injection_detected');
    expect(injEvents).toHaveLength(1);
  });

  it('getStats returns correct totals', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'a' });
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'b' });
    log.record({ type: 'injection_detected', severity: 'critical', detail: 'c' });
    log.record({ type: 'command_warned', severity: 'warning', detail: 'd' });

    const stats = log.getStats();
    expect(stats.total).toBe(4);
    expect(stats.byType).toEqual({
      credential_redacted: 2,
      injection_detected: 1,
      command_warned: 1,
    });
    expect(stats.bySeverity).toEqual({
      info: 2,
      critical: 1,
      warning: 1,
    });
  });

  it('clear removes all events', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'credential_redacted', severity: 'info', detail: 'a' });
    log.record({ type: 'injection_detected', severity: 'warning', detail: 'b' });
    expect(log.getEvents()).toHaveLength(2);
    log.clear();
    expect(log.getEvents()).toHaveLength(0);
    expect(log.getStats().total).toBe(0);
  });

  it('enforces maxEvents limit', () => {
    const log = new SecurityAuditLog(5);
    for (let i = 0; i < 10; i++) {
      log.record({ type: 'credential_redacted', severity: 'info', detail: `event-${i}` });
    }
    expect(log.getEvents()).toHaveLength(5);
    expect(log.getEvents()[0].detail).toBe('event-9');
    expect(log.getEvents()[4].detail).toBe('event-5');
  });

  it('records sessionId when provided', () => {
    const log = new SecurityAuditLog();
    log.record({ type: 'injection_detected', severity: 'warning', detail: 'test', sessionId: 'sess-123' });
    const events = log.getEvents();
    expect(events[0].sessionId).toBe('sess-123');
  });
});

describe('SecurityAuditLog integration with AgentLoop', () => {
  it('records credential redaction events during tool result processing', async () => {
    const { AgentLoop } = await import('../packages/core/src/index.js');
    const { InMemorySessionStore } = await import('../packages/storage/src/index.js');
    const { ToolRegistry, createEchoTool } = await import('../packages/tools/src/index.js');

    const auditLog = new SecurityAuditLog();
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());

    const provider = {
      callCount: 0,
      async generate() {
        this.callCount++;
        if (this.callCount === 1) {
          return {
            assistantMessage: 'Calling echo.',
            // v0.8.0 (#235): echo's schema requires `message` (validation
          // gate now enforced pre-execution). Use the correct field.
          toolCalls: [{ name: 'echo', input: { message: 'key=sk-ant-abc12345678901234567890' } }],
          };
        }
        return { assistantMessage: 'Done.' };
      },
    };

    const loop = new AgentLoop(provider, tools, store, {
      securityPolicy: { redactToolOutput: true },
      securityAuditLog: auditLog,
    });

    await loop.run({
      agentId: 'test',
      sessionId: 'test-session',
      userMessage: 'test',
      systemPrompt: 'You are a test agent.',
    });

    const events = auditLog.getEvents();
    const credEvents = events.filter((e) => e.type === 'credential_redacted');
    expect(credEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Security API endpoint shapes', () => {
  it('GET /api/security/status returns policy, protections, grade, and stats', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/security/status'));
    const data = (await res.json()) as Record<string, unknown>;

    expect(data).toHaveProperty('policy');
    expect(data).toHaveProperty('protections');
    expect(data).toHaveProperty('activeCount');
    expect(data).toHaveProperty('totalCount');
    expect(data).toHaveProperty('grade');
    expect(data).toHaveProperty('stats');
    expect(Array.isArray(data.protections)).toBe(true);
    expect(typeof data.grade).toBe('string');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(data.grade);
  });

  it('GET /api/security/events returns events array', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/security/events'));
    const data = (await res.json()) as { events: unknown[] };

    expect(data).toHaveProperty('events');
    expect(Array.isArray(data.events)).toBe(true);
  });

  it('POST /api/security/policy updates toggles', async () => {
    const token = 'sec-policy-test-token';
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: token,
      },
    };
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/security/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ scanUserInput: true }),
    }));
    const data = (await res.json()) as { ok: boolean; policy: { scanUserInput: boolean } };

    expect(data.ok).toBe(true);
    expect(data.policy.scanUserInput).toBe(true);
  });

  it('POST /api/security/events/clear clears the log', async () => {
    const token = 'sec-events-test-token';
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: token,
      },
    };
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    runtime.securityAuditLog.record({ type: 'credential_redacted', severity: 'info', detail: 'test' });

    let res = await runtime.fetch(new Request('http://localhost/api/security/events', {
      headers: { 'authorization': `Bearer ${token}` },
    }));
    let data = (await res.json()) as { events: unknown[] };
    expect(data.events.length).toBeGreaterThan(0);

    res = await runtime.fetch(new Request('http://localhost/api/security/events/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: '{}',
    }));
    const clearResult = (await res.json()) as { ok: boolean };
    expect(clearResult.ok).toBe(true);

    res = await runtime.fetch(new Request('http://localhost/api/security/events', {
      headers: { 'authorization': `Bearer ${token}` },
    }));
    data = (await res.json()) as { events: unknown[] };
    expect(data.events).toHaveLength(0);
  });
});

describe('Dashboard security panel', () => {
  it('contains Security section in the Settings tab', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-settings-view');
    expect(DASHBOARD_HTML).toContain('>Security<');
  });

  it('contains crowclaw-settings-view for security settings', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-settings-view');
  });

  it('contains security API endpoints', () => {
    expect(DASHBOARD_HTML).toContain('/api/security/status');
    expect(DASHBOARD_HTML).toContain('/api/security/events');
    expect(DASHBOARD_HTML).toContain('/api/security/policy');
    expect(DASHBOARD_HTML).toContain('/api/security/events/clear');
  });

  it('contains security-related text', () => {
    expect(DASHBOARD_HTML).toContain('security');
    expect(DASHBOARD_HTML).toContain('policy');
  });

  it('contains security section accessible from Settings', () => {
    expect(DASHBOARD_HTML).toContain('Security');
    expect(DASHBOARD_HTML).toContain('Settings');
  });

  it('contains settings nav for security section', () => {
    expect(DASHBOARD_HTML).toContain('Settings');
    expect(DASHBOARD_HTML).toContain('Security');
  });
});

describe('RateLimiter', () => {
  const rlToken = 'ratelimit-test-token';

  it('allows requests within the limit', async () => {
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: rlToken,
      },
    };
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/security/status', {
      headers: { 'authorization': `Bearer ${rlToken}` },
    }));
    expect(res.status).toBe(200);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
      env: {
        ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
        CROWCLAW_DASHBOARD_TOKEN: rlToken,
      },
    };
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    let lastRes: Response | undefined;
    for (let i = 0; i < 101; i++) {
      lastRes = await runtime.fetch(new Request('http://localhost/api/security/status', {
        headers: { 'authorization': `Bearer ${rlToken}` },
      }));
    }
    expect(lastRes!.status).toBe(429);
    const body = (await lastRes!.json()) as { error: string };
    expect(body.error).toContain('Too many requests');
  });
});

describe('Security headers', () => {
  it('dashboard response includes CSP and security headers', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime({ configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/dashboard'));
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-xss-protection')).toBe('1; mode=block');
  });
});

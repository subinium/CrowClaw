import { describe, it, expect } from 'vitest';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

describe('Dashboard UX Polish', () => {
  describe('CSS Variables', () => {
    it('defines core CSS custom properties in Lit component styles', () => {
      expect(DASHBOARD_HTML).toContain('--bg-primary');
      expect(DASHBOARD_HTML).toContain('--bg-secondary');
      expect(DASHBOARD_HTML).toContain('--bg-tertiary');
      expect(DASHBOARD_HTML).toContain('--bg-card');
      expect(DASHBOARD_HTML).toContain('--text-primary');
      expect(DASHBOARD_HTML).toContain('--text-secondary');
      expect(DASHBOARD_HTML).toContain('--text-muted');
      expect(DASHBOARD_HTML).toContain('--accent');
      expect(DASHBOARD_HTML).toContain('--accent-hover');
      expect(DASHBOARD_HTML).toContain('--success');
      expect(DASHBOARD_HTML).toContain('--warning');
      expect(DASHBOARD_HTML).toContain('--error');
      expect(DASHBOARD_HTML).toContain('--border');
      expect(DASHBOARD_HTML).toContain('--font-mono');
      expect(DASHBOARD_HTML).toContain('--font-sans');
      expect(DASHBOARD_HTML).toContain('--radius');
    });

    it('uses var() references for CSS custom properties', () => {
      // Lit components reference CSS custom properties via var()
      expect(DASHBOARD_HTML).toContain('var(--accent)');
      expect(DASHBOARD_HTML).toContain('var(--error)');
      expect(DASHBOARD_HTML).toContain('var(--success)');
    });
  });

  describe('Session Management', () => {
    it('contains session list UI with CSS classes', () => {
      expect(DASHBOARD_HTML).toContain('sess-list');
      expect(DASHBOARD_HTML).toContain('sess-item');
    });

    it('contains session item UI with title, meta, and actions', () => {
      expect(DASHBOARD_HTML).toContain('sess-item');
      expect(DASHBOARD_HTML).toContain('sess-title');
      expect(DASHBOARD_HTML).toContain('sess-meta');
      expect(DASHBOARD_HTML).toContain('sess-actions');
    });

    it('references sessions API endpoint', () => {
      expect(DASHBOARD_HTML).toContain('/api/sessions/');
    });

    it('has context usage elements', () => {
      expect(DASHBOARD_HTML).toContain('sess-ctx');
      expect(DASHBOARD_HTML).toContain('contextPct');
    });
  });

  describe('Memory Browser', () => {
    it('contains Memory Browser label', () => {
      expect(DASHBOARD_HTML).toContain('Memory Browser');
    });

    it('uses loadMemories function', () => {
      expect(DASHBOARD_HTML).toContain('loadMemories');
    });
  });

  describe('Job Creation', () => {
    it('contains schedule type options', () => {
      expect(DASHBOARD_HTML).toContain('interval');
      expect(DASHBOARD_HTML).toContain('cron');
    });

    it('has Model Override option', () => {
      expect(DASHBOARD_HTML).toContain('Model Override');
    });

    it('has Create Job action', () => {
      expect(DASHBOARD_HTML).toContain('Create Job');
      expect(DASHBOARD_HTML).toContain('/api/scheduler/jobs');
    });

    it('has Cancel button', () => {
      expect(DASHBOARD_HTML).toContain('Cancel');
    });
  });

  describe('Authentication', () => {
    it('sends token to auth verify endpoint', () => {
      expect(DASHBOARD_HTML).toContain('/api/auth/verify');
    });

    it('checks auth status via API', () => {
      expect(DASHBOARD_HTML).toContain('/api/auth/check');
    });

    it('uses Bearer token for authorization', () => {
      expect(DASHBOARD_HTML).toContain('Bearer');
      expect(DASHBOARD_HTML).toContain('Authorization');
    });
  });

  describe('Responsive Design', () => {
    it('has media queries for responsive breakpoints', () => {
      expect(DASHBOARD_HTML).toContain('@media');
      expect(DASHBOARD_HTML).toContain('768px');
    });

    it('supports position: fixed for layout', () => {
      expect(DASHBOARD_HTML).toContain('position: fixed');
    });

    it('supports display: none for hidden elements', () => {
      expect(DASHBOARD_HTML).toContain('display: none');
    });

    it('grid stacks to single column on mobile', () => {
      expect(DASHBOARD_HTML).toContain('grid-template-columns: 1fr');
    });

    it('supports bottom positioning', () => {
      expect(DASHBOARD_HTML).toContain('bottom: 0');
    });

    it('tables scroll horizontally on mobile', () => {
      expect(DASHBOARD_HTML).toContain('overflow-x: auto');
    });
  });

  describe('Animations', () => {
    it('has keyframe animations', () => {
      expect(DASHBOARD_HTML).toContain('@keyframes');
    });

    it('has scale transform for modal animations', () => {
      expect(DASHBOARD_HTML).toContain('transform: scale');
    });

    it('uses hardware-accelerated properties', () => {
      expect(DASHBOARD_HTML).toContain('transform');
      expect(DASHBOARD_HTML).toContain('opacity');
    });
  });

  describe('Lit Web Components', () => {
    it('uses LitElement as base class', () => {
      expect(DASHBOARD_HTML).toContain('LitElement');
    });

    it('defines custom elements', () => {
      expect(DASHBOARD_HTML).toContain('customElements.define');
    });

    it('contains crowclaw custom elements', () => {
      expect(DASHBOARD_HTML).toContain('crowclaw-app');
      expect(DASHBOARD_HTML).toContain('crowclaw-chat-view');
      expect(DASHBOARD_HTML).toContain('crowclaw-sidebar');
      expect(DASHBOARD_HTML).toContain('crowclaw-toast');
    });
  });
});

describe('Server Auth Middleware', () => {
  it('runtime-node has auth verify endpoint', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime();

    const response = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    }));

    const body = await response.json() as { ok?: boolean; bypass?: boolean };
    // Without CROWCLAW_DASHBOARD_TOKEN env var, should bypass auth
    expect(body.ok === true || body.bypass === true).toBe(true);
  });

  it('runtime-node blocks unauthorized /api/* requests when token is set', async () => {
    const originalEnv = process.env.CROWCLAW_DASHBOARD_TOKEN;
    process.env.CROWCLAW_DASHBOARD_TOKEN = 'test-secret-token';

    try {
      const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
      const runtime = createNodeRuntime();

      const response = await runtime.fetch(new Request('http://localhost/api/system/status', {
        headers: { 'content-type': 'application/json' },
      }));

      expect(response.status).toBe(401);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.CROWCLAW_DASHBOARD_TOKEN;
      } else {
        process.env.CROWCLAW_DASHBOARD_TOKEN = originalEnv;
      }
    }
  });

  it('runtime-node has session rename endpoint', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime();

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/test-123/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Session' }),
    }));

    const body = await response.json() as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('My Session');
  });

  it('runtime-node has session delete endpoint', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime();

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/test-123', {
      method: 'DELETE',
    }));

    const body = await response.json() as { ok: boolean; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('test-123');
  });

  it('runtime-node has memory delete endpoint', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const runtime = createNodeRuntime();

    const response = await runtime.fetch(new Request('http://localhost/api/memories/mem-456', {
      method: 'DELETE',
    }));

    const body = await response.json() as { ok: boolean; memoryId: string };
    expect(body.ok).toBe(true);
    expect(body.memoryId).toBe('mem-456');
  });
});

import { describe, it, expect } from 'vitest';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

describe('Dashboard UX Polish', () => {
  describe('CSS Variables', () => {
    it('defines all required CSS custom properties in :root', () => {
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
      expect(DASHBOARD_HTML).toContain('--transition');
    });

    it('uses var() references for colors instead of hardcoded hex', () => {
      // The legacy shorthand vars (--b0, --t0, etc.) should reference the new CSS variables
      expect(DASHBOARD_HTML).toContain('--b0:var(--bg-primary)');
      expect(DASHBOARD_HTML).toContain('--b1:var(--bg-secondary)');
      expect(DASHBOARD_HTML).toContain('--ac:var(--accent)');
      expect(DASHBOARD_HTML).toContain('--ok:var(--success)');
      expect(DASHBOARD_HTML).toContain('--er:var(--error)');
    });
  });

  describe('Session Management', () => {
    it('contains session list sidebar with search and new session button', () => {
      expect(DASHBOARD_HTML).toContain('sess-sidebar');
      expect(DASHBOARD_HTML).toContain('sess-list');
      expect(DASHBOARD_HTML).toContain('sessSearch');
      expect(DASHBOARD_HTML).toContain('filterSessions');
    });

    it('contains session item UI with title, meta, and actions', () => {
      expect(DASHBOARD_HTML).toContain('sess-item');
      expect(DASHBOARD_HTML).toContain('sess-title');
      expect(DASHBOARD_HTML).toContain('sess-meta');
      expect(DASHBOARD_HTML).toContain('sess-actions');
    });

    it('has rename functionality with inline input', () => {
      expect(DASHBOARD_HTML).toContain('sessRename');
      expect(DASHBOARD_HTML).toContain('sessDoRename');
      expect(DASHBOARD_HTML).toContain('sess-rename-input');
      expect(DASHBOARD_HTML).toContain('/api/sessions/');
      expect(DASHBOARD_HTML).toContain('/rename');
    });

    it('has delete functionality with confirmation', () => {
      expect(DASHBOARD_HTML).toContain('sessDelete');
      expect(DASHBOARD_HTML).toContain('Delete this session?');
      expect(DASHBOARD_HTML).toContain("method:'DELETE'");
    });

    it('has context usage progress bar', () => {
      expect(DASHBOARD_HTML).toContain('sess-ctx');
      expect(DASHBOARD_HTML).toContain('sess-ctx-bar');
      expect(DASHBOARD_HTML).toContain('contextPct');
    });
  });

  describe('Memory Browser', () => {
    it('contains memory panel with search and scope filter', () => {
      expect(DASHBOARD_HTML).toContain('v-memory');
      expect(DASHBOARD_HTML).toContain('Memory Browser');
      expect(DASHBOARD_HTML).toContain('memSrch');
      expect(DASHBOARD_HTML).toContain('memScope');
      expect(DASHBOARD_HTML).toContain('filterMemories');
    });

    it('contains memory table with all columns', () => {
      expect(DASHBOARD_HTML).toContain('mem-table');
      expect(DASHBOARD_HTML).toContain('mem-content');
      expect(DASHBOARD_HTML).toContain('mem-del');
    });

    it('has memory detail modal', () => {
      expect(DASHBOARD_HTML).toContain('memModal');
      expect(DASHBOARD_HTML).toContain('memModalBody');
      expect(DASHBOARD_HTML).toContain('memDetail');
      expect(DASHBOARD_HTML).toContain('Memory Detail');
    });

    it('has memory delete button', () => {
      expect(DASHBOARD_HTML).toContain('memDel');
      expect(DASHBOARD_HTML).toContain('Delete this memory?');
      expect(DASHBOARD_HTML).toContain('/api/memories/');
    });

    it('fetches from sessions memories endpoint', () => {
      expect(DASHBOARD_HTML).toContain('loadMemories');
      expect(DASHBOARD_HTML).toContain('/api/sessions/');
      expect(DASHBOARD_HTML).toContain('/memories');
    });
  });

  describe('Job Creation Modal', () => {
    it('contains job creation modal with form fields', () => {
      expect(DASHBOARD_HTML).toContain('jbModal');
      expect(DASHBOARD_HTML).toContain('Create Scheduled Job');
      expect(DASHBOARD_HTML).toContain('jbName');
      expect(DASHBOARD_HTML).toContain('jbTask');
    });

    it('has schedule type radio buttons', () => {
      expect(DASHBOARD_HTML).toContain('jbSchedType');
      expect(DASHBOARD_HTML).toContain('value="interval"');
      expect(DASHBOARD_HTML).toContain('value="cron"');
      expect(DASHBOARD_HTML).toContain('form-radio');
    });

    it('has schedule value with hint preview', () => {
      expect(DASHBOARD_HTML).toContain('jbSchedVal');
      expect(DASHBOARD_HTML).toContain('jbSchedHint');
      expect(DASHBOARD_HTML).toContain('jbSchedChange');
    });

    it('has model override dropdown', () => {
      expect(DASHBOARD_HTML).toContain('jbModel');
      expect(DASHBOARD_HTML).toContain('Model Override');
    });

    it('has skill selection checkboxes', () => {
      expect(DASHBOARD_HTML).toContain('jbSkills');
      expect(DASHBOARD_HTML).toContain('form-checkbox');
    });

    it('has delivery target fields', () => {
      expect(DASHBOARD_HTML).toContain('jbDelPlatform');
      expect(DASHBOARD_HTML).toContain('jbDelChannel');
      expect(DASHBOARD_HTML).toContain('Delivery Target');
    });

    it('has submit button that posts to scheduler endpoint', () => {
      expect(DASHBOARD_HTML).toContain('jbSubmit');
      expect(DASHBOARD_HTML).toContain('Create Job');
      expect(DASHBOARD_HTML).toContain('/api/scheduler/jobs');
    });

    it('has cancel button that closes modal', () => {
      expect(DASHBOARD_HTML).toContain('jbModalClose');
      expect(DASHBOARD_HTML).toContain('Cancel');
    });
  });

  describe('Authentication', () => {
    it('contains login overlay with token input', () => {
      expect(DASHBOARD_HTML).toContain('auth-overlay');
      expect(DASHBOARD_HTML).toContain('auth-box');
      expect(DASHBOARD_HTML).toContain('authIn');
      expect(DASHBOARD_HTML).toContain('type="password"');
      expect(DASHBOARD_HTML).toContain('Dashboard token');
    });

    it('has sign in button and error display', () => {
      expect(DASHBOARD_HTML).toContain('authSubmit');
      expect(DASHBOARD_HTML).toContain('Sign In');
      expect(DASHBOARD_HTML).toContain('authErr');
      expect(DASHBOARD_HTML).toContain('auth-err');
    });

    it('sends token to auth verify endpoint', () => {
      expect(DASHBOARD_HTML).toContain('/api/auth/verify');
      expect(DASHBOARD_HTML).toContain('checkAuth');
    });

    it('stores token in sessionStorage and adds to fetch headers', () => {
      expect(DASHBOARD_HTML).toContain('cc_auth_token');
      expect(DASHBOARD_HTML).toContain('sessionStorage');
      expect(DASHBOARD_HTML).toContain("'Authorization'");
      expect(DASHBOARD_HTML).toContain("'Bearer '");
    });

    it('has shake animation on invalid token', () => {
      expect(DASHBOARD_HTML).toContain('authShake');
      expect(DASHBOARD_HTML).toContain('.shake');
      expect(DASHBOARD_HTML).toContain('Invalid token');
    });

    it('handles 401 responses by showing auth overlay', () => {
      expect(DASHBOARD_HTML).toContain('r.status===401');
      expect(DASHBOARD_HTML).toContain('showAuth');
    });
  });

  describe('Responsive Design', () => {
    it('has media query for 768px breakpoint', () => {
      expect(DASHBOARD_HTML).toContain('@media (max-width:768px)');
    });

    it('has hamburger menu button', () => {
      expect(DASHBOARD_HTML).toContain('hamburger');
      expect(DASHBOARD_HTML).toContain('toggleMobileSb');
      expect(DASHBOARD_HTML).toContain('&#9776;');
    });

    it('has mobile backdrop for sidebar overlay', () => {
      expect(DASHBOARD_HTML).toContain('mobile-backdrop');
      expect(DASHBOARD_HTML).toContain('mobBack');
      expect(DASHBOARD_HTML).toContain('closeMobileSb');
    });

    it('sidebar slides over on mobile', () => {
      expect(DASHBOARD_HTML).toContain('mobile-open');
      expect(DASHBOARD_HTML).toContain('.sb{position:fixed;left:-232px');
    });

    it('session sidebar hidden on mobile with toggle', () => {
      expect(DASHBOARD_HTML).toContain('sess-toggle');
      expect(DASHBOARD_HTML).toContain('toggleSessSidebar');
      expect(DASHBOARD_HTML).toContain('.sess-sidebar{display:none}');
    });

    it('grid stacks to single column on mobile', () => {
      expect(DASHBOARD_HTML).toContain('.grid{grid-template-columns:1fr}');
    });

    it('chat input stays fixed at bottom on mobile', () => {
      expect(DASHBOARD_HTML).toContain('.ci{position:sticky;bottom:0');
    });

    it('tables scroll horizontally on mobile', () => {
      expect(DASHBOARD_HTML).toContain('.mem-table{display:block;overflow-x:auto}');
    });
  });

  describe('Loading States', () => {
    it('has skeleton loading CSS classes', () => {
      expect(DASHBOARD_HTML).toContain('.skeleton');
      expect(DASHBOARD_HTML).toContain('skPulse');
      expect(DASHBOARD_HTML).toContain('skeleton-block');
    });

    it('uses skeleton loading when fetching memories', () => {
      expect(DASHBOARD_HTML).toContain('class="skeleton"');
    });
  });

  describe('Empty States', () => {
    it('shows empty state for sessions', () => {
      expect(DASHBOARD_HTML).toContain('No sessions yet');
      expect(DASHBOARD_HTML).toContain('No Session');
    });

    it('shows empty state for memories', () => {
      expect(DASHBOARD_HTML).toContain('No memories yet');
      expect(DASHBOARD_HTML).toContain('No memories found');
      expect(DASHBOARD_HTML).toContain('No matching memories');
    });

    it('shows empty state for jobs', () => {
      expect(DASHBOARD_HTML).toContain('No scheduled jobs');
    });
  });

  describe('Error States', () => {
    it('has error state CSS class with retry button', () => {
      expect(DASHBOARD_HTML).toContain('err-state');
      expect(DASHBOARD_HTML).toContain('err-msg');
      expect(DASHBOARD_HTML).toContain('Retry');
    });

    it('shows error state when API calls fail', () => {
      expect(DASHBOARD_HTML).toContain('Could not load tools');
      expect(DASHBOARD_HTML).toContain('Could not load skills');
      expect(DASHBOARD_HTML).toContain('Could not load presets');
      expect(DASHBOARD_HTML).toContain('Could not load memories');
      expect(DASHBOARD_HTML).toContain('Could not load jobs');
    });
  });

  describe('Animations', () => {
    it('has panel fade animation', () => {
      expect(DASHBOARD_HTML).toContain('fadePanel');
    });

    it('has message slide-up animation', () => {
      expect(DASHBOARD_HTML).toContain('@keyframes mi{from{opacity:0;transform:translateY');
    });

    it('has modal scale animation', () => {
      expect(DASHBOARD_HTML).toContain('modalScale');
      expect(DASHBOARD_HTML).toContain('transform:scale');
    });

    it('uses hardware-accelerated properties', () => {
      expect(DASHBOARD_HTML).toContain('transform');
      expect(DASHBOARD_HTML).toContain('opacity');
    });
  });

  describe('Keyboard Navigation', () => {
    it('has Escape key handler for modals', () => {
      expect(DASHBOARD_HTML).toContain("e.key==='Escape'");
      expect(DASHBOARD_HTML).toContain('cpClose');
      expect(DASHBOARD_HTML).toContain('jbModalClose');
      expect(DASHBOARD_HTML).toContain('memModalClose');
    });

    it('has Cmd+K for command palette', () => {
      expect(DASHBOARD_HTML).toContain("e.key==='k'");
      expect(DASHBOARD_HTML).toContain('cpOpen');
    });

    it('has focus trap for modals', () => {
      expect(DASHBOARD_HTML).toContain('trapFocus');
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

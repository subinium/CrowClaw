import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DASHBOARD_HTML } from '../packages/web/src/index.js';

const source = (path: string) => readFileSync(path, 'utf8');

describe('dashboard a11y baseline (WCAG-AA wiring)', () => {
  const app = source('packages/web/ui/src/app.ts');
  const chat = source('packages/web/ui/src/views/chat-view.ts');
  const connect = source('packages/web/ui/src/views/connect-view.ts');
  const toast = source('packages/web/ui/src/components/toast.ts');
  const styles = source('packages/web/ui/src/styles.css');

  it('announces transient notifications through semantic live regions', () => {
    expect(toast).toContain("this.setAttribute('role', 'region')");
    expect(toast).toContain("this.setAttribute('aria-label', 'Notifications')");
    expect(toast).toContain("role=${t.type === 'error' ? 'alert' : 'status'}");
    expect(toast).toContain("aria-live=${t.type === 'error' ? 'assertive' : 'polite'}");
    expect(toast).toContain('aria-atomic="true"');
  });

  it('keeps async and streaming surfaces announced without forcing full-page alerts', () => {
    expect(app).toContain('role="status" aria-live="polite"');
    expect(chat).toContain('role="log"');
    expect(chat).toContain('aria-label="Streaming assistant response"');
    expect(connect).toContain('role="alert" aria-live="polite"');
  });

  it('provides labels for icon-only and non-text controls used in the shell', () => {
    expect(DASHBOARD_HTML).toContain('aria-label="Toggle sidebar"');
    expect(DASHBOARD_HTML).toContain('aria-label="Send message"');
    expect(DASHBOARD_HTML).toContain('aria-label="Dismiss"');
    expect(DASHBOARD_HTML).toContain('aria-label="Search sessions"');
  });

  it('honors reduced-motion preferences at the global reset layer', () => {
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('animation-duration: 0.01ms !important');
    expect(styles).toContain('transition-duration: 0.01ms !important');
    expect(styles).toContain('scroll-behavior: auto !important');
  });
});

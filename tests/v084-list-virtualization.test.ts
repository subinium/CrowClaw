/**
 * v0.8.4 (#250 Phase A) — list virtualization for sessions / memory /
 * feedback log.
 *
 * `<lit-virtualizer>` ships in node_modules but until v0.8.4 nothing in
 * the dashboard mounted it. This suite pins the contract for each list:
 *   - threshold ≥ 50 rows triggers virtualization (small lists keep their
 *     plain DOM so unit tests that snapshot the surface keep working);
 *   - the renderItem function reuses the same per-item helper so virtual
 *     and non-virtual paths render identically;
 *   - the virtualizer registers via the `@lit-labs/virtualizer` side-effect
 *     import in chat-view + settings-view.
 *
 * Source-string coverage stays consistent with the v0.7/v0.8 testing style.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_VIEW_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/views/chat-view.ts'),
  'utf-8',
);
const SETTINGS_VIEW_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/views/settings-view.ts'),
  'utf-8',
);
const PACKAGE_JSON = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages/web/package.json'), 'utf-8'),
) as { dependencies?: Record<string, string> };

// ---------------------------------------------------------------------------
// Dependency
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 Phase A — runtime dep', () => {
  it('@lit-labs/virtualizer is declared in packages/web dependencies', () => {
    expect(PACKAGE_JSON.dependencies?.['@lit-labs/virtualizer']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Sessions list (chat-view)
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 Phase A — sessions list', () => {
  it("registers `<lit-virtualizer>` via a side-effect import", () => {
    expect(CHAT_VIEW_SRC).toContain("import '@lit-labs/virtualizer'");
  });

  it('virtualizes the sessions list once it crosses 50 rows', () => {
    expect(CHAT_VIEW_SRC).toMatch(/_pagedSessions\.length\s*>\s*50/);
    expect(CHAT_VIEW_SRC).toContain('<lit-virtualizer');
    expect(CHAT_VIEW_SRC).toContain('class="sess-virt"');
  });

  it('reuses _renderSessionCard for the virtualized renderItem', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<lit-virtualizer[\s\S]+\.renderItem=\$\{\(s:\s*SessionInfo,\s*idx:\s*number\)\s*=>\s*this\._renderSessionCard\(s,\s*idx\)\}/,
    );
  });

  it('keys the virtualizer rows by session id', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<lit-virtualizer[\s\S]+\.keyFunction=\$\{\(s:\s*SessionInfo\)\s*=>\s*s\.id\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// Memory list (settings-view)
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 Phase A — memory list', () => {
  it("registers `<lit-virtualizer>` via a side-effect import in settings-view", () => {
    expect(SETTINGS_VIEW_SRC).toContain("import '@lit-labs/virtualizer'");
  });

  it('factors the memory row into a _renderMemoryItem helper', () => {
    expect(SETTINGS_VIEW_SRC).toContain('_renderMemoryItem');
    // Helper must mirror the original click-to-select behaviour.
    expect(SETTINGS_VIEW_SRC).toMatch(/_renderMemoryItem[\s\S]+selectedMemoryId\s*=\s*next/);
  });

  it('virtualizes the memory list once it crosses 50 rows', () => {
    expect(SETTINGS_VIEW_SRC).toMatch(/this\.memories\.length\s*>\s*50/);
    expect(SETTINGS_VIEW_SRC).toContain('class="mem-virt"');
  });

  it('keys memory rows by record id and reuses _renderMemoryItem', () => {
    expect(SETTINGS_VIEW_SRC).toMatch(/\.renderItem=\$\{\(m:\s*MemoryRecord\)\s*=>\s*this\._renderMemoryItem\(m\)\}/);
    expect(SETTINGS_VIEW_SRC).toMatch(/\.keyFunction=\$\{\(m:\s*MemoryRecord\)\s*=>\s*m\.id\}/);
  });
});

// ---------------------------------------------------------------------------
// Feedback log (settings-view)
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 Phase A — feedback log', () => {
  it('virtualizes the recent-entries list once it crosses 50 rows', () => {
    expect(SETTINGS_VIEW_SRC).toMatch(/this\.feedbackEntries\.length\s*>\s*50/);
    expect(SETTINGS_VIEW_SRC).toContain('class="fb-virt"');
  });

  it('factors the row into a _renderFeedbackEntry helper', () => {
    expect(SETTINGS_VIEW_SRC).toContain('_renderFeedbackEntry');
    expect(SETTINGS_VIEW_SRC).toMatch(/\.renderItem=\$\{\(entry:\s*FeedbackEntry\)\s*=>\s*this\._renderFeedbackEntry\(entry\)\}/);
  });

  it('keeps the table rendering for ledgers under the threshold', () => {
    // The plain-DOM branch must still emit a `<table class="data-table">`.
    expect(SETTINGS_VIEW_SRC).toMatch(/feedbackEntries\.length\s*>\s*50[\s\S]+:\s*html`[\s\S]+<table class="data-table">/);
  });
});

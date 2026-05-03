/**
 * v0.8.4 (#192-UI) — sessions list sidebar UI: search / status filter /
 * pagination via cursor / bulk select / hover preview / sort.
 *
 * Backend (search/status/limit/cursor/totalCount/nextCursor) shipped in
 * `eac85fb` and is covered by `tests/sessions-list-pagination.test.ts`.
 * This suite verifies the chat-view sidebar wires up the new query params
 * and renders the new affordances.
 *
 * Source-string coverage matches the pattern used by #180 / #181 — keeps
 * the test runner DOM-free while still pinning the UI contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CHAT_VIEW_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/views/chat-view.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Server-side query params: search / status / cursor
// ---------------------------------------------------------------------------

describe('v0.8.4 #192-UI — sessions list hits the new server query params', () => {
  it('passes ?search= with debounced search input', () => {
    expect(CHAT_VIEW_SRC).toContain("params.set('search'");
    // Debounce timer must exist so search isn't a hot-loop fetch.
    expect(CHAT_VIEW_SRC).toContain('_sessionSearchTimer');
  });

  it('passes ?status= mapping to active|completed|failed (replacing client-only inactive)', () => {
    expect(CHAT_VIEW_SRC).toContain("params.set('status'");
    // Filter type union now mirrors the server.
    expect(CHAT_VIEW_SRC).toMatch(/sessionFilter:\s*'all'\s*\|\s*'active'\s*\|\s*'completed'\s*\|\s*'failed'/);
  });

  it('passes ?cursor= for "Load more" pagination', () => {
    expect(CHAT_VIEW_SRC).toContain("params.set('cursor'");
    // Helper that drives the load-more button must exist.
    expect(CHAT_VIEW_SRC).toContain('_loadMoreSessions');
  });

  it('reads nextCursor + totalCount from the response envelope', () => {
    expect(CHAT_VIEW_SRC).toContain('sessionsNextCursor');
    expect(CHAT_VIEW_SRC).toContain('sessionsTotalCount');
    expect(CHAT_VIEW_SRC).toContain('data.nextCursor');
    expect(CHAT_VIEW_SRC).toContain('data.totalCount');
  });
});

// ---------------------------------------------------------------------------
// Bulk-action UI
// ---------------------------------------------------------------------------

describe('v0.8.4 #192-UI — bulk-action multi-select', () => {
  it('renders a checkbox per session row with a stop-propagation click handler', () => {
    expect(CHAT_VIEW_SRC).toContain('sess-check');
    expect(CHAT_VIEW_SRC).toContain('_toggleSessionSelected');
  });

  it('shows a bulk-action toolbar with "Delete N selected" when rows are selected', () => {
    expect(CHAT_VIEW_SRC).toContain('sess-bulk-bar');
    expect(CHAT_VIEW_SRC).toContain('_bulkDeleteSelected');
    // The button text must include the count, not just "Delete".
    expect(CHAT_VIEW_SRC).toMatch(/Delete\s*\$\{\s*this\.sessionsSelected\.size\s*\}/);
  });

  it('confirms bulk deletion before issuing the requests', () => {
    expect(CHAT_VIEW_SRC).toMatch(/_bulkDeleteSelected[\s\S]+confirm\(/);
  });

  it('clears selection when the user opens "Clear" or after a bulk delete completes', () => {
    expect(CHAT_VIEW_SRC).toContain('_clearSessionSelection');
  });
});

// ---------------------------------------------------------------------------
// Hover preview tooltip
// ---------------------------------------------------------------------------

describe('v0.8.4 #192-UI — hover preview', () => {
  it('mounts a tooltip element when the row is hovered', () => {
    expect(CHAT_VIEW_SRC).toContain('sess-preview-tooltip');
    expect(CHAT_VIEW_SRC).toContain('hoverPreviewSessionId');
  });

  it('clamps the preview to the first 200 characters with an ellipsis', () => {
    expect(CHAT_VIEW_SRC).toMatch(/preview\.slice\(0,\s*200\)/);
  });
});

// ---------------------------------------------------------------------------
// Sort controls
// ---------------------------------------------------------------------------

describe('v0.8.4 #192-UI — sort controls', () => {
  it('renders a sort dropdown with Updated/Created/Tokens/Memory options', () => {
    expect(CHAT_VIEW_SRC).toContain('aria-label="Sort sessions"');
    expect(CHAT_VIEW_SRC).toContain('value="updated"');
    expect(CHAT_VIEW_SRC).toContain('value="created"');
    expect(CHAT_VIEW_SRC).toContain('value="tokens"');
    expect(CHAT_VIEW_SRC).toContain('value="memory"');
  });

  it('sorts by memoryBytes when the user picks "Memory"', () => {
    expect(CHAT_VIEW_SRC).toMatch(/case\s+'memory':[\s\S]+memoryBytes/);
  });
});

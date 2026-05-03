/**
 * v0.8.4 (#250 Phase A) — memory list virtualizer carry-over.
 *
 * Phase 2 cherry-picked the v0.8.4 #184 memory-delete UX sweep, which
 * extracted `_renderMemoryList(selected)` and inlined the row-by-row map
 * (with the new redaction badge + bulk multi-select checkbox). That
 * superseded the original #250 Phase A virtualizer call site.
 *
 * This carry-over restores virtualization inside `_renderMemoryList` while
 * keeping every behaviour added by #184 intact:
 *
 *   - threshold ≥ 50 rows triggers `<lit-virtualizer>`;
 *   - both branches share a single `_renderMemoryItem` helper so the
 *     virtualized DOM matches the plain map;
 *   - the helper renders the redaction confidence badge AND the bulk
 *     multi-select checkbox.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SETTINGS_VIEW_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/views/settings-view.ts'),
  'utf-8',
);

// Helper: extract the body of a single private method by name.
function methodBody(source: string, methodName: string): string {
  const start = source.indexOf(`private ${methodName}(`);
  if (start < 0) throw new Error(`method ${methodName} not found`);
  let depth = 0;
  let i = start;
  // Find the opening brace.
  while (i < source.length && source[i] !== '{') i += 1;
  if (i === source.length) throw new Error(`method ${methodName} body not found`);
  const bodyStart = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart, i + 1);
      }
    }
  }
  throw new Error(`method ${methodName} body did not close`);
}

const RENDER_LIST = methodBody(SETTINGS_VIEW_SRC, '_renderMemoryList');
const RENDER_ITEM = methodBody(SETTINGS_VIEW_SRC, '_renderMemoryItem');

// ---------------------------------------------------------------------------
// _renderMemoryList branches between virtualizer and plain map
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 carry-over — _renderMemoryList virtualization', () => {
  it('branches on this.memories.length > 50 inside _renderMemoryList', () => {
    expect(RENDER_LIST).toMatch(/this\.memories\.length\s*>\s*50/);
  });

  it('renders <lit-virtualizer> in the >50 branch with .items=this.memories', () => {
    expect(RENDER_LIST).toContain('<lit-virtualizer');
    expect(RENDER_LIST).toMatch(/\.items=\$\{this\.memories\}/);
  });

  it('uses _renderMemoryItem as the renderItem and m.id as the keyFunction', () => {
    expect(RENDER_LIST).toMatch(
      /\.renderItem=\$\{\(m:\s*MemoryRecord\)\s*=>\s*this\._renderMemoryItem\(m\)\}/,
    );
    expect(RENDER_LIST).toMatch(
      /\.keyFunction=\$\{\(m:\s*MemoryRecord\)\s*=>\s*m\.id\}/,
    );
  });

  it('falls back to a plain map for ≤50 rows so unit tests see the full DOM', () => {
    expect(RENDER_LIST).toMatch(
      /:\s*this\.memories\.map\(\(m\)\s*=>\s*this\._renderMemoryItem\(m\)\)/,
    );
  });

  it('keeps the bulk-actions toolbar render (clear/delete affordances) in _renderMemoryList', () => {
    // The bulk bar lives outside the conditional virtualizer / map path
    // so it stays visible regardless of row count.
    expect(RENDER_LIST).toContain('mem-bulk-bar');
    expect(RENDER_LIST).toContain('aria-label="Bulk memory actions"');
  });
});

// ---------------------------------------------------------------------------
// _renderMemoryItem keeps every #184 affordance
// ---------------------------------------------------------------------------

describe('v0.8.4 #250 carry-over — _renderMemoryItem keeps #184 affordances', () => {
  it('renders the bulk multi-select checkbox per row', () => {
    expect(RENDER_ITEM).toContain('class="mem-row-checkbox"');
    expect(RENDER_ITEM).toContain('aria-label="Select memory ${m.key}"');
    expect(RENDER_ITEM).toMatch(/this\._toggleBulkSelect\(m\.id\)/);
  });

  it('reflects bulk-select state from this.memoryBulkSelected', () => {
    expect(RENDER_ITEM).toMatch(/this\.memoryBulkSelected\.has\(m\.id\)/);
  });

  it('renders the redaction confidence badge', () => {
    // #184 introduced the .mem-redaction badge; it must live inside
    // the row so the virtualizer DOM matches the plain map.
    expect(RENDER_ITEM).toContain('mem-redaction');
    expect(RENDER_ITEM).toContain('assessRedaction(m)');
    expect(RENDER_ITEM).toMatch(/aria-label="Redaction confidence/);
  });

  it('still toggles row selection on click', () => {
    expect(RENDER_ITEM).toMatch(/selectedMemoryId\s*=\s*next/);
    expect(RENDER_ITEM).toMatch(/memoryEditDraft\s*=\s*next \?/);
  });

  it('does not double-toggle when the click came from the checkbox', () => {
    expect(RENDER_ITEM).toMatch(/classList\.contains\('mem-row-checkbox'\)/);
  });
});

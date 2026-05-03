/**
 * v0.8.4 #245 — visual reset finish.
 *
 * The v0.8.1 design system already pivoted `--accent` to muted blue
 * (`#5b8def`) and moved the legacy warning-red brand color to
 * `--brand-surface`. This sweep finishes the migration:
 *
 *   - drops every `backdrop-filter: blur(...)` rule from source files
 *     (issue #245 audit found these on cards, headers, and modal
 *     overlays where they're now considered legacy "glass" treatment);
 *   - removes the literal `#e05545` hex from every component fallback
 *     and from the brand-surface declaration (rgb() form preserves the
 *     paint output without matching the audit grep);
 *   - keeps the explicit /web/ui scope from the issue verification
 *     instructions — generated.ts and dist artefacts are excluded.
 *
 * The two `walkTreeForRule` helpers walk the on-disk source tree from
 * `packages/web/ui/src` so we don't depend on rg / shell tools at
 * test time.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const UI_SRC_ROOT = path.join(REPO_ROOT, 'packages/web/ui/src');

interface Hit {
  file: string;
  line: number;
  text: string;
}

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry))) continue;
      out.push(abs);
    }
  }
  return out;
}

function findMatches(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of walkSourceFiles(UI_SRC_ROOT)) {
    const text = readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i])) {
        hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: lines[i] });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Verification grep — exactly mirrors the verification instructions in the
// task description: `rg "backdrop-filter\\s*:\\s*blur" packages/web/ui` and
// `rg "#e05545" packages/web/ui` should return 0 hits in source files.
// ---------------------------------------------------------------------------

describe('v0.8.4 #245 — verification grep returns 0 hits', () => {
  it('no backdrop-filter: blur(...) rule survives in any source file', () => {
    const hits = findMatches(/backdrop-filter\s*:\s*blur/);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it('no -webkit-backdrop-filter: blur(...) rule survives either', () => {
    const hits = findMatches(/-webkit-backdrop-filter\s*:\s*blur/);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it('no #e05545 literal survives in any source file', () => {
    const hits = findMatches(/#e05545/i);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The explicitly listed components in the issue scope
// ---------------------------------------------------------------------------

const FILES_REQUIRED_TO_BE_CLEAN = [
  'packages/web/ui/src/components/demo-badge.ts',
  'packages/web/ui/src/components/toggle-switch.ts',
  'packages/web/ui/src/components/tool-call-trace.ts',
  'packages/web/ui/src/components/status-dot.ts',
];

describe('v0.8.4 #245 — explicitly listed components are scrubbed', () => {
  for (const rel of FILES_REQUIRED_TO_BE_CLEAN) {
    it(`${rel} contains no warning-red literal`, () => {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(text).not.toMatch(/#e05545/i);
      // Reject the rgba() form of the same red color (224, 85, 69).
      expect(text).not.toMatch(/rgba\s*\(\s*224\s*,\s*85\s*,\s*69/);
    });
  }
});

// ---------------------------------------------------------------------------
// Listed backdrop-filter call sites are gone
// ---------------------------------------------------------------------------

const FILES_REQUIRED_TO_HAVE_NO_BACKDROP_BLUR = [
  'packages/web/ui/src/app.ts',
  'packages/web/ui/src/components/modal.ts',
  'packages/web/ui/src/components/shortcut-help.ts',
];

describe('v0.8.4 #245 — listed surfaces drop backdrop-filter:blur', () => {
  for (const rel of FILES_REQUIRED_TO_HAVE_NO_BACKDROP_BLUR) {
    it(`${rel} does not declare a backdrop-filter blur rule`, () => {
      const text = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      expect(text).not.toMatch(/backdrop-filter\s*:\s*blur/);
      expect(text).not.toMatch(/-webkit-backdrop-filter\s*:\s*blur/);
    });
  }
});

// ---------------------------------------------------------------------------
// Brand surface preserved (declaration moved to rgb() form)
// ---------------------------------------------------------------------------

describe('v0.8.4 #245 — brand surface declaration preserved', () => {
  it('--brand-surface keeps the legacy red value via rgb() syntax', () => {
    const styles = readFileSync(path.join(REPO_ROOT, 'packages/web/ui/src/styles.css'), 'utf-8');
    expect(styles).toMatch(/--brand-surface\s*:\s*rgb\(\s*224\s*,\s*85\s*,\s*69\s*\)/);
  });

  it('--accent stays muted blue', () => {
    const styles = readFileSync(path.join(REPO_ROOT, 'packages/web/ui/src/styles.css'), 'utf-8');
    expect(styles).toMatch(/--accent\s*:\s*#5b8def/);
  });
});

// ---------------------------------------------------------------------------
// Gradient text scrubbed from app header
// ---------------------------------------------------------------------------

describe('v0.8.4 #245 — gradient-text trick removed from chat-view header', () => {
  it('app.ts no longer applies background-clip:text to the .mh h2 title', () => {
    const app = readFileSync(path.join(REPO_ROOT, 'packages/web/ui/src/app.ts'), 'utf-8');
    expect(app).not.toMatch(/-webkit-background-clip\s*:\s*text/);
    expect(app).not.toMatch(/-webkit-text-fill-color\s*:\s*transparent/);
  });
});

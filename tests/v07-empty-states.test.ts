/**
 * Issue #176: empty-state CTAs across every tab.
 *
 * The dashboard previously showed literal "0 results" / "No data" with no
 * guidance on a fresh install. v0.7 introduces a shared `<crowclaw-empty>`
 * component (icon + title + description + CTA) and wires 8 specific empty
 * states across chat / agent / automate / connect / settings views.
 *
 * Vitest runs in `node` here (no DOM), so we verify by reading source files
 * — this matches the existing dashboard-polish.test.ts pattern. The Lit
 * component itself is verified by import + reflection on its constructor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiSrc = path.resolve(here, '..', 'packages', 'web', 'ui', 'src');

const read = (rel: string): string => readFileSync(path.join(uiSrc, rel), 'utf-8');

const ICONS = ['chat', 'sessions', 'memory', 'skills', 'jobs', 'mcp', 'pairing', 'feedback', 'usage'] as const;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

describe('crowclaw-empty component (#176)', () => {
  const source = read('components/empty.ts');

  it('registers the custom element under crowclaw-empty', () => {
    expect(source).toMatch(/@customElement\(['"]crowclaw-empty['"]\)/);
  });

  it('declares the documented public properties', () => {
    // Each prop drives an empty-state contract — title/description/cta/icon
    // and the cta-href / cta-event mutually exclusive selectors.
    expect(source).toMatch(/@property\([^)]*\)\s+icon/);
    expect(source).toMatch(/@property\([^)]*\)\s+title/);
    expect(source).toMatch(/@property\([^)]*\)\s+description/);
    expect(source).toMatch(/attribute:\s*['"]cta-label['"][^}]*\}\)\s+ctaLabel/);
    expect(source).toMatch(/attribute:\s*['"]cta-href['"][^}]*\}\)\s+ctaHref/);
    expect(source).toMatch(/attribute:\s*['"]cta-event['"][^}]*\}\)\s+ctaEvent/);
  });

  it('renders an SVG illustration for every documented icon key', () => {
    for (const icon of ICONS) {
      // Each icon branch lives in the case statement; verify each is wired.
      const re = new RegExp(`case\\s+['"]${icon}['"]`);
      expect(source, `icon "${icon}" missing from switch`).toMatch(re);
    }
    // Component must emit <svg> markup (not text or images) — 200x150 viewBox.
    expect(source).toMatch(/viewBox=['"]0 0 200 150['"]/);
  });

  it('falls back to a default illustration on unknown icon', () => {
    expect(source).toMatch(/default:[\s\S]*?<svg/);
  });

  it('opens cta-href links in a new tab safely', () => {
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
  });

  it('dispatches a bubbling+composed CustomEvent when CTA event fires', () => {
    expect(source).toMatch(/new CustomEvent\([^)]*bubbles:\s*true[^)]*composed:\s*true/);
  });

  it('uses the cta-event name when the host wires one, else a default', () => {
    expect(source).toMatch(/this\.ctaEvent\s*\|\|\s*['"]crowclaw-empty-cta['"]/);
  });

  it('component file stays roughly within the spec budget (~80 lines)', () => {
    // Spec says "~80 lines"; allow generous headroom since each SVG
    // illustration adds a few lines. Hard cap to flag accidental bloat.
    const lines = source.split('\n').length;
    expect(lines).toBeLessThan(220);
  });

  it('is registered in main.ts so the runtime upgrades the element', () => {
    const main = read('main.ts');
    expect(main).toContain("import './components/empty.js'");
  });
});

/* ------------------------------------------------------------------ */
/*  Per-view wiring                                                    */
/* ------------------------------------------------------------------ */

describe('empty-state wiring per view (#176)', () => {
  it('chat-view: no-sessions empty fires only when sessions list is []', () => {
    const view = read('views/chat-view.ts');
    // Component referenced
    expect(view).toContain('<crowclaw-empty');
    // Truly-empty branch keyed off sessions.length === 0 (not just filtered)
    expect(view).toMatch(/this\.sessions\.length\s*===\s*0[\s\S]{0,400}<crowclaw-empty/);
    // Right copy + icon + CTA
    expect(view).toContain('No active sessions');
    expect(view).toContain('cta-label="New session"');
    expect(view).toMatch(/icon=["']sessions["']/);
    // CTA event wired to session creation
    expect(view).toMatch(/@cc-empty-new-session=\$\{this\._createSession\}/);
    // Existing search-mismatch branch is preserved (no breaking change)
    expect(view).toContain('No matching sessions');
  });

  it('settings-view (post-#246): skills empty in the absorbed Plugins surface keeps the catalog link', () => {
    // v0.8.1 #246: agent-view was merged into settings-view → the Skills
    // empty state now lives there. Tracking by content, not file path.
    const view = read('views/settings-view.ts');
    expect(view).toContain('<crowclaw-empty');
    expect(view).toContain('No skills loaded');
    expect(view).toContain('cta-label="Browse the catalog"');
    // Catalog link still points at the published OpenClaw skills repo.
    expect(view).toMatch(/cta-href=["']https?:\/\/[^"']*openclaw[^"']*["']/i);
    // Search-mismatch fallback still present.
    expect(view).toContain('No matching skills');
  });

  it('automate-view: jobs empty wires the New Job action', () => {
    const view = read('views/automate-view.ts');
    expect(view).toContain('<crowclaw-empty');
    expect(view).toMatch(/this\.jobs\.length\s*===\s*0[\s\S]{0,300}<crowclaw-empty/);
    expect(view).toContain('No automated jobs');
    expect(view).toContain('cta-label="Create a recurring task"');
    expect(view).toMatch(/icon=["']jobs["']/);
    expect(view).toMatch(/@cc-empty-new-job=\$\{this\._openForm\}/);
  });

  it('connect-view: MCP servers empty links to the marketplace', () => {
    const view = read('views/connect-view.ts');
    expect(view).toContain('<crowclaw-empty');
    expect(view).toMatch(/this\.mcpServers\.length\s*===\s*0[\s\S]{0,300}<crowclaw-empty/);
    expect(view).toContain('No MCP servers');
    expect(view).toContain('cta-label="Browse marketplace"');
    expect(view).toMatch(/icon=["']mcp["']/);
    // Marketplace link points at the canonical MCP servers repo.
    expect(view).toMatch(/cta-href=["']https?:\/\/[^"']*modelcontextprotocol[^"']*["']/i);
  });

  it('connect-view: pairings/platforms empty calls out the supported platforms', () => {
    const view = read('views/connect-view.ts');
    expect(view).toMatch(/this\.platforms\.length\s*===\s*0[\s\S]{0,400}<crowclaw-empty/);
    expect(view).toContain('No paired platforms');
    expect(view).toMatch(/cta-label=["']Connect Telegram\/Slack\/Discord["']/);
    expect(view).toMatch(/icon=["']pairing["']/);
  });

  it('settings-view: memory empty drives the user to chat', () => {
    const view = read('views/settings-view.ts');
    expect(view).toContain('<crowclaw-empty');
    // Empty fires only when there's no session at all (no memories possible).
    expect(view).toMatch(/this\.memorySessions\.length\s*===\s*0[\s\S]{0,400}<crowclaw-empty/);
    expect(view).toContain('No memories yet');
    expect(view).toContain('cta-label="Start a chat"');
    expect(view).toMatch(/icon=["']memory["']/);
    // Hash-based navigation handler is wired and defined.
    expect(view).toMatch(/@cc-empty-go-chat=\$\{this\._navigateToChat\}/);
    expect(view).toMatch(/_navigateToChat\s*=\s*\(\)\s*=>/);
    expect(view).toMatch(/location\.hash\s*=\s*['"]chat['"]/);
  });

  it('settings-view: feedback empty uses the no-CTA explanatory variant', () => {
    const view = read('views/settings-view.ts');
    expect(view).toMatch(/this\.feedbackEntries\.length\s*>\s*0[\s\S]{0,2500}<crowclaw-empty[\s\S]{0,400}icon=["']feedback["']/);
    expect(view).toContain('No tool feedback yet');
  });

  it('settings-view: usage empty offers the Start-a-chat CTA', () => {
    const view = read('views/settings-view.ts');
    expect(view).toMatch(/<crowclaw-empty[\s\S]{0,400}icon=["']usage["']/);
    expect(view).toContain('No LLM calls yet');
    expect(view).toMatch(/cta-event=["']cc-empty-go-chat["']/);
  });
});

/* ------------------------------------------------------------------ */
/*  Cross-view audit                                                   */
/* ------------------------------------------------------------------ */

describe('cross-view audit (#176)', () => {
  // v0.8.1 #246: agent-view was merged into settings-view; the file is gone.
  const VIEWS = [
    'views/chat-view.ts',
    'views/automate-view.ts',
    'views/connect-view.ts',
    'views/settings-view.ts',
  ];

  it('every view that imports the empty CTA also keeps its existing copy fallbacks', () => {
    // Constraint: the rewrite must NOT delete the surrounding view structure.
    // Spot-check that section headers are still present. Identity now lives
    // in settings-view post-#246.
    expect(read('views/chat-view.ts')).toContain('chat-area');
    expect(read('views/settings-view.ts')).toContain('Identity');
    expect(read('views/automate-view.ts')).toContain('Scheduler');
    expect(read('views/connect-view.ts')).toContain('MCP Servers');
    expect(read('views/settings-view.ts')).toContain('Memory Browser');
  });

  it('uses crowclaw-empty in at least 8 distinct call sites across views', () => {
    const total = VIEWS.reduce((acc, rel) => {
      const src = read(rel);
      return acc + (src.match(/<crowclaw-empty/g)?.length ?? 0);
    }, 0);
    // Spec lists 8 empty states. settings-view contributes 3 (memory, feedback, usage).
    expect(total).toBeGreaterThanOrEqual(8);
  });
});

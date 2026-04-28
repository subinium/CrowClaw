/**
 * v0.7.0 session-action UI components — issues #193, #194, #195.
 *
 * The dashboard ships v0.6.0 routes (#145 steer, #146 fork, #84 toolset
 * restriction, checkpoint/restore/replay) but the operator surfaces them
 * via CSS-styled custom elements. These tests lock the contracts:
 *
 *   - Each component file exports a Lit element with the expected tag.
 *   - The HTTP routes the components POST to match the runtime contract
 *     (route paths only — behavioral routing is covered elsewhere).
 *   - The chat-view orchestration wires triggers to the components and
 *     subscribes to the EventBus lifecycle events.
 *
 * The runtime tests are environment=node (vitest config), and Lit needs a
 * DOM to fully render. Rather than ship JSDOM only for these tests we read
 * the source files and assert structural invariants — the same approach
 * `dashboard-polish.test.ts` uses for the bundled dashboard string. This
 * keeps the test fast and avoids a heavyweight env switch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, '..', 'packages', 'web', 'ui', 'src');

const readUi = (relPath: string): string =>
  readFileSync(resolve(UI_ROOT, relPath), 'utf-8');

// --- Component file fixtures (read once per suite) -------------------------

const steerSrc = readUi('components/steer-composer.ts');
const forkSrc = readUi('components/fork-modal.ts');
const cpSrc = readUi('components/checkpoint-panel.ts');
const indexSrc = readUi('components/index.ts');
const chatViewSrc = readUi('views/chat-view.ts');

describe('#193 — steer composer', () => {
  it('registers the <crowclaw-steer-composer> custom element', () => {
    expect(steerSrc).toContain("@customElement('crowclaw-steer-composer')");
    expect(steerSrc).toContain('export class CrowClawSteerComposer');
  });

  it('POSTs to /api/sessions/:id/steer with a directive payload (#145 contract)', () => {
    expect(steerSrc).toContain('/api/sessions/${encodeURIComponent(this.sessionId)}/steer');
    expect(steerSrc).toContain("method: 'POST'");
    expect(steerSrc).toMatch(/JSON\.stringify\(\{\s*directive\s*\}\)/);
  });

  it('emits a `steered` CustomEvent on success so the parent can drop a marker', () => {
    expect(steerSrc).toMatch(/new CustomEvent\(['"]steered['"]/);
    // Detail must include both the directive and the runtime-injected prompt
    // so the chat-view marker shows what the agent actually received.
    expect(steerSrc).toMatch(/directive.*injectedPrompt|injectedPrompt.*directive/s);
  });

  it('binds Enter to submit and Escape to cancel for keyboard-first use', () => {
    expect(steerSrc).toContain("e.key === 'Enter'");
    expect(steerSrc).toContain("e.key === 'Escape'");
    // Shift+Enter must NOT submit — it should be reserved for newlines.
    expect(steerSrc).toMatch(/!e\.shiftKey/);
  });

  it('shows a toast on the 409 SESSION_NOT_ACTIVE error path (#145)', () => {
    // The component must call showToast in the catch branch — without this
    // the 409 case from the runtime is invisible.
    expect(steerSrc).toContain('showToast');
    expect(steerSrc).toMatch(/catch[\s\S]*showToast/);
  });
});

describe('#194 — fork modal', () => {
  it('registers the <crowclaw-fork-modal> custom element', () => {
    expect(forkSrc).toContain("@customElement('crowclaw-fork-modal')");
    expect(forkSrc).toContain('export class CrowClawForkModal');
  });

  it('exports the ForkParentInfo type for typed parent props', () => {
    expect(forkSrc).toContain('export interface ForkParentInfo');
    expect(forkSrc).toContain('sessionId');
  });

  it('uses <crowclaw-modal> for chrome and renders a parent preview block', () => {
    expect(forkSrc).toContain("import './modal.js'");
    expect(forkSrc).toContain('<crowclaw-modal');
    expect(forkSrc).toContain('parent-card');
  });

  it('POSTs to /api/sessions/:id/fork with task + optional enabledToolsets (#146 + #84)', () => {
    expect(forkSrc).toContain('/api/sessions/${encodeURIComponent(this.parent.sessionId)}/fork');
    expect(forkSrc).toContain("method: 'POST'");
    // enabledToolsets must be omitted when no chips are selected — the
    // runtime treats undefined as 'inherit parent', a non-empty array as
    // 'restrict child'. Sending [] would be ambiguous.
    expect(forkSrc).toMatch(/enabledToolsets\.length\s*>\s*0/);
  });

  it('emits a `forked` CustomEvent with parent + child ids', () => {
    expect(forkSrc).toMatch(/new CustomEvent\(['"]forked['"]/);
    expect(forkSrc).toContain('parentSessionId');
    expect(forkSrc).toContain('forkSessionId');
  });

  it('shows a confirmation toast referencing the parent session', () => {
    expect(forkSrc).toMatch(/Forked from/);
    expect(forkSrc).toContain('showToast');
  });

  it('exposes a toolset multi-select rendered as toggleable chips', () => {
    expect(forkSrc).toContain('availableToolsets');
    expect(forkSrc).toContain('toolset-chips');
    expect(forkSrc).toMatch(/_toggleToolset/);
  });
});

describe('#195 — checkpoint panel', () => {
  it('registers the <crowclaw-checkpoint-panel> custom element', () => {
    expect(cpSrc).toContain("@customElement('crowclaw-checkpoint-panel')");
    expect(cpSrc).toContain('export class CrowClawCheckpointPanel');
  });

  it('exports the CheckpointInfo type for typed list props', () => {
    expect(cpSrc).toContain('export interface CheckpointInfo');
  });

  it('lists checkpoints from /api/sessions/:id/checkpoints', () => {
    expect(cpSrc).toContain('/api/sessions/${encodeURIComponent(this.sessionId)}/checkpoints');
  });

  it('saves new checkpoints with an optional label payload', () => {
    expect(cpSrc).toContain('/api/sessions/${encodeURIComponent(this.sessionId)}/checkpoint');
    expect(cpSrc).toMatch(/label\s*\?\s*\{\s*label\s*\}\s*:\s*\{\}/);
  });

  it('restores via POST /restore with the checkpointId payload', () => {
    expect(cpSrc).toContain('/api/sessions/${encodeURIComponent(this.sessionId)}/restore');
    expect(cpSrc).toMatch(/JSON\.stringify\(\{\s*checkpointId:\s*cp\.id\s*\}\)/);
  });

  it('replays via POST /replay and emits `replay-opened` with the new sessionId', () => {
    expect(cpSrc).toContain('/api/sessions/${encodeURIComponent(this.sessionId)}/replay');
    expect(cpSrc).toMatch(/new CustomEvent\(['"]replay-opened['"]/);
  });

  it('uses an inline two-step confirm for restore (no separate dialog)', () => {
    expect(cpSrc).toMatch(/_confirmingId/);
    // The 4-second auto-revert prevents a stale confirm state from
    // catching a later double-click.
    expect(cpSrc).toMatch(/setTimeout/);
  });

  it('exposes refresh() for the parent to forward session:compacted events', () => {
    expect(cpSrc).toMatch(/async refresh\(\)/);
  });

  it('exposes a count getter so the parent can label `Checkpoints (N)`', () => {
    expect(cpSrc).toMatch(/get count\(\)/);
  });
});

describe('component barrel', () => {
  it('re-exports all three v0.7 session-action components and types', () => {
    expect(indexSrc).toContain("from './steer-composer.js'");
    expect(indexSrc).toContain("from './fork-modal.js'");
    expect(indexSrc).toContain("from './checkpoint-panel.js'");
    expect(indexSrc).toContain('CrowClawSteerComposer');
    expect(indexSrc).toContain('CrowClawForkModal');
    expect(indexSrc).toContain('ForkParentInfo');
    expect(indexSrc).toContain('CrowClawCheckpointPanel');
    expect(indexSrc).toContain('CheckpointInfo');
  });

  it('side-effect imports each component so custom elements register', () => {
    expect(indexSrc).toContain("import './steer-composer.js'");
    expect(indexSrc).toContain("import './fork-modal.js'");
    expect(indexSrc).toContain("import './checkpoint-panel.js'");
  });
});

describe('chat-view wiring', () => {
  it('imports all three new components for tag registration', () => {
    expect(chatViewSrc).toContain("import '../components/steer-composer.js'");
    expect(chatViewSrc).toContain("import '../components/fork-modal.js'");
    expect(chatViewSrc).toContain("import '../components/checkpoint-panel.js'");
  });

  it('renders <crowclaw-steer-composer> only while the session is running (#193)', () => {
    // The sticky wrap is gated on `streaming || _isSessionActive(...)`.
    expect(chatViewSrc).toContain('<crowclaw-steer-composer');
    expect(chatViewSrc).toMatch(/this\.streaming\s*\|\|\s*this\._isSessionActive/);
  });

  it('adds a Fork session... item to the 3-dot context menu (#194)', () => {
    expect(chatViewSrc).toMatch(/Fork session\.\.\./);
    expect(chatViewSrc).toContain('_openForkModal');
    expect(chatViewSrc).toContain('<crowclaw-fork-modal');
  });

  it('adds a header `Checkpoints (N)` button that opens the side panel (#195)', () => {
    expect(chatViewSrc).toMatch(/Checkpoints \(\$\{this\.checkpointCount\}\)/);
    expect(chatViewSrc).toContain('_toggleCheckpointPanel');
    expect(chatViewSrc).toContain('<crowclaw-checkpoint-panel');
  });

  it('subscribes to crowclaw:session-event for steered/forked/compacted updates', () => {
    expect(chatViewSrc).toContain("'session:steered'");
    expect(chatViewSrc).toContain("'session:forked'");
    expect(chatViewSrc).toContain("'session:compacted'");
    expect(chatViewSrc).toContain("addEventListener('crowclaw:session-event'");
  });

  it('refreshes the checkpoint badge + panel on session:compacted', () => {
    // Compaction rewrites message indices that older checkpoints reference;
    // without these refreshes the panel + button label go stale until the
    // operator manually re-opens the panel.
    expect(chatViewSrc).toContain('_loadCheckpointCount');
    expect(chatViewSrc).toMatch(/cpPanel\?\.refresh/);
  });

  it('navigates to the new session on fork/replay success', () => {
    // _selectSession is what flips currentSessionId + reloads history.
    expect(chatViewSrc).toMatch(/_onForked[\s\S]*_selectSession\(e\.detail\.forkSessionId\)/);
    expect(chatViewSrc).toMatch(/_onReplayOpened[\s\S]*_selectSession\(e\.detail\.newSessionId\)/);
  });
});

describe('runtime route contract — sanity checks', () => {
  /**
   * The components hardcode REST paths; if route-paths.ts shifts these,
   * the components silently break. Lock the paths here so a route rename
   * surfaces a test failure rather than a runtime 404.
   */
  it('REST paths the components reference match the runtime contract', async () => {
    const { routePaths } = await import('../packages/runtime-node/src/route-paths.js');
    // Only steer + fork are mounted on the route-paths mirror; checkpoint /
    // restore / replay live on the same `:id/:action` dispatch but aren't
    // on the typed manifest. We therefore cross-check those via the
    // runtime source string.
    expect(routePaths.sessions.steer).toBe('/api/sessions/:id/steer');
    expect(routePaths.sessions.fork).toBe('/api/sessions/:id/fork');
    const runtimeSrc = readFileSync(
      resolve(__dirname, '..', 'packages', 'runtime-node', 'src', 'index.ts'),
      'utf-8',
    );
    expect(runtimeSrc).toMatch(/action === 'checkpoint'/);
    expect(runtimeSrc).toMatch(/action === 'restore'/);
    expect(runtimeSrc).toMatch(/action === 'replay'/);
  });
});

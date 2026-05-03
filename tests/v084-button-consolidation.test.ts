/**
 * v0.8.4 #244 — chat-view button-style consolidation.
 *
 * The v0.8.1 button library shipped <crowclaw-button> with 4 variants and 3
 * sizes, but chat-view kept rolling its own `.ops-btn`, `.steer-sticky-btn`,
 * and `.cp-restore` styles plus a few residual `<button class="btn ...">`
 * call sites. This sweep migrates them so the toolbar, the steer trigger,
 * and the bulk-action / load-more chips all flow through the component.
 *
 * Source-string assertions because the live DOM lives behind shadow roots
 * that don't load cleanly in a Node Vitest environment.
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
// Legacy class names removed from runtime markup
// ---------------------------------------------------------------------------

describe('v0.8.4 #244 — legacy hand-rolled button classes are gone', () => {
  it('chat-view markup no longer renders <button class="ops-btn ...">', () => {
    // Comments referencing the legacy name are allowed (so future readers
    // know the migration path); only `class="ops-btn` literal class
    // references in real markup are forbidden.
    expect(CHAT_VIEW_SRC).not.toMatch(/<button[^>]*class="ops-btn/);
  });

  it('chat-view markup no longer renders <button class="steer-sticky-btn ...">', () => {
    expect(CHAT_VIEW_SRC).not.toMatch(/<button[^>]*class="steer-sticky-btn/);
  });

  it('chat-view markup no longer references the .cp-restore class', () => {
    // The cp-restore CSS rule was dead since v0.8.1 #247 moved the
    // checkpoint UI out of chat-view; the rule is dropped in this sweep.
    expect(CHAT_VIEW_SRC).not.toMatch(/cp-restore/);
  });

  it('chat-view markup no longer renders <button class="btn ...">', () => {
    // The generic `.btn` / `.btn-danger` shared-styles rules were stubbed
    // out in v0.8.1; the remaining bulk / load-more call sites migrate
    // here.
    expect(CHAT_VIEW_SRC).not.toMatch(/<button[^>]*class="btn(?:\s|")/);
    expect(CHAT_VIEW_SRC).not.toMatch(/<button[^>]*class="btn btn-danger"/);
  });
});

// ---------------------------------------------------------------------------
// <crowclaw-button> is the new home for these affordances
// ---------------------------------------------------------------------------

describe('v0.8.4 #244 — chat-view uses <crowclaw-button> for ops actions', () => {
  it('imports the button component', () => {
    expect(CHAT_VIEW_SRC).toContain("import '../components/button.js'");
  });

  it('Abort uses <crowclaw-button variant="danger" size="sm"> when armed', () => {
    // The abort affordance toggles between danger (idle) and secondary
    // (aborting) variants.
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+variant=\$\{this\.aborting \? 'secondary' : 'danger'\}[\s\S]+aria-label="Abort session"/,
    );
  });

  it('the search trigger in the ops toolbar uses crowclaw-button', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+variant="secondary"[\s\S]+aria-label="Search messages"/,
    );
  });

  it('the steer-sticky trigger uses crowclaw-button with a leading icon slot', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+class="steer-sticky"[\s\S]+aria-label="Steer the running agent"[\s\S]+<crowclaw-icon slot="icon"/,
    );
  });

  it('bulk-delete and clear in the sessions sidebar use crowclaw-button', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button variant="danger" size="sm" @click=\$\{this\._bulkDeleteSelected\}/,
    );
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button variant="secondary" size="sm" @click=\$\{this\._clearSessionSelection\}/,
    );
  });

  it('the load-more sessions trigger uses crowclaw-button with loading state', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+\?disabled=\$\{this\.sessionsLoadingMore\}[\s\S]+\?loading=\$\{this\.sessionsLoadingMore\}[\s\S]+@click=\$\{this\._loadMoreSessions\}/,
    );
  });

  it('the message-window expander uses crowclaw-button', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+@click=\$\{this\._expandMessageWindow\}/,
    );
  });

  it('the sidebar toggle uses crowclaw-button with the menu icon', () => {
    expect(CHAT_VIEW_SRC).toMatch(
      /<crowclaw-button[\s\S]+class="sess-toggle-btn"[\s\S]+aria-label="Toggle sidebar"/,
    );
  });
});

// ---------------------------------------------------------------------------
// CSS rules dropped
// ---------------------------------------------------------------------------

describe('v0.8.4 #244 — legacy CSS rules dropped', () => {
  it('the chat-view stylesheet no longer defines .ops-btn rules', () => {
    // No rule body — only comments may mention the removed selector.
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.ops-btn\s*\{/m);
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.ops-btn\.danger\s*\{/m);
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.ops-btn\.aborting\s*\{/m);
  });

  it('the chat-view stylesheet no longer defines .steer-sticky-btn rules', () => {
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.steer-sticky-btn\s*\{/m);
  });

  it('the dead checkpoint-overlay / cp-* rules are dropped', () => {
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.checkpoint-overlay\s*\{/m);
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.cp-item\s*\{/m);
    expect(CHAT_VIEW_SRC).not.toMatch(/^\s*\.cp-item\s+\.cp-restore\s*\{/m);
  });
});

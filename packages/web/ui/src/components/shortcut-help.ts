/**
 * `<crowclaw-shortcut-help>` — searchable modal listing every keyboard
 * binding (v0.8.1 #248).
 *
 * Triggered by the global `?` shortcut (wired by Agent A7 in
 * `lib/keyboard.ts`). Bindings come from the `SHORTCUTS` constant exported
 * from that same module — Agent A7 owns the data, this file owns the
 * presentation.
 *
 * UI:
 *   - Modal `<div role="dialog" aria-modal="true" aria-labelledby="...">`.
 *   - Search input filters by label, key combo, or group name.
 *   - Bindings grouped (Navigation / Chat / Inspector / Power user).
 *   - Each row: kbd-style key combo on the left, description on the right.
 *
 * Behaviour:
 *   - Escape closes.
 *   - Focus is trapped inside the dialog while open.
 *   - Backdrop click closes.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

/**
 * Keyboard binding shape. Mirror of what `lib/keyboard.ts` exports as
 * `SHORTCUTS` (Agent A7). Re-declared locally so this file stays
 * type-safe even before A7 lands.
 */
export interface ShortcutBinding {
  /** Human-readable description (e.g., "Open command palette"). */
  label: string;
  /**
   * Visible key tokens, rendered each in its own <kbd>. E.g. `['⌘', 'K']`
   * or `['Shift', '?']`. Order is preserved.
   */
  keys: string[];
  /** Group bucket — used to sort rows into sections. */
  group: 'Navigation' | 'Chat' | 'Inspector' | 'Power user';
}

// Type-only import so we keep a typed handle on `SHORTCUTS` without forcing
// the module to be present at load time. The runtime fallback below covers
// the case where Agent A7 hasn't shipped yet.
type ShortcutsModule = {
  SHORTCUTS?: ShortcutBinding[];
};

const GROUPS: ShortcutBinding['group'][] = [
  'Navigation',
  'Chat',
  'Inspector',
  'Power user',
];

@customElement('crowclaw-shortcut-help')
export class CrowClawShortcutHelp extends LitElement {
  static styles = css`
    :host {
      display: contents;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 1400;
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding-top: 12vh;
      background: var(--bg-overlay, rgba(0, 0, 0, 0.55));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .overlay.on { display: flex; }

    .panel {
      width: min(560px, 92vw);
      max-height: 76vh;
      display: flex;
      flex-direction: column;
      background: var(--surface-2, var(--bg-secondary, #13131a));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-lg, 12px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--sp-3, 12px);
      padding: var(--sp-4, 16px) var(--sp-5, 20px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }
    .title {
      flex: 1;
      font-size: var(--text-lg, 16px);
      font-weight: 600;
      color: var(--text, var(--text-primary, #ededef));
      margin: 0;
    }
    .close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: transparent;
      color: var(--text-muted, #8e8e93);
      border: none;
      border-radius: var(--radius-sm, 6px);
      cursor: pointer;
      font-family: inherit;
    }
    .close:hover {
      color: var(--text, var(--text-primary, #ededef));
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
    }
    .close:focus { outline: none; }
    .close:focus-visible {
      outline: 2px solid var(--accent, #e05545);
      outline-offset: 2px;
    }

    .search-wrap {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: var(--sp-3, 12px) var(--sp-5, 20px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    }
    .search-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      font-family: inherit;
      color: var(--text, var(--text-primary, #ededef));
      font-size: var(--text-sm, 13px);
    }
    .search-input::placeholder { color: var(--text-muted, #8e8e93); }

    .body {
      flex: 1;
      overflow-y: auto;
      padding: var(--sp-3, 12px) 0;
    }

    .group {
      padding: var(--sp-2, 8px) var(--sp-5, 20px) var(--sp-2, 8px);
    }
    .group-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-muted, #8e8e93);
      margin: 0 0 var(--sp-2, 8px) 0;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3, 12px);
      padding: 6px 0;
    }
    .row .desc {
      flex: 1;
      min-width: 0;
      color: var(--text, var(--text-primary, #ededef));
      font-size: var(--text-sm, 13px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .keys {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 11px;
      color: var(--text, var(--text-primary, #ededef));
      box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.3);
    }

    .empty {
      padding: var(--sp-8, 32px) var(--sp-5, 20px);
      text-align: center;
      color: var(--text-muted, #8e8e93);
      font-size: var(--text-sm, 13px);
    }
  `;

  /** Toggle visibility from the outside (Agent A7's keyboard listener). */
  @state() open = false;
  @state() private _query = '';
  @state() private _bindings: ShortcutBinding[] = [];

  @query('.search-input') private _input!: HTMLInputElement;
  @query('.panel') private _panel!: HTMLElement;

  /** Public API mirroring command-palette so A7 can `.show()` / `.hide()`. */
  show(): void {
    if (this.open) return;
    this.open = true;
    void this._loadBindings();
    requestAnimationFrame(() => this._input?.focus());
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this._query = '';
  }

  private async _loadBindings(): Promise<void> {
    if (this._bindings.length > 0) return;
    try {
      const mod: ShortcutsModule = await import('../lib/keyboard.js');
      if (Array.isArray(mod.SHORTCUTS)) {
        this._bindings = mod.SHORTCUTS;
      }
    } catch {
      // A7 hasn't published SHORTCUTS yet — render empty state.
      this._bindings = [];
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKey, { capture: true });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKey, { capture: true });
  }

  private _onKey = (e: KeyboardEvent) => {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }
    if (e.key === 'Tab') {
      this._trapFocus(e);
    }
  };

  /** Keep focus inside the dialog while it's open. */
  private _trapFocus(e: KeyboardEvent): void {
    if (!this._panel) return;
    const focusables = this._panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const root = this.shadowRoot;
    const active = root?.activeElement as HTMLElement | null;

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private _filtered(): Record<string, ShortcutBinding[]> {
    const q = this._query.trim().toLowerCase();
    const out: Record<string, ShortcutBinding[]> = {};
    for (const g of GROUPS) out[g] = [];
    for (const b of this._bindings) {
      if (q) {
        const hay = `${b.label} ${b.keys.join(' ')} ${b.group}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      (out[b.group] ??= []).push(b);
    }
    return out;
  }

  private _onBackdrop = () => this.hide();

  render() {
    if (!this.open) {
      return html`<div class="overlay" aria-hidden="true"></div>`;
    }
    const grouped = this._filtered();
    const total = Object.values(grouped).reduce((n, l) => n + l.length, 0);

    return html`
      <div class="overlay on" @click=${this._onBackdrop}>
        <div
          class="panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcut-help-title"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="header">
            <h2 id="shortcut-help-title" class="title">Keyboard shortcuts</h2>
            <button
              class="close"
              type="button"
              aria-label="Close shortcut help"
              @click=${this.hide}
            >
              <crowclaw-icon name="x" size="14"></crowclaw-icon>
            </button>
          </div>

          <div class="search-wrap">
            <crowclaw-icon name="search" size="14"></crowclaw-icon>
            <input
              class="search-input"
              type="text"
              placeholder="Search shortcuts..."
              .value=${this._query}
              @input=${(e: InputEvent) => {
                this._query = (e.target as HTMLInputElement).value;
              }}
              autocomplete="off"
              spellcheck="false"
              aria-label="Filter keyboard shortcuts"
            />
          </div>

          <div class="body">
            ${total === 0
              ? html`<div class="empty">
                  ${this._bindings.length === 0
                    ? 'No shortcuts registered yet.'
                    : 'No shortcuts match your search.'}
                </div>`
              : GROUPS.map((g) => this._renderGroup(g, grouped[g]))}
          </div>
        </div>
      </div>
    `;
  }

  private _renderGroup(name: ShortcutBinding['group'], rows: ShortcutBinding[]) {
    if (rows.length === 0) return nothing;
    return html`
      <section class="group">
        <h3 class="group-label">${name}</h3>
        ${rows.map(
          (b) => html`
            <div class="row">
              <span class="desc">${b.label}</span>
              <span class="keys">
                ${b.keys.map((k) => html`<kbd>${k}</kbd>`)}
              </span>
            </div>
          `,
        )}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-shortcut-help': CrowClawShortcutHelp;
  }
}

/**
 * `<crowclaw-inspector-rail>` (v0.8.1 #247).
 *
 * Right-side fixed rail with three tabs (Trace / Memory / Checkpoints).
 * Callers inject content via named slots so this component owns only the
 * shell — the chat-view orchestrator wires slot contents.
 *
 * Behaviour:
 *   - Collapsed = 40px, expanded = 360px.
 *   - Click tab: select + expand. Click selected tab again or `Escape`:
 *     collapse (unless lock-open is on, in which case Escape is a no-op).
 *   - Lock-open toggle in the footer; persisted via localStorage key
 *     `crowclaw-rail-locked` so the user's preference rides across reloads.
 *   - Active tab gets a 3px wide left-side accent bar.
 *   - Mobile (`max-width: 768px`): the rail becomes a bottom sheet — tabs
 *     run along the top of the sheet, content fills below.
 *   - Keyboard: Tab cycles tab buttons (browser native), Enter activates,
 *     Escape collapses (unless locked).
 *
 * ARIA:
 *   - Tabs are `role="tab"` with `aria-selected`.
 *   - Each panel is `role="tabpanel"` with `aria-labelledby` pointing at
 *     the corresponding tab id.
 */

import { LitElement, html, css } from 'lit';
import { customElement, state, property } from 'lit/decorators.js';

const STORAGE_KEY = 'crowclaw-rail-locked';

type RailTab = 'trace' | 'memory' | 'checkpoints';

interface TabDef {
  id: RailTab;
  label: string;
  /** Icon name forwarded to `<crowclaw-icon>`. */
  icon: string;
}

const TABS: readonly TabDef[] = [
  { id: 'trace',       label: 'Trace',       icon: 'activity' },
  { id: 'memory',      label: 'Memory',      icon: 'database' },
  { id: 'checkpoints', label: 'Checkpoints', icon: 'bookmark' },
] as const;

@customElement('crowclaw-inspector-rail')
export class CrowClawInspectorRail extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 40px;
      z-index: 600;
      display: flex;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      transition: width var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      background: var(--surface-1, var(--bg-secondary, #13131a));
      border-left: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      box-sizing: border-box;
    }

    :host([expanded]) {
      width: 360px;
    }

    .shell {
      display: flex;
      width: 100%;
      height: 100%;
    }

    /* ----- Tab strip (vertical on desktop) --------------------------- */
    .tabs {
      display: flex;
      flex-direction: column;
      width: 40px;
      flex-shrink: 0;
      border-right: 1px solid var(--border, rgba(255, 255, 255, 0.06));
    }

    .tab {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 44px;
      width: 100%;
      background: transparent;
      border: none;
      color: var(--text-muted, #8e8e93);
      cursor: pointer;
      font-family: inherit;
      transition: color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }
    .tab:hover { color: var(--text, var(--text-primary, #ededef)); }
    .tab:focus { outline: none; }
    .tab:focus-visible {
      outline: 2px solid var(--accent, #e05545);
      outline-offset: -2px;
    }
    .tab[aria-selected='true'] {
      color: var(--text, var(--text-primary, #ededef));
    }
    .tab[aria-selected='true']::before {
      content: '';
      position: absolute;
      left: 0;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: 0 2px 2px 0;
      background: var(--accent, #e05545);
    }

    .tab-label {
      display: none;
    }

    /* ----- Body & footer -------------------------------------------- */
    .body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }

    .panels {
      flex: 1;
      overflow: hidden;
      position: relative;
    }
    .panel {
      position: absolute;
      inset: 0;
      overflow: auto;
      padding: var(--sp-3, 12px);
      box-sizing: border-box;
      display: none;
    }
    .panel.active { display: block; }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #8e8e93);
      flex-shrink: 0;
    }

    .lock {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: 3px 8px;
      color: var(--text-muted, #8e8e93);
      font-family: inherit;
      font-size: var(--text-xs, 11px);
      cursor: pointer;
      transition: color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }
    .lock:hover { color: var(--text, var(--text-primary, #ededef)); }
    .lock[aria-pressed='true'] {
      color: var(--accent, #e05545);
      border-color: var(--accent, #e05545);
    }
    .lock:focus { outline: none; }
    .lock:focus-visible {
      outline: 2px solid var(--accent, #e05545);
      outline-offset: 2px;
    }

    /* When collapsed, hide everything except the tab strip */
    :host(:not([expanded])) .body { display: none; }

    /* ---------- Mobile: bottom sheet -------------------------------- */
    @media (max-width: 768px) {
      :host {
        top: auto;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        height: 44px;
        border-left: none;
        border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        transition: height var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      }
      :host([expanded]) {
        width: 100%;
        height: min(60vh, 480px);
      }

      .shell { flex-direction: column; }

      .tabs {
        flex-direction: row;
        width: 100%;
        height: 44px;
        border-right: none;
        border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      }
      .tab { height: 44px; flex: 1; }
      .tab[aria-selected='true']::before {
        top: auto;
        bottom: 0;
        left: 8px;
        right: 8px;
        width: auto;
        height: 3px;
        border-radius: 2px 2px 0 0;
      }

      :host(:not([expanded])) .body { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }
  `;

  /** Currently-selected tab. Kept selected even while collapsed. */
  @state() private _active: RailTab = 'trace';

  /** Reflects whether the panel pane is showing. */
  @property({ type: Boolean, reflect: true }) expanded = false;

  /** When true, Escape no longer collapses the rail. Persisted. */
  @state() private _locked = false;

  connectedCallback(): void {
    super.connectedCallback();
    try {
      this._locked = localStorage.getItem(STORAGE_KEY) === '1';
      if (this._locked) this.expanded = true;
    } catch {
      /* localStorage unavailable — leave defaults. */
    }
    window.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKey);
  }

  private _onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.expanded && !this._locked) {
      // Ignore if focus is inside an input/textarea/contenteditable so we
      // don't fight modal dialogs that also handle Escape.
      const target = e.target as HTMLElement | null;
      if (target && this._isFormField(target)) return;
      this.expanded = false;
      this._emit('rail-toggle');
      e.stopPropagation();
    }
  };

  private _isFormField(el: HTMLElement): boolean {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  private _onTabClick(id: RailTab) {
    if (this._active === id && this.expanded) {
      // Click selected tab again → collapse (unless locked).
      if (!this._locked) {
        this.expanded = false;
        this._emit('rail-toggle');
      }
      return;
    }
    this._active = id;
    if (!this.expanded) {
      this.expanded = true;
      this._emit('rail-toggle');
    }
    this._emit('rail-select', { tab: id });
  }

  private _toggleLock = () => {
    this._locked = !this._locked;
    try {
      localStorage.setItem(STORAGE_KEY, this._locked ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this._locked && !this.expanded) {
      this.expanded = true;
      this._emit('rail-toggle');
    }
  };

  private _emit(name: string, detail?: unknown) {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, detail }),
    );
  }

  render() {
    return html`
      <div class="shell">
        <div class="tabs" role="tablist" aria-orientation="vertical">
          ${TABS.map((t) => {
            const selected = this._active === t.id && this.expanded;
            return html`
              <button
                id="cc-rail-tab-${t.id}"
                class="tab"
                role="tab"
                type="button"
                aria-selected=${selected ? 'true' : 'false'}
                aria-controls="cc-rail-panel-${t.id}"
                title=${t.label}
                @click=${() => this._onTabClick(t.id)}
              >
                <crowclaw-icon name=${t.icon} size="16"></crowclaw-icon>
                <span class="tab-label">${t.label}</span>
              </button>
            `;
          })}
        </div>

        <div class="body">
          <div class="panels">
            ${TABS.map(
              (t) => html`
                <div
                  id="cc-rail-panel-${t.id}"
                  class="panel ${this._active === t.id ? 'active' : ''}"
                  role="tabpanel"
                  aria-labelledby="cc-rail-tab-${t.id}"
                  ?hidden=${this._active !== t.id}
                >
                  <slot name=${t.id}></slot>
                </div>
              `,
            )}
          </div>
          <div class="footer">
            <span>${this._labelFor(this._active)}</span>
            <button
              class="lock"
              type="button"
              aria-pressed=${this._locked ? 'true' : 'false'}
              aria-label=${this._locked ? 'Unlock inspector rail' : 'Lock inspector rail open'}
              @click=${this._toggleLock}
            >
              <crowclaw-icon
                name=${this._locked ? 'check' : 'chevron-right'}
                size="12"
              ></crowclaw-icon>
              ${this._locked ? 'Locked' : 'Lock open'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _labelFor(id: RailTab): string {
    return TABS.find((t) => t.id === id)?.label ?? '';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-inspector-rail': CrowClawInspectorRail;
  }
}

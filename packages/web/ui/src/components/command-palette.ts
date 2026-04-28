/**
 * `<crowclaw-command-palette>` — Linear-style command palette opened by
 * Cmd+K / Ctrl+K (#178). Indexes four sources fetched lazily on first open:
 *
 *   - sessions  → GET /api/sessions?limit=200
 *   - memories  → GET /api/memory/snapshot
 *   - skills    → GET /api/skills
 *   - actions   → hardcoded (New chat / Reconnect WS / etc.)
 *
 * UI behaviour:
 *   - Tab cycles the active source filter
 *   - ArrowUp/Down moves the row cursor
 *   - Enter dispatches `crowclaw:cmdk-action` with the selected payload
 *   - Cmd/Ctrl+Enter dispatches the same with `newTab: true`
 *   - Esc closes; backdrop click closes
 *   - Recent searches persist to localStorage (max 20)
 *
 * Aggregation/scoring lives in `../lib/search.ts` so it can be unit-tested
 * without a DOM.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { api } from '../lib/api.js';
import {
  aggregateResults,
  loadRecent,
  saveRecent,
  type CommandResult,
  type CommandSource,
  type SessionLike,
  type MemoryLike,
  type SkillLike,
  type ActionLike,
} from '../lib/search.js';

interface SessionsResp {
  sessions?: Array<{ sessionId: string; title?: string; preview?: string }>;
}
interface MemorySnapshotResp {
  memory?: { entries?: Array<{ key: string; value: string; category?: string }> };
  user?: { entries?: Array<{ key: string; value: string; category?: string }> };
}
interface SkillsResp {
  skills?: Array<{ slug: string; title: string; summary?: string; triggerPhrases?: string[] }>;
}

const HARDCODED_ACTIONS: ActionLike[] = [
  { id: 'new-chat',         label: 'New chat',          hint: 'Start a fresh session' },
  { id: 'open-settings',    label: 'Open settings',     hint: 'Tokens, providers, presets' },
  { id: 'reconnect-ws',     label: 'Reconnect WS',      hint: 'Drop and re-establish transport' },
  { id: 'toggle-scheduler', label: 'Toggle scheduler',  hint: 'Pause or resume background jobs' },
  { id: 'switch-persona',   label: 'Switch persona',    hint: 'Pick a different agent persona' },
  { id: 'switch-preset',    label: 'Switch preset',     hint: 'Apply a config preset' },
];

const SOURCES: readonly CommandSource[] = ['sessions', 'memories', 'skills', 'actions'] as const;

const SOURCE_ICON: Record<CommandSource, string> = {
  sessions: '#',
  memories: 'M',
  skills: 'S',
  actions: '>',
};

const SOURCE_LABEL: Record<CommandSource, string> = {
  sessions: 'Sessions',
  memories: 'Memory',
  skills: 'Skills',
  actions: 'Actions',
};

@customElement('crowclaw-command-palette')
export class CrowClawCommandPalette extends LitElement {
  static styles = css`
    :host {
      display: contents;
      font-family: 'Inter', 'Noto Sans KR', var(--font-sans, -apple-system, sans-serif);
    }

    .overlay {
      position: fixed;
      inset: 0;
      z-index: 1500;
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding-top: 14vh;
      background: var(--bg-overlay, rgba(0, 0, 0, 0.55));
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
    }
    .overlay.on { display: flex; }

    .panel {
      width: min(640px, 92vw);
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.10));
      border-radius: var(--radius-lg, 12px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    .input-wrap {
      display: flex;
      align-items: center;
      gap: var(--sp-3, 12px);
      padding: var(--sp-4, 16px) var(--sp-5, 20px);
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
    }

    .input-icon {
      color: var(--text-muted, #6e6e76);
      font-size: 13px;
      font-family: var(--font-mono, ui-monospace, monospace);
    }

    .input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-primary, #ededef);
      font-size: 15px;
      font-family: inherit;
    }
    .input::placeholder { color: var(--text-muted, #6e6e76); }

    .kbd {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      font-size: 10px;
      font-family: var(--font-mono, ui-monospace, monospace);
      color: var(--text-muted, #6e6e76);
      background: var(--glass-bg, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      border-radius: 4px;
    }

    .tabs {
      display: flex;
      gap: 0;
      padding: 0 var(--sp-3, 12px);
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.06));
      flex-shrink: 0;
    }
    .tab {
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-muted, #6e6e76);
      cursor: pointer;
      border: none;
      background: transparent;
      border-bottom: 2px solid transparent;
      font-family: inherit;
    }
    .tab.active {
      color: var(--accent, #e05545);
      border-bottom-color: var(--accent, #e05545);
    }
    .tab .count {
      margin-left: 6px;
      font-size: 10px;
      opacity: 0.7;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: var(--sp-2, 8px) 0;
    }
    .list::-webkit-scrollbar { width: 6px; }
    .list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: var(--sp-3, 12px);
      padding: 8px var(--sp-5, 20px);
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    .row.active {
      background: var(--glass-bg, rgba(255, 255, 255, 0.04));
      border-left-color: var(--accent, #e05545);
    }
    .row .ic {
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-family: var(--font-mono, ui-monospace, monospace);
      color: var(--text-muted, #6e6e76);
      background: var(--glass-bg, rgba(255, 255, 255, 0.04));
      border-radius: 4px;
      flex-shrink: 0;
    }
    .row .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .row .title {
      color: var(--text-primary, #ededef);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row .crumb {
      color: var(--text-muted, #6e6e76);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .empty, .loading {
      padding: var(--sp-8, 32px) var(--sp-5, 20px);
      text-align: center;
      font-size: 12px;
      color: var(--text-muted, #6e6e76);
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px var(--sp-5, 20px);
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      font-size: 10px;
      color: var(--text-muted, #6e6e76);
      gap: var(--sp-3, 12px);
      flex-wrap: wrap;
      flex-shrink: 0;
    }
    .footer .grp { display: inline-flex; align-items: center; gap: 4px; }
  `;

  /** External "is open?" flag — read by `keyboard.ts` to toggle. */
  @state() open = false;
  @state() private _query = '';
  @state() private _activeSource: CommandSource = 'sessions';
  @state() private _activeIndex = 0;
  @state() private _loading = false;
  @state() private _sessions: SessionLike[] = [];
  @state() private _memories: MemoryLike[] = [];
  @state() private _skills: SkillLike[] = [];
  @state() private _recent: string[] = [];

  @query('.input') private _inputEl!: HTMLInputElement;

  private _loaded = false;

  /** Show the palette; lazy-load sources on first open. */
  show(): void {
    if (this.open) return;
    this.open = true;
    this._activeIndex = 0;
    this._recent = loadRecent();
    if (!this._loaded) void this._loadSources();
    // Focus the input after the next render tick so the @query resolves.
    requestAnimationFrame(() => this._inputEl?.focus());
  }

  /** Hide the palette and persist the current query (if any). */
  hide(): void {
    if (!this.open) return;
    this.open = false;
    if (this._query.trim()) {
      this._recent = saveRecent(this._query);
    }
  }

  private async _loadSources(): Promise<void> {
    this._loading = true;
    try {
      const [sessionsRes, memoryRes, skillsRes] = await Promise.allSettled([
        api<SessionsResp>('/api/sessions?limit=200'),
        api<MemorySnapshotResp>('/api/memory/snapshot'),
        api<SkillsResp>('/api/skills'),
      ]);

      if (sessionsRes.status === 'fulfilled') {
        this._sessions = (sessionsRes.value.sessions ?? []).map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          preview: s.preview,
        }));
      }

      if (memoryRes.status === 'fulfilled') {
        const mem = memoryRes.value.memory?.entries ?? [];
        const usr = memoryRes.value.user?.entries ?? [];
        this._memories = [...mem, ...usr].map((e) => ({
          key: e.key,
          value: e.value,
          category: e.category,
        }));
      }

      if (skillsRes.status === 'fulfilled') {
        this._skills = (skillsRes.value.skills ?? []).map((s) => ({
          slug: s.slug,
          title: s.title,
          summary: s.summary,
          triggerPhrases: s.triggerPhrases,
        }));
      }
      this._loaded = true;
    } finally {
      this._loading = false;
    }
  }

  private get _grouped(): Record<CommandSource, CommandResult[]> {
    return aggregateResults({
      query: this._query,
      sessions: this._sessions,
      memories: this._memories,
      skills: this._skills,
      actions: HARDCODED_ACTIONS,
      perSource: 50,
    });
  }

  private _activeList(): CommandResult[] {
    return this._grouped[this._activeSource];
  }

  private _onInput = (e: Event) => {
    this._query = (e.target as HTMLInputElement).value;
    this._activeIndex = 0;
    // Auto-pick the first source that actually has results so an empty
    // active tab doesn't render "no results" while another tab matches.
    const grouped = this._grouped;
    if (grouped[this._activeSource].length === 0) {
      const next = SOURCES.find((s) => grouped[s].length > 0);
      if (next) this._activeSource = next;
    }
  };

  private _onKey = (e: KeyboardEvent) => {
    if (!this.open) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const idx = SOURCES.indexOf(this._activeSource);
      const dir = e.shiftKey ? -1 : 1;
      this._activeSource = SOURCES[(idx + dir + SOURCES.length) % SOURCES.length];
      this._activeIndex = 0;
      return;
    }

    const list = this._activeList();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._activeIndex = list.length === 0 ? 0 : (this._activeIndex + 1) % list.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._activeIndex = list.length === 0 ? 0 : (this._activeIndex - 1 + list.length) % list.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = list[this._activeIndex];
      if (item) this._fire(item, e.metaKey || e.ctrlKey);
    }
  };

  private _fire(result: CommandResult, newTab: boolean): void {
    if (this._query.trim()) this._recent = saveRecent(this._query);
    this.dispatchEvent(
      new CustomEvent('crowclaw:cmdk-action', {
        bubbles: true,
        composed: true,
        detail: { result, newTab },
      }),
    );
    this.hide();
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this._onKey);
  }

  render() {
    const grouped = this._grouped;
    const list = grouped[this._activeSource];
    const showRecents = !this._query.trim() && this._activeSource === 'sessions' && this._recent.length > 0;

    return html`
      <div class="overlay ${this.open ? 'on' : ''}" @click=${this._onBackdrop}>
        <div class="panel" @click=${(e: Event) => e.stopPropagation()}>
          <div class="input-wrap">
            <span class="input-icon">⌘K</span>
            <input
              class="input"
              type="text"
              .value=${this._query}
              @input=${this._onInput}
              placeholder="Search sessions, memories, skills, actions..."
              autocomplete="off"
              spellcheck="false"
            />
            <span class="kbd">esc</span>
          </div>

          <div class="tabs" role="tablist">
            ${SOURCES.map(
              (s) => html`
                <button
                  type="button"
                  class="tab ${this._activeSource === s ? 'active' : ''}"
                  role="tab"
                  aria-selected=${this._activeSource === s}
                  @click=${() => { this._activeSource = s; this._activeIndex = 0; }}
                >
                  ${SOURCE_LABEL[s]}<span class="count">${grouped[s].length}</span>
                </button>
              `,
            )}
          </div>

          <div class="list">
            ${this._loading
              ? html`<div class="loading">Loading...</div>`
              : showRecents
                ? this._renderRecents()
                : list.length === 0
                  ? html`<div class="empty">No results</div>`
                  : list.map((r, i) => this._renderRow(r, i === this._activeIndex))}
          </div>

          <div class="footer">
            <span class="grp"><span class="kbd">↑↓</span> navigate</span>
            <span class="grp"><span class="kbd">tab</span> switch source</span>
            <span class="grp"><span class="kbd">↵</span> open</span>
            <span class="grp"><span class="kbd">⌘↵</span> open in new tab</span>
          </div>
        </div>
      </div>
    `;
  }

  private _renderRow(r: CommandResult, isActive: boolean) {
    return html`
      <div
        class="row ${isActive ? 'active' : ''}"
        @mouseenter=${() => { this._activeIndex = this._activeList().indexOf(r); }}
        @click=${(e: MouseEvent) => this._fire(r, e.metaKey || e.ctrlKey)}
      >
        <span class="ic">${SOURCE_ICON[r.source]}</span>
        <span class="body">
          <span class="title">${r.title}</span>
          ${r.subtitle ? html`<span class="crumb">${r.subtitle}</span>` : nothing}
        </span>
      </div>
    `;
  }

  private _renderRecents() {
    return html`
      <div class="empty" style="text-align:left;padding:8px var(--sp-5,20px) 4px;font-size:10px;letter-spacing:0.6px;text-transform:uppercase;">
        Recent
      </div>
      ${this._recent.map(
        (q) => html`
          <div class="row" @click=${() => { this._query = q; this._inputEl.value = q; this._activeIndex = 0; }}>
            <span class="ic">↺</span>
            <span class="body"><span class="title">${q}</span></span>
          </div>
        `,
      )}
    `;
  }

  private _onBackdrop = () => this.hide();
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-command-palette': CrowClawCommandPalette;
  }
}

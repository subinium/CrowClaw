import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * v0.7 (#180) — Live memory pipeline visualization.
 *
 * Renders a collapsible panel of memory events. Each event is one of:
 *   ▼ Captured: "User prefers dark mode"        (single record written)
 *   ▲ Recalled 3: "..." | "..." | "..."         (recall hit list)
 *
 * Wire to the runtime EventBus by listening for `memory:captured` /
 * `memory:recalled` (see packages/runtime-node/src/event-bus.ts) and
 * pushing each into the host-managed array, then setting `.events` on
 * <crowclaw-memory-stream>.
 *
 * The chat-view orchestrator owns mount placement (sidebar) — this
 * component dispatches `crowclaw:memory-row-click` on the document for
 * row interactions so consumers can scroll the Memory tab to the row.
 */
export type MemoryEventType = 'captured' | 'recalled';

export interface MemoryStreamEvent {
  /** Discriminator. */
  kind: MemoryEventType;
  /** Wall-clock timestamp; rendered as a relative tag. */
  timestamp: string;
  sessionId?: string;
  /** Captured: the single record id. Recalled: undefined. */
  memoryId?: string;
  /** Captured: the summary blurb. Recalled: undefined. */
  summary?: string;
  /** Captured: scope ("session", "user", "workspace"). */
  scope?: string;
  /** Captured: tags. */
  tags?: string[];
  /** Recalled: the originating query. */
  query?: string;
  /** Recalled: hit count (mirrors `ids.length`). */
  hits?: number;
  /** Recalled: the matched record ids — used for row-click linking. */
  ids?: string[];
  /** Recalled: short summaries per id. */
  summaries?: string[];
}

@customElement('crowclaw-memory-stream')
export class CrowClawMemoryStream extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .panel {
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
    }

    /* --- Panel header (collapse toggle) --- */
    .panel-header {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      cursor: pointer;
      user-select: none;
      border-bottom: 1px solid transparent;
      transition: background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .panel-header:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
    }

    .panel-header.open {
      border-bottom-color: var(--border, rgba(255, 255, 255, 0.08));
    }

    .chevron {
      width: 12px;
      height: 12px;
      color: var(--text-muted, #48484a);
      transition: transform var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .chevron.open {
      transform: rotate(90deg);
    }

    .panel-title {
      font-size: var(--text-sm, 13px);
      font-weight: 500;
      color: var(--text-primary, #ededef);
      flex: 1;
    }

    .count {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
    }

    /* --- Stream list --- */
    .stream {
      display: none;
      max-height: 320px;
      overflow-y: auto;
    }

    .stream.open {
      display: block;
    }

    .empty {
      padding: var(--sp-4, 16px) var(--sp-3, 12px);
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      text-align: center;
    }

    /* --- Individual event row --- */
    .row {
      display: flex;
      align-items: flex-start;
      gap: var(--sp-2, 8px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      animation: pulse-in var(--duration-slow, 300ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .row:first-child {
      border-top: none;
    }

    /* Capture/recall pulse animation per spec: highlight on insert. */
    @keyframes pulse-in {
      0% {
        background: var(--accent, #5b8def);
        opacity: 0.6;
      }
      40% {
        background: rgba(224, 85, 69, 0.18);
      }
      100% {
        background: transparent;
        opacity: 1;
      }
    }

    .arrow {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-sm, 13px);
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }

    .arrow.captured {
      color: var(--success, #30d158);
    }

    .arrow.recalled {
      color: var(--accent, #5b8def);
    }

    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .label {
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-secondary, #8e8e93);
    }

    .label.captured { color: var(--success, #30d158); }
    .label.recalled { color: var(--accent, #5b8def); }

    .summary {
      font-size: var(--text-sm, 13px);
      color: var(--text-primary, #ededef);
      line-height: 1.4;
      word-break: break-word;
    }

    .recall-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 2px;
    }

    .recall-row {
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: var(--radius-sm, 6px);
      transition: background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .recall-row:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
    }

    .relative-time {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      flex-shrink: 0;
    }
  `;

  /** Stream of memory events, oldest first. The component renders newest-first internally. */
  @property({ type: Array }) events: MemoryStreamEvent[] = [];

  /** Optional title override. Defaults to 'Memory'. */
  @property({ type: String }) heading = 'Memory';

  /** Whether the panel starts open. Defaults to true so the first capture/recall is visible. */
  @property({ type: Boolean, attribute: 'collapsed' }) collapsedDefault = false;

  @state() private _open = true;

  connectedCallback(): void {
    super.connectedCallback();
    this._open = !this.collapsedDefault;
  }

  render() {
    // Reverse for newest-first display without mutating the parent array.
    const reversed = [...this.events].reverse();
    const total = this.events.length;
    const captured = this.events.filter((e) => e.kind === 'captured').length;
    const recalled = total - captured;

    return html`
      <div class="panel">
        <div class="panel-header ${this._open ? 'open' : ''}" @click=${this._toggle}>
          <svg class="chevron ${this._open ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="panel-title">${this.heading}</span>
          <span class="count">${captured} captured · ${recalled} recalled</span>
        </div>
        <div class="stream ${this._open ? 'open' : ''}">
          ${total === 0
            ? html`<div class="empty">No memory activity yet. Captures appear after each turn; recalls appear when the agent uses prior context.</div>`
            : reversed.map((event) => this._renderRow(event))}
        </div>
      </div>
    `;
  }

  private _renderRow(event: MemoryStreamEvent) {
    if (event.kind === 'captured') {
      return html`
        <div class="row">
          <span class="arrow captured" aria-hidden="true">▼</span>
          <div class="body">
            <span class="label captured">Captured${event.scope ? ` · ${event.scope}` : ''}</span>
            <span class="summary">${this._truncate(event.summary ?? '', 200)}</span>
          </div>
          <span class="relative-time">${this._formatRelative(event.timestamp)}</span>
        </div>
      `;
    }
    const ids = event.ids ?? [];
    const summaries = event.summaries ?? [];
    return html`
      <div class="row">
        <span class="arrow recalled" aria-hidden="true">▲</span>
        <div class="body">
          <span class="label recalled">Recalled ${event.hits ?? ids.length}</span>
          ${event.query
            ? html`<span class="summary">${this._truncate(event.query, 120)}</span>`
            : nothing}
          ${ids.length > 0
            ? html`
                <div class="recall-list">
                  ${ids.map((id, i) => html`
                    <span class="recall-row" @click=${() => this._onRecallClick(id)}>
                      · ${this._truncate(summaries[i] ?? id, 100)}
                    </span>
                  `)}
                </div>
              `
            : nothing}
        </div>
        <span class="relative-time">${this._formatRelative(event.timestamp)}</span>
      </div>
    `;
  }

  private _toggle = (): void => {
    this._open = !this._open;
  };

  private _onRecallClick(memoryId: string): void {
    document.dispatchEvent(new CustomEvent('crowclaw:memory-row-click', {
      detail: { memoryId },
      bubbles: true,
      composed: true,
    }));
  }

  private _truncate(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max)}…`;
  }

  /** Render an ISO timestamp as a short relative tag: "2m ago", "1h ago", "3d ago". */
  private _formatRelative(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    if (diff < 0) return 'now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-memory-stream': CrowClawMemoryStream;
  }
}

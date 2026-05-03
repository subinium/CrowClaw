import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * v0.8.0 (#231) — `<crowclaw-reasoning-block>`.
 *
 * Soft-styled, collapsible region that surfaces a single Hermes-style
 * reasoning tag (`plan` / `reasoning` / `reflection` / `thinking` / `think` /
 * `scratchpad` / `inner_monologue` / `execution` / `solution` / `explanation`
 * / `unit_test`). Folded by default — operators expand to inspect the model's
 * internal chain of thought without polluting the regular assistant flow.
 *
 * Rendering rules:
 * - Tag label: title-cased, `_` → space (e.g. `inner_monologue` → `Inner Monologue`).
 * - Header: `<button aria-expanded>` toggles content visibility.
 * - Body: `<div role="region" aria-label="<tag> details">` for assistive tech.
 * - Uses existing CSS tokens (`--surface-1`, `--text-muted`, `--radius-md`,
 *   `--sp-3`) so the component matches the rest of the dashboard chrome.
 *
 * Wire from chat-view: render one `<crowclaw-reasoning-block>` per
 * `ReasoningBlock` on every assistant message, plus a live one fed by
 * SSE `reasoning_start` / `reasoning_delta` / `reasoning_end` events while
 * a turn is streaming.
 */
@customElement('crowclaw-reasoning-block')
export class CrowClawReasoningBlock extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
      margin: var(--sp-2, 8px) 0;
    }

    .wrap {
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
      transition: border-color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .wrap.streaming {
      border-color: rgba(224, 85, 69, 0.25);
    }

    button.toggle {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      width: 100%;
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      background: transparent;
      border: 0;
      cursor: pointer;
      color: var(--text-muted, #8a8a8e);
      font-family: inherit;
      font-size: var(--text-xs, 12px);
      font-weight: 500;
      text-align: left;
      letter-spacing: 0.01em;
      text-transform: uppercase;
    }

    button.toggle:hover {
      color: var(--text-primary, #ededef);
    }

    button.toggle:focus-visible {
      outline: 2px solid var(--accent, #5b8def);
      outline-offset: -2px;
    }

    .chevron {
      width: 10px;
      height: 10px;
      transition: transform var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      flex-shrink: 0;
      color: currentColor;
    }

    .chevron.open {
      transform: rotate(90deg);
    }

    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      font-size: var(--text-xs, 12px);
      color: var(--text-muted, #8a8a8e);
      font-weight: 400;
      text-transform: none;
      letter-spacing: normal;
      flex-shrink: 0;
    }

    .live-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent, #5b8def);
      animation: pulse 1s ease-in-out infinite;
      flex-shrink: 0;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    .body {
      padding: 0 var(--sp-3, 12px) var(--sp-3, 12px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      color: var(--text-secondary, #c0c0c4);
      font-size: var(--text-xs, 12px);
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 320px;
      overflow-y: auto;
    }

    .body.empty {
      color: var(--text-muted, #8a8a8e);
      font-style: italic;
    }
  `;

  /** Reasoning tag (e.g. `plan`, `reasoning`, `reflection`, `thinking`). */
  @property({ type: String }) tag = '';

  /** Inner content. Updates trigger a re-render — used for streaming. */
  @property({ type: String }) content = '';

  /** When true, the block starts collapsed. Default: true. */
  @property({ type: Boolean, attribute: 'collapsed-by-default' }) collapsedByDefault = true;

  /**
   * When true, render a live indicator (pulsing dot) and the streaming
   * border tint. Set this while a `reasoning_start` has fired but the
   * matching `reasoning_end` has not yet arrived.
   */
  @property({ type: Boolean }) streaming = false;

  /** Internal expand/collapse state. Toggled by the header button. */
  @state() private expanded = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.expanded = !this.collapsedByDefault;
  }

  render() {
    const labelText = this._formatTag(this.tag);
    const charCount = this.content?.length ?? 0;
    const ariaLabel = `${this.tag || 'reasoning'} details`;
    return html`
      <div class="wrap ${this.streaming ? 'streaming' : ''}">
        <button
          class="toggle"
          type="button"
          aria-expanded=${this.expanded ? 'true' : 'false'}
          aria-controls="rb-body"
          @click=${this._toggle}
        >
          <svg class="chevron ${this.expanded ? 'open' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2 l4 4 -4 4" />
          </svg>
          <span class="label">${labelText}</span>
          ${this.streaming ? html`<span class="live-pulse" aria-hidden="true"></span>` : nothing}
          ${charCount > 0 ? html`<span class="meta">${charCount} chars</span>` : nothing}
        </button>
        ${this.expanded
          ? html`<div id="rb-body" class="body ${charCount === 0 ? 'empty' : ''}" role="region" aria-label=${ariaLabel}>${charCount === 0 ? '(empty)' : this.content}</div>`
          : nothing}
      </div>
    `;
  }

  private _toggle = () => {
    this.expanded = !this.expanded;
    this.dispatchEvent(
      new CustomEvent('reasoning-toggle', {
        bubbles: true,
        composed: true,
        detail: { tag: this.tag, expanded: this.expanded },
      }),
    );
  };

  /** Title-case the tag, replacing `_` with a space. `inner_monologue` → `Inner Monologue`. */
  private _formatTag(tag: string): string {
    if (!tag) return 'Reasoning';
    return tag
      .replace(/_/g, ' ')
      .split(' ')
      .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : ''))
      .join(' ');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-reasoning-block': CrowClawReasoningBlock;
  }
}

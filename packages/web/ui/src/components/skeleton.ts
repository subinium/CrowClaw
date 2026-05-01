/**
 * Skeleton placeholders (v0.8.1 #246).
 *
 * Three components in one module so they can share a single shimmer
 * keyframe and stylesheet:
 *
 *   - <crowclaw-skeleton-line> — 1em x 100% by default; `width`/`height` props
 *   - <crowclaw-skeleton-card> — card-shaped block with N skeleton lines
 *   - <crowclaw-skeleton-list> — N skeleton lines stacked vertically
 *
 * The shimmer animation respects `prefers-reduced-motion: reduce` — when
 * set, the gradient sits still.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

const SHARED_STYLES = css`
  :host {
    display: block;
    --cc-skel-base: var(--surface-2, var(--glass-bg, rgba(255, 255, 255, 0.04)));
    --cc-skel-hi: var(--surface-1, rgba(255, 255, 255, 0.08));
  }

  .skel {
    position: relative;
    background: var(--cc-skel-base);
    overflow: hidden;
    border-radius: var(--radius-sm, 6px);
  }

  .skel::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--cc-skel-hi) 50%,
      transparent 100%
    );
    animation: cc-skel-shimmer 1.4s ease-in-out infinite;
    pointer-events: none;
  }

  @keyframes cc-skel-shimmer {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  @media (prefers-reduced-motion: reduce) {
    .skel::after { animation: none; transform: translateX(0); opacity: 0.4; }
  }
`;

/* ------------------------------------------------------------------ */
/* Line                                                                */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-skeleton-line')
export class CrowClawSkeletonLine extends LitElement {
  static styles = [
    SHARED_STYLES,
    css`
      .line {
        height: 1em;
        width: 100%;
      }
    `,
  ];

  @property({ type: String })
  width: string | undefined;

  @property({ type: String })
  height: string | undefined;

  render() {
    const style = [
      this.width ? `width:${this.width}` : '',
      this.height ? `height:${this.height}` : '',
    ]
      .filter(Boolean)
      .join(';');
    return html`<div
      class="skel line"
      style=${style}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    ></div>`;
  }
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-skeleton-card')
export class CrowClawSkeletonCard extends LitElement {
  static styles = [
    SHARED_STYLES,
    css`
      .card {
        padding: var(--sp-4, 16px);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: var(--radius-md, 8px);
        background: var(--surface-1, var(--bg-secondary, transparent));
        display: flex;
        flex-direction: column;
        gap: var(--sp-2, 8px);
      }
      .row {
        height: 0.85em;
      }
      .row:first-child {
        height: 1.2em;
        width: 60%;
      }
      .row:last-child {
        width: 40%;
      }
    `,
  ];

  @property({ type: Number })
  lines = 3;

  render() {
    const count = Math.max(1, Math.floor(this.lines));
    const rows = Array.from({ length: count }, (_, i) => i);
    return html`
      <div class="card" role="status" aria-busy="true" aria-label="Loading card">
        ${rows.map(() => html`<div class="skel row"></div>`)}
      </div>
    `;
  }
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-skeleton-list')
export class CrowClawSkeletonList extends LitElement {
  static styles = [
    SHARED_STYLES,
    css`
      .list {
        display: flex;
        flex-direction: column;
        gap: var(--sp-3, 12px);
      }
      .row {
        height: 1em;
      }
      .row:nth-child(2n) { width: 85%; }
      .row:nth-child(3n) { width: 70%; }
    `,
  ];

  @property({ type: Number })
  rows = 3;

  render() {
    const count = Math.max(1, Math.floor(this.rows));
    const arr = Array.from({ length: count }, (_, i) => i);
    return html`
      <div class="list" role="status" aria-busy="true" aria-label="Loading list">
        ${arr.map(() => html`<div class="skel row"></div>`)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-skeleton-line': CrowClawSkeletonLine;
    'crowclaw-skeleton-card': CrowClawSkeletonCard;
    'crowclaw-skeleton-list': CrowClawSkeletonList;
  }
}

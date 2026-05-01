/**
 * `<crowclaw-status-dot>` — small colored indicator dot (v0.8.1 #246).
 *
 * Status: running | ok | warn | error | idle | paused
 * Size:   sm (8px) | md (10px)
 * Pulse:  optional ring-pulse animation; respects `prefers-reduced-motion`.
 *
 * Color comes from existing CSS tokens (`--success`, `--warning`, `--error`,
 * `--text-muted`) so visual changes ride along with the global palette.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type StatusDotStatus = 'running' | 'ok' | 'warn' | 'error' | 'idle' | 'paused';
export type StatusDotSize = 'sm' | 'md';

@customElement('crowclaw-status-dot')
export class CrowClawStatusDot extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
      line-height: 0;
    }

    .dot {
      display: inline-block;
      border-radius: 50%;
      position: relative;
      background: var(--text-muted, #8e8e93);
    }

    .dot.sm { width: 8px; height: 8px; }
    .dot.md { width: 10px; height: 10px; }

    .dot.running { background: var(--accent, #e05545); }
    .dot.ok      { background: var(--success, #30d158); }
    .dot.warn    { background: var(--warn, var(--warning, #ffd60a)); }
    .dot.error   { background: var(--error, #ff453a); }
    .dot.idle    { background: var(--text-muted, #8e8e93); }
    .dot.paused  { background: var(--text-muted, #8e8e93); opacity: 0.55; }

    /* Pulse ring */
    .dot.pulse::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      border: 2px solid currentColor;
      color: inherit;
      opacity: 0;
      animation: cc-dot-pulse 1.6s ease-out infinite;
      pointer-events: none;
    }
    .dot.running.pulse::after { color: var(--accent, #e05545); }
    .dot.ok.pulse::after      { color: var(--success, #30d158); }
    .dot.warn.pulse::after    { color: var(--warn, var(--warning, #ffd60a)); }
    .dot.error.pulse::after   { color: var(--error, #ff453a); }

    @keyframes cc-dot-pulse {
      0%   { transform: scale(0.7); opacity: 0.7; }
      80%  { transform: scale(1.6); opacity: 0; }
      100% { transform: scale(1.6); opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      .dot.pulse::after { animation: none; opacity: 0; }
    }
  `;

  @property({ type: String, reflect: true })
  status: StatusDotStatus = 'idle';

  @property({ type: String, reflect: true })
  size: StatusDotSize = 'sm';

  @property({ type: Boolean, reflect: true })
  pulse = false;

  render() {
    const cls = `dot ${this.size} ${this.status}${this.pulse ? ' pulse' : ''}`;
    const aria = `Status: ${this.status}`;
    return html`<span class=${cls} role="status" aria-label=${aria}></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-status-dot': CrowClawStatusDot;
  }
}

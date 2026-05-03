import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export interface StepEntry {
  tool: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
  result?: string;
}

@customElement('crowclaw-step-feed')
export class CrowClawStepFeed extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .feed {
      display: flex;
      flex-direction: column;
      gap: var(--sp-1, 4px);
    }

    /* --- Step row --- */
    .step {
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      transition: background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .step:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
    }

    .step-header {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      cursor: pointer;
      user-select: none;
    }

    /* --- Status indicators --- */
    .indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .indicator.running {
      background: var(--accent, #5b8def);
      animation: pulse 1.4s ease-in-out infinite;
    }

    .indicator.done {
      background: var(--success, #30d158);
    }

    .indicator.error {
      background: var(--error, #ff453a);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.75); }
    }

    /* --- Tool name --- */
    .tool-name {
      font-size: var(--text-sm, 13px);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      color: var(--text-primary, #ededef);
      font-weight: 500;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* --- Status label --- */
    .status-label {
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .status-label.running { color: var(--accent, #5b8def); }
    .status-label.done { color: var(--success, #30d158); }
    .status-label.error { color: var(--error, #ff453a); }

    /* --- Elapsed time --- */
    .elapsed {
      font-size: var(--text-xs, 11px);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      color: var(--text-secondary, #8e8e93);
      flex-shrink: 0;
    }

    /* --- Expand chevron --- */
    .chevron {
      width: 14px;
      height: 14px;
      color: var(--text-muted, #48484a);
      transition: transform var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      flex-shrink: 0;
    }

    .chevron.open {
      transform: rotate(90deg);
    }

    /* --- Result panel --- */
    .result {
      display: none;
      padding: 0 var(--sp-3, 12px) var(--sp-3, 12px);
    }

    .result.open {
      display: block;
    }

    .result-content {
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      font-size: var(--text-xs, 11px);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      color: var(--text-secondary, #8e8e93);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
    }

    /* --- Running row highlight --- */
    .step.running {
      border-color: rgba(224, 85, 69, 0.2);
    }
  `;

  @property({ type: Array }) steps: StepEntry[] = [];

  @state() private _expandedSet: Set<number> = new Set();

  render() {
    return html`
      <div class="feed">
        ${this.steps.map((step, i) => this._renderStep(step, i))}
      </div>
    `;
  }

  private _renderStep(step: StepEntry, index: number) {
    const expanded = this._expandedSet.has(index);
    const hasResult = step.result != null && step.result !== '';

    return html`
      <div class="step ${step.status === 'running' ? 'running' : ''}">
        <div class="step-header" @click=${() => this._toggleExpand(index, hasResult)}>
          <div class="indicator ${step.status}"></div>
          <span class="tool-name">${step.tool}</span>
          <span class="status-label ${step.status}">${step.status}</span>
          ${step.elapsed != null
            ? html`<span class="elapsed">${step.elapsed}ms</span>`
            : nothing}
          ${hasResult
            ? html`
                <svg class="chevron ${expanded ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
              `
            : nothing}
        </div>
        ${hasResult
          ? html`
              <div class="result ${expanded ? 'open' : ''}">
                <div class="result-content">${step.result}</div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _toggleExpand(index: number, hasResult: boolean) {
    if (!hasResult) return;
    const next = new Set(this._expandedSet);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    this._expandedSet = next;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-step-feed': CrowClawStepFeed;
  }
}

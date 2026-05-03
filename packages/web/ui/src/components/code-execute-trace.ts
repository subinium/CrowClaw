import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * v0.8.0 (#234) — Code-execute trace.
 *
 * Renders a single `code.execute` invocation as a collapsed one-liner:
 *   ▶ code.execute (3 tools, 1.2s) ✓
 *
 * Click expands to show:
 *   - Source code (with copy button) using the same monospace pre styles as
 *     the regular tool-call trace.
 *   - Per-tool sub-trace: name, args, result, duration, status dot. One row
 *     per host-registry call the sandbox made (in order).
 *   - stdout / stderr panes (truncated at 500 chars per pane, with "Show full"
 *     dispatching the same `crowclaw:trace-show-full` event the regular trace
 *     uses).
 *
 * The host orchestrator (chat-view) owns where this renders. Mount it
 * alongside `<crowclaw-tool-call-trace>` whenever the message's tool name is
 * `code.execute`; pass the parsed payload via the `.data` property.
 */

export type CodeExecuteStatus = 'running' | 'ok' | 'error';

export interface CodeExecuteToolCall {
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface CodeExecuteTraceData {
  language: 'js' | 'ts' | 'python';
  /** Optional pre-computed source hash; we render only the prefix. */
  codeHash?: string;
  /** The user code that was executed. Optional — falls back to `[source unavailable]`. */
  code?: string;
  stdout: string;
  stderr: string;
  toolCalls: CodeExecuteToolCall[];
  durationMs: number;
  ok: boolean;
  /** Top-level error (e.g. `Sandbox timeout exceeded`). */
  error?: string;
  /** Optional status override. Defaults to derive from `ok`. */
  status?: CodeExecuteStatus;
}

const INLINE_OUTPUT_LIMIT = 500;

@customElement('crowclaw-code-execute-trace')
export class CrowClawCodeExecuteTrace extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .trace {
      background: var(--surface-1, var(--bg-card, rgba(255, 255, 255, 0.04)));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      transition: border-color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      overflow: hidden;
    }

    .trace.error {
      border-color: var(--error, #ff453a);
      box-shadow: inset 2px 0 0 0 var(--error, #ff453a);
    }

    .trace.running {
      border-color: rgba(224, 85, 69, 0.25);
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      cursor: pointer;
      user-select: none;
    }

    .header:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
    }

    .chevron {
      width: 12px;
      height: 12px;
      color: var(--text-muted, #48484a);
      transition: transform var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      flex-shrink: 0;
    }

    .chevron.open { transform: rotate(90deg); }

    .label {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-sm, 13px);
      font-weight: 500;
      color: var(--text-primary, #ededef);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, var(--text-muted, #8e8e93));
      flex-shrink: 0;
    }

    .status {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .status.running {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent, #5b8def);
      animation: pulse 1.4s ease-in-out infinite;
    }

    .status.ok { color: var(--success, #30d158); font-weight: 600; }
    .status.error { color: var(--error, #ff453a); font-weight: 600; }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.75); }
    }

    .body {
      display: none;
      padding: 0 var(--sp-3, 12px) var(--sp-3, 12px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .body.open { display: block; }

    .section { margin-top: var(--sp-3, 12px); }

    .section-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2, 8px);
      margin-bottom: var(--sp-1, 4px);
    }

    .section-label {
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted, #48484a);
    }

    pre {
      margin: 0;
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
    }

    .sub-trace {
      display: flex;
      flex-direction: column;
      gap: var(--sp-1, 4px);
    }

    .sub-call {
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      display: flex;
      flex-direction: column;
      gap: var(--sp-1, 4px);
    }

    .sub-head {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
    }

    .sub-name {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-primary, #ededef);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sub-duration {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
    }

    .sub-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sub-dot.ok { background: var(--success, #30d158); }
    .sub-dot.error { background: var(--error, #ff453a); }

    .sub-detail {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
    }

    button.action {
      font-family: var(--font-sans, inherit);
      font-size: var(--text-xs, 11px);
      padding: var(--sp-1, 4px) var(--sp-3, 12px);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      color: var(--text-secondary, #8e8e93);
      cursor: pointer;
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    button.action:hover {
      color: var(--text-primary, #ededef);
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
    }

    .error-banner {
      margin-top: var(--sp-2, 8px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border: 1px solid var(--error, #ff453a);
      border-radius: var(--radius-sm, 6px);
      color: var(--error, #ff453a);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
    }
  `;

  /** Trace payload for the single code.execute invocation. */
  @property({ type: Object }) data: CodeExecuteTraceData | null = null;

  /** Whether the panel starts expanded. */
  @property({ type: Boolean, attribute: 'expanded' }) expanded = false;

  @state() private _expanded = false;

  connectedCallback(): void {
    super.connectedCallback();
    this._expanded = this.expanded;
  }

  render() {
    const data = this.data;
    if (!data) return nothing;

    const status: CodeExecuteStatus =
      data.status ?? (data.ok ? 'ok' : 'error');
    const duration = this._formatDuration(data.durationMs);
    const toolCount = data.toolCalls?.length ?? 0;

    return html`
      <div class="trace ${status}">
        <div class="header" @click=${this._toggle}>
          <svg class="chevron ${this._expanded ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="label">code.execute</span>
          <span class="summary">${toolCount} tool${toolCount === 1 ? '' : 's'}, ${duration}</span>
          ${this._renderStatusIndicator(status)}
        </div>
        <div class="body ${this._expanded ? 'open' : ''}">
          ${data.error ? html`<div class="error-banner">${data.error}</div>` : nothing}

          <div class="section">
            <div class="section-row">
              <span class="section-label">Source (${data.language}${data.codeHash ? ` · ${data.codeHash.slice(0, 8)}` : ''})</span>
              ${data.code
                ? html`<button class="action" @click=${this._copyCode}>Copy</button>`
                : nothing}
            </div>
            <pre>${data.code ?? '[source unavailable]'}</pre>
          </div>

          ${toolCount > 0
            ? html`
                <div class="section">
                  <div class="section-label">Sub-tool calls</div>
                  <div class="sub-trace">
                    ${data.toolCalls.map((tc) => this._renderSubCall(tc))}
                  </div>
                </div>
              `
            : nothing}

          ${data.stdout
            ? html`
                <div class="section">
                  <div class="section-row">
                    <span class="section-label">stdout</span>
                    ${data.stdout.length > INLINE_OUTPUT_LIMIT
                      ? html`<button class="action" @click=${() => this._showFull('stdout', data.stdout)}>Show full</button>`
                      : nothing}
                  </div>
                  <pre>${this._truncate(data.stdout)}</pre>
                </div>
              `
            : nothing}

          ${data.stderr
            ? html`
                <div class="section">
                  <div class="section-row">
                    <span class="section-label">stderr</span>
                    ${data.stderr.length > INLINE_OUTPUT_LIMIT
                      ? html`<button class="action" @click=${() => this._showFull('stderr', data.stderr)}>Show full</button>`
                      : nothing}
                  </div>
                  <pre>${this._truncate(data.stderr)}</pre>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderSubCall(tc: CodeExecuteToolCall) {
    const dotCls = tc.ok ? 'ok' : 'error';
    const detail = tc.error
      ? `error: ${tc.error}`
      : tc.result !== undefined
        ? this._stringify(tc.result)
        : '';
    return html`
      <div class="sub-call">
        <div class="sub-head">
          <span class="sub-dot ${dotCls}" aria-hidden="true"></span>
          <span class="sub-name">${tc.name}</span>
          <span class="sub-duration">${this._formatDuration(tc.durationMs)}</span>
        </div>
        ${tc.args !== undefined
          ? html`<div class="sub-detail">args: ${this._stringify(tc.args)}</div>`
          : nothing}
        ${detail
          ? html`<div class="sub-detail">${this._truncate(detail)}</div>`
          : nothing}
      </div>
    `;
  }

  private _renderStatusIndicator(status: CodeExecuteStatus) {
    if (status === 'running') {
      return html`<span class="status running" aria-label="running"></span>`;
    }
    if (status === 'ok') {
      return html`<span class="status ok" aria-label="success">&check;</span>`;
    }
    return html`<span class="status error" aria-label="error">&times;</span>`;
  }

  private _toggle = (): void => {
    this._expanded = !this._expanded;
  };

  private _formatDuration(ms?: number): string {
    if (typeof ms !== 'number' || ms < 0) return '--';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private _stringify(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  private _truncate(text: string): string {
    if (text.length <= INLINE_OUTPUT_LIMIT) return text;
    return `${text.slice(0, INLINE_OUTPUT_LIMIT)}\n…[${text.length - INLINE_OUTPUT_LIMIT} more chars]`;
  }

  private _copyCode = (event: Event): void => {
    event.stopPropagation();
    const code = this.data?.code;
    if (!code) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code).catch(() => {
        // Best-effort
      });
    }
  };

  private _showFull(kind: 'stdout' | 'stderr', text: string): void {
    document.dispatchEvent(new CustomEvent('crowclaw:trace-show-full', {
      detail: { kind: `code.execute:${kind}`, text },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-code-execute-trace': CrowClawCodeExecuteTrace;
  }
}

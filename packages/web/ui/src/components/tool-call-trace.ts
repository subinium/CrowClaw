import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * v0.7 (#179) — Real-time tool execution trace.
 *
 * Renders a single tool invocation as a collapsed one-liner:
 *   ▶ web.fetch (1.2s) ✓
 * Click expands to show pretty-printed args, truncated output (first 500
 * chars), a "Show full" link that dispatches `trace-show-full` for the host
 * to mount a modal, and a "Copy as cURL" button when the tool name + args
 * shape match an HTTP-shaped tool (web.fetch, web.search, etc.).
 *
 * The chat-view orchestrator owns inline placement between assistant
 * messages — this component just emits DOM events on the document so any
 * consumer can subscribe without the component knowing about its parent.
 *
 * Wire to the runtime EventBus by listening for `tool:start` /
 * `tool:complete` (see packages/runtime-node/src/event-bus.ts) and feeding
 * each call into a host-managed array, then setting `.entry` on the
 * matching <crowclaw-tool-call-trace>.
 */
export type ToolTraceStatus = 'running' | 'ok' | 'error';

export interface ToolTraceEntry {
  callId: string;
  toolName: string;
  status: ToolTraceStatus;
  args?: Record<string, unknown>;
  output?: string;
  outputLength?: number;
  durationMs?: number;
  startedAt?: string;
  /** Audit log id for the matching SecurityAuditLog entry (failed calls). */
  auditId?: string;
  errorMessage?: string;
}

const HTTP_SHAPED_TOOLS = new Set([
  'web.fetch',
  'web.extractMetadata',
  'web.extractLinks',
  'web.extractText',
  'web.search',
  'web.crawl',
]);

/** Truncation threshold for the inline output preview (per spec). */
const INLINE_OUTPUT_LIMIT = 500;

@customElement('crowclaw-tool-call-trace')
export class CrowClawToolCallTrace extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .trace {
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
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

    /* --- Header (always visible) --- */
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

    .chevron.open {
      transform: rotate(90deg);
    }

    .tool-name {
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

    .duration {
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
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
      background: var(--accent, #e05545);
      animation: pulse 1.4s ease-in-out infinite;
    }

    .status.ok {
      color: var(--success, #30d158);
      font-weight: 600;
    }

    .status.error {
      color: var(--error, #ff453a);
      font-weight: 600;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.75); }
    }

    /* --- Body (expanded) --- */
    .body {
      display: none;
      padding: 0 var(--sp-3, 12px) var(--sp-3, 12px);
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }

    .body.open {
      display: block;
    }

    .section {
      margin-top: var(--sp-3, 12px);
    }

    .section-label {
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted, #48484a);
      margin-bottom: var(--sp-1, 4px);
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

    /* --- Action buttons --- */
    .actions {
      display: flex;
      gap: var(--sp-2, 8px);
      margin-top: var(--sp-3, 12px);
      flex-wrap: wrap;
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

    button.action.why {
      color: var(--error, #ff453a);
      border-color: rgba(255, 69, 58, 0.4);
    }
  `;

  /** The single trace entry to render. */
  @property({ type: Object }) entry: ToolTraceEntry | null = null;

  /** Whether the panel starts expanded. Defaults to false (collapsed). */
  @property({ type: Boolean, attribute: 'expanded' }) expanded = false;

  @state() private _expanded = false;

  connectedCallback(): void {
    super.connectedCallback();
    this._expanded = this.expanded;
  }

  render() {
    const entry = this.entry;
    if (!entry) return nothing;

    const statusClass = entry.status;
    const isHttpShaped = HTTP_SHAPED_TOOLS.has(entry.toolName);
    const formattedDuration = this._formatDuration(entry.durationMs);
    const indicator = this._renderStatusIndicator(entry.status);

    return html`
      <div class="trace ${statusClass}">
        <div class="header" @click=${this._toggle}>
          <svg class="chevron ${this._expanded ? 'open' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="tool-name">${entry.toolName}</span>
          ${formattedDuration
            ? html`<span class="duration">${formattedDuration}</span>`
            : nothing}
          ${indicator}
        </div>
        <div class="body ${this._expanded ? 'open' : ''}">
          ${entry.args
            ? html`
                <div class="section">
                  <div class="section-label">Arguments</div>
                  <pre>${this._formatJson(entry.args)}</pre>
                </div>
              `
            : nothing}
          ${entry.output
            ? html`
                <div class="section">
                  <div class="section-label">Output</div>
                  <pre>${this._truncateOutput(entry.output)}</pre>
                </div>
              `
            : nothing}
          <div class="actions">
            ${entry.output && entry.output.length > INLINE_OUTPUT_LIMIT
              ? html`<button class="action" @click=${this._showFull}>Show full</button>`
              : nothing}
            ${isHttpShaped
              ? html`<button class="action" @click=${this._copyAsCurl}>Copy as cURL</button>`
              : nothing}
            ${entry.status === 'error'
              ? html`<button class="action why" @click=${this._openAudit}>Why?</button>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private _renderStatusIndicator(status: ToolTraceStatus) {
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

  private _formatDuration(ms?: number): string | null {
    if (typeof ms !== 'number' || ms < 0) return null;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  private _formatJson(value: Record<string, unknown>): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private _truncateOutput(output: string): string {
    if (output.length <= INLINE_OUTPUT_LIMIT) return output;
    return `${output.slice(0, INLINE_OUTPUT_LIMIT)}\n…[${output.length - INLINE_OUTPUT_LIMIT} more chars]`;
  }

  private _showFull = (event: Event): void => {
    event.stopPropagation();
    if (!this.entry) return;
    // Bubble through document so the orchestrator can catch it without
    // needing a direct ref to this component.
    document.dispatchEvent(new CustomEvent('crowclaw:trace-show-full', {
      detail: { entry: this.entry },
      bubbles: true,
      composed: true,
    }));
  };

  private _copyAsCurl = (event: Event): void => {
    event.stopPropagation();
    if (!this.entry) return;
    const curl = this._buildCurl(this.entry);
    if (!curl) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(curl).catch(() => {
        // Best-effort — host can listen for the event and retry/fall back.
      });
    }
    document.dispatchEvent(new CustomEvent('crowclaw:trace-copy-curl', {
      detail: { entry: this.entry, curl },
      bubbles: true,
      composed: true,
    }));
  };

  private _openAudit = (event: Event): void => {
    event.stopPropagation();
    if (!this.entry) return;
    document.dispatchEvent(new CustomEvent('crowclaw:trace-open-audit', {
      detail: { entry: this.entry, auditId: this.entry.auditId },
      bubbles: true,
      composed: true,
    }));
  };

  private _buildCurl(entry: ToolTraceEntry): string | null {
    const args = entry.args ?? {};
    const url = typeof args.url === 'string' ? args.url : null;
    if (!url) return null;
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
    const headers = (args.headers && typeof args.headers === 'object')
      ? args.headers as Record<string, string>
      : {};
    const body = args.body;

    const parts = [`curl -X ${method}`];
    for (const [key, value] of Object.entries(headers)) {
      // Single-quote escape: replace ' with '\'' so the shell sees a literal
      // single quote rather than terminating the quoted string.
      const safe = String(value).replace(/'/g, "'\\''");
      parts.push(`-H '${key}: ${safe}'`);
    }
    if (body !== undefined && body !== null) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const safeBody = bodyStr.replace(/'/g, "'\\''");
      parts.push(`-d '${safeBody}'`);
    }
    parts.push(`'${url.replace(/'/g, "'\\''")}'`);
    return parts.join(' ');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-tool-call-trace': CrowClawToolCallTrace;
  }
}

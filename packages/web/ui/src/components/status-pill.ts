/**
 * <crowclaw-status-pill>
 *
 * Issue #177 — header-level connection status indicator.
 *
 * Aggregates four sub-systems into a single red/yellow/green pill so
 * operators can tell whether the runtime is healthy at a glance:
 *
 *   - transport (WS / SSE fallback / disconnected)
 *   - provider  (configured + reachable + last-call OK)
 *   - scheduler (running / paused / errored)
 *   - mcp       (all connected / N degraded / none)
 *
 * The pill polls `/api/diagnostics` every 30s and also reacts to live
 * EventBus events (`session:*`, `gateway:*`, `job:*`) re-dispatched on the
 * `window` as `crowclaw-event` CustomEvents by the orchestrator (app.ts).
 * This decouples the pill from the WebSocket client lifecycle owned by
 * `app.ts` — the orchestrator just bridges WS frames to window events.
 *
 * Click opens a popover with per-system details and three quick-action
 * buttons. Each button dispatches a bubbling/composed CustomEvent that
 * the orchestrator wires up:
 *
 *   - `crowclaw-action-reconnect-ws`     → re-run wsClient.reconnect()
 *   - `crowclaw-action-test-provider`    → POST /api/provider/test
 *   - `crowclaw-action-resume-scheduler` → POST /api/scheduler/start
 *
 * The component does NOT call any of those endpoints itself — it stays a
 * pure presentation + aggregation surface so app.ts can route them
 * through whatever auth headers / toast / refresh logic the app already
 * has.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// ---------------------------------------------------------------------------
// Public types — exported so test code (and the orchestrator) can rely on
// the same shapes the runtime emits from /api/diagnostics.
// ---------------------------------------------------------------------------

export type StatusColor = 'green' | 'yellow' | 'red' | 'gray';

export interface DiagnosticsResponse {
  ok?: boolean;
  transport?: {
    ws?: boolean;
    sse?: boolean;
  };
  provider?: {
    configured?: boolean;
    reachable?: boolean;
    lastCallOk?: boolean | null;
  };
  scheduler?: {
    running?: boolean;
    errored?: boolean;
  };
  mcp?: {
    total?: number;
    connected?: number;
    degraded?: number;
  };
}

export interface SubStatus {
  color: StatusColor;
  label: string;
  detail: string;
}

export interface AggregateStatus {
  color: StatusColor;
  transport: SubStatus;
  provider: SubStatus;
  scheduler: SubStatus;
  mcp: SubStatus;
}

// ---------------------------------------------------------------------------
// Pure aggregation helpers — exported for unit tests.
// ---------------------------------------------------------------------------

/**
 * Reduce a diagnostics payload into the four sub-statuses + an overall
 * pill color.
 *
 * Color rule (per spec):
 *   - any sub-check red    → pill red
 *   - any sub-check yellow → pill yellow (when no red present)
 *   - all green            → pill green
 *   - everything gray/unknown still yields green so the pill doesn't lie
 *     about a healthy runtime that just hasn't configured a provider.
 *
 * `gray` is treated as "not applicable / not configured" and is never
 * promoted to yellow or red on its own.
 */
export const aggregateStatus = (diag: DiagnosticsResponse | null): AggregateStatus => {
  // Transport: WS green > SSE-only yellow > disconnected red.
  const ws = Boolean(diag?.transport?.ws);
  const sse = Boolean(diag?.transport?.sse);
  let transport: SubStatus;
  if (ws) {
    transport = { color: 'green', label: 'WebSocket', detail: 'Realtime channel connected' };
  } else if (sse) {
    transport = { color: 'yellow', label: 'SSE fallback', detail: 'WebSocket unavailable, using server-sent events' };
  } else {
    transport = { color: 'red', label: 'Disconnected', detail: 'No realtime channel available' };
  }

  // Provider: configured + reachable + lastCallOk. `lastCallOk: null`
  // means we have no signal yet, so we only flip yellow when reachable
  // is false and red when an explicit failure is recorded.
  const p = diag?.provider;
  let provider: SubStatus;
  if (!p?.configured) {
    provider = { color: 'gray', label: 'Not configured', detail: 'No LLM provider wired' };
  } else if (p.lastCallOk === false) {
    provider = { color: 'red', label: 'Provider error', detail: 'Last provider call failed' };
  } else if (!p.reachable) {
    provider = { color: 'yellow', label: 'Provider unreachable', detail: 'Configured but not currently reachable' };
  } else {
    provider = { color: 'green', label: 'Provider OK', detail: 'Configured and reachable' };
  }

  // Scheduler: errored → red, !running → yellow (paused), running → green.
  const s = diag?.scheduler;
  let scheduler: SubStatus;
  if (s?.errored) {
    scheduler = { color: 'red', label: 'Scheduler errored', detail: 'Last tick failed — see /api/scheduler/status' };
  } else if (s?.running) {
    scheduler = { color: 'green', label: 'Scheduler running', detail: 'Autonomous ticks active' };
  } else {
    // Treat a stopped scheduler as yellow ("paused"), not red — it's a
    // valid configuration when no jobs are registered.
    scheduler = { color: 'yellow', label: 'Scheduler paused', detail: 'Autonomous ticks not running' };
  }

  // MCP: 0 servers → gray, all connected → green, any degraded → yellow.
  // We never mark MCP red — a degraded MCP is recoverable and shouldn't
  // crater the whole header pill.
  const m = diag?.mcp;
  const total = m?.total ?? 0;
  const degraded = m?.degraded ?? 0;
  const connected = m?.connected ?? Math.max(0, total - degraded);
  let mcp: SubStatus;
  if (total === 0) {
    mcp = { color: 'gray', label: 'No MCP servers', detail: 'No MCP servers connected' };
  } else if (degraded > 0) {
    mcp = {
      color: 'yellow',
      label: `${connected}/${total} MCP OK`,
      detail: `${degraded} of ${total} MCP server(s) degraded`,
    };
  } else {
    mcp = {
      color: 'green',
      label: `${total} MCP OK`,
      detail: `All ${total} MCP server(s) connected`,
    };
  }

  // Roll up. Gray never wins — only green/yellow/red contribute to the
  // overall color, otherwise a brand-new runtime with nothing configured
  // would render red and confuse first-run users.
  const colors = [transport.color, provider.color, scheduler.color, mcp.color];
  let overall: StatusColor;
  if (colors.includes('red')) {
    overall = 'red';
  } else if (colors.includes('yellow')) {
    overall = 'yellow';
  } else {
    overall = 'green';
  }

  return { color: overall, transport, provider, scheduler, mcp };
};

// ---------------------------------------------------------------------------
// Custom event names — exported so app.ts wires the same strings.
// ---------------------------------------------------------------------------

export const STATUS_PILL_ACTIONS = {
  reconnectWs: 'crowclaw-action-reconnect-ws',
  testProvider: 'crowclaw-action-test-provider',
  resumeScheduler: 'crowclaw-action-resume-scheduler',
} as const;

/**
 * Window-level event the orchestrator dispatches when a relevant WS frame
 * arrives. The pill listens for this and triggers an immediate
 * /api/diagnostics refresh instead of waiting for the next 30s poll.
 */
export const STATUS_PILL_REFRESH_EVENT = 'crowclaw-status-refresh' as const;

/**
 * Event bridge the orchestrator should dispatch on `window` whenever a
 * `session:*`, `gateway:*` or `job:*` EventBus event arrives over WS/SSE.
 * The pill triggers a refresh on these without inspecting the payload —
 * fine-grained per-event diffing is left to app.ts.
 */
export const STATUS_PILL_EVENTBUS_BRIDGE_EVENT = 'crowclaw-event' as const;

const POLL_INTERVAL_MS = 30_000;
const RELEVANT_EVENT_PREFIXES = ['session:', 'gateway:', 'job:'];

@customElement('crowclaw-status-pill')
export class CrowClawStatusPill extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      cursor: pointer;
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      user-select: none;
      transition: background var(--duration-fast, 120ms) ease, border-color var(--duration-fast, 120ms) ease;
    }

    .pill:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
    }

    .pill[aria-expanded='true'] {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--text-muted, #48484a);
    }

    .dot.green { background: var(--success, #30d158); box-shadow: 0 0 6px rgba(48, 209, 88, 0.4); }
    .dot.yellow { background: var(--warning, #ffd60a); box-shadow: 0 0 6px rgba(255, 214, 10, 0.45); }
    .dot.red { background: var(--error, #ff453a); box-shadow: 0 0 6px rgba(255, 69, 58, 0.45); }
    .dot.gray { background: var(--text-muted, #48484a); }

    .label {
      font-weight: 500;
      letter-spacing: 0.01em;
    }

    /* ---- Popover ---- */
    .popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      min-width: 280px;
      background: var(--bg-secondary, #13131a);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-md, 8px);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      padding: 12px;
      z-index: 500;
      display: none;
      flex-direction: column;
      gap: 8px;
    }

    .popover[data-open='true'] {
      display: flex;
    }

    .row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--glass-border, rgba(255, 255, 255, 0.06));
      font-size: var(--text-xs, 11px);
    }

    .row:last-of-type {
      border-bottom: none;
    }

    .row-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 4px;
    }

    .row-dot.green { background: var(--success, #30d158); }
    .row-dot.yellow { background: var(--warning, #ffd60a); }
    .row-dot.red { background: var(--error, #ff453a); }
    .row-dot.gray { background: var(--text-muted, #48484a); }

    .row-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .row-label {
      font-weight: 600;
      color: var(--text-primary, #ededef);
    }

    .row-detail {
      color: var(--text-secondary, #8e8e93);
      line-height: 1.35;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-top: 8px;
      border-top: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      font-size: var(--text-xs, 11px);
      font-family: inherit;
      color: var(--text-primary, #ededef);
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      cursor: pointer;
      transition: background var(--duration-fast, 120ms) ease;
    }

    .action-btn:hover {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
    }

    .timestamp {
      font-size: 10px;
      color: var(--text-muted, #48484a);
      font-family: var(--font-mono, 'SF Mono', 'JetBrains Mono', monospace);
      text-align: right;
      padding-top: 4px;
    }
  `;

  /**
   * Last diagnostics payload. Public so tests / the orchestrator can
   * seed it directly without waiting for fetch.
   */
  @state()
  diagnostics: DiagnosticsResponse | null = null;

  @state()
  private _open = false;

  @state()
  private _lastUpdatedAt: string | null = null;

  /** True when a fetch is currently in flight — prevents request stacking. */
  private _fetching = false;

  private _pollHandle: ReturnType<typeof setInterval> | null = null;

  // Bound listeners (need stable references for add/removeEventListener).
  private readonly _onWindowEvent = (e: Event): void => {
    const detail = (e as CustomEvent<{ type?: string }>).detail;
    const type = detail?.type;
    if (typeof type === 'string' && RELEVANT_EVENT_PREFIXES.some((p) => type.startsWith(p))) {
      void this.refresh();
    }
  };

  private readonly _onWindowRefresh = (): void => {
    void this.refresh();
  };

  private readonly _onDocumentClick = (e: Event): void => {
    if (!this._open) return;
    const path = e.composedPath();
    if (!path.includes(this)) {
      this._open = false;
    }
  };

  connectedCallback(): void {
    super.connectedCallback();

    // Kick off an initial fetch — fire-and-forget so connection time
    // isn't gated on the network round-trip.
    void this.refresh();

    this._pollHandle = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);

    if (typeof window !== 'undefined') {
      window.addEventListener(STATUS_PILL_EVENTBUS_BRIDGE_EVENT, this._onWindowEvent as EventListener);
      window.addEventListener(STATUS_PILL_REFRESH_EVENT, this._onWindowRefresh as EventListener);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('click', this._onDocumentClick, true);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._pollHandle !== null) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener(STATUS_PILL_EVENTBUS_BRIDGE_EVENT, this._onWindowEvent as EventListener);
      window.removeEventListener(STATUS_PILL_REFRESH_EVENT, this._onWindowRefresh as EventListener);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', this._onDocumentClick, true);
    }
  }

  /**
   * Force an immediate /api/diagnostics fetch. Public so app.ts and tests
   * can drive it manually.
   */
  async refresh(): Promise<void> {
    if (this._fetching) return;
    this._fetching = true;
    try {
      const res = await fetch('/api/diagnostics', {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        // Non-2xx — treat the same as an exception path so the pill
        // surfaces "disconnected" instead of stale data.
        this.diagnostics = null;
      } else {
        const data = (await res.json()) as DiagnosticsResponse;
        this.diagnostics = data;
      }
      this._lastUpdatedAt = new Date().toISOString();
    } catch {
      // Network error — clear so the pill shows red.
      this.diagnostics = null;
      this._lastUpdatedAt = new Date().toISOString();
    } finally {
      this._fetching = false;
    }
  }

  private _toggle(): void {
    this._open = !this._open;
  }

  private _emit(type: string): void {
    this.dispatchEvent(
      new CustomEvent(type, {
        bubbles: true,
        composed: true,
        detail: { source: 'crowclaw-status-pill' },
      }),
    );
    // Optimistic refresh after an action — the route may take a tick to
    // reflect new state, so wait one second then re-poll. The next 30s
    // tick will catch up either way.
    setTimeout(() => void this.refresh(), 1_000);
  }

  render() {
    const status = aggregateStatus(this.diagnostics);

    return html`
      <button
        class="pill"
        type="button"
        aria-expanded=${this._open ? 'true' : 'false'}
        aria-haspopup="dialog"
        aria-label=${`Connection status: ${status.color}`}
        @click=${this._toggle}
      >
        <span class="dot ${status.color}"></span>
        <span class="label">${this._summaryLabel(status)}</span>
      </button>

      <div class="popover" data-open=${this._open ? 'true' : 'false'} role="dialog">
        ${this._renderRow(status.transport)}
        ${this._renderRow(status.provider)}
        ${this._renderRow(status.scheduler)}
        ${this._renderRow(status.mcp)}

        <div class="actions">
          <button class="action-btn" type="button" @click=${() => this._emit(STATUS_PILL_ACTIONS.reconnectWs)}>
            Reconnect WS
          </button>
          <button class="action-btn" type="button" @click=${() => this._emit(STATUS_PILL_ACTIONS.testProvider)}>
            Test provider
          </button>
          <button class="action-btn" type="button" @click=${() => this._emit(STATUS_PILL_ACTIONS.resumeScheduler)}>
            Resume scheduler
          </button>
        </div>

        ${this._lastUpdatedAt
          ? html`<div class="timestamp">Updated ${this._formatTimestamp(this._lastUpdatedAt)}</div>`
          : nothing}
      </div>
    `;
  }

  private _renderRow(s: SubStatus) {
    return html`
      <div class="row">
        <span class="row-dot ${s.color}"></span>
        <div class="row-body">
          <span class="row-label">${s.label}</span>
          <span class="row-detail">${s.detail}</span>
        </div>
      </div>
    `;
  }

  private _summaryLabel(status: AggregateStatus): string {
    switch (status.color) {
      case 'green':
        return 'Healthy';
      case 'yellow':
        return 'Degraded';
      case 'red':
        return 'Issue';
      default:
        return 'Status';
    }
  }

  private _formatTimestamp(iso: string): string {
    try {
      const d = new Date(iso);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    } catch {
      return iso;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-status-pill': CrowClawStatusPill;
  }
}

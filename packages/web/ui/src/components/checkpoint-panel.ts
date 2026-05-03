/**
 * Checkpoint panel — slides in from the right of the chat surface to manage
 * session checkpoints. Surfaces three operations exposed by the runtime:
 *
 *   - POST /api/sessions/:id/checkpoint  (manual save with optional label)
 *   - POST /api/sessions/:id/restore     (rewinds the session to a checkpoint)
 *   - POST /api/sessions/:id/replay      (clones the checkpoint into a new
 *                                         replay session for A/B comparison)
 *
 * Issue #195 (v0.7 sweep): the storage + route layer existed, but the
 * dashboard had no UI — checkpoints were curl-only and 'undo for agent
 * runs' was effectively undocumented. This panel makes them first-class.
 *
 * Architectural notes:
 *   - Restore is gated by an inline 'are you sure' affordance instead of
 *     a separate dialog — the runtime returns enough info (messageCount,
 *     restoredIteration) for the parent view to render a structured diff
 *     in the chat stream after the POST resolves, so the panel itself
 *     stays single-step.
 *   - Replay opens the new session by emitting `replay-opened` with the
 *     new sessionId. The chat-view selects it and shows a toast.
 *   - The list reloads on `session:compacted` events because compaction
 *     rewrites message ids that older checkpoints reference; the parent
 *     view forwards that signal via the `refresh()` method.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api.js';
import { showToast } from './toast.js';

export interface CheckpointInfo {
  id: string;
  label?: string;
  trigger?: string;
  createdAt: string;
  iteration?: number;
  messageCount?: number;
}

interface CheckpointListResponse {
  checkpoints: CheckpointInfo[];
}

interface SaveResponse {
  ok: boolean;
  checkpoint: CheckpointInfo;
}

interface RestoreResponse {
  ok: boolean;
  restoredTo: string;
  messageCount?: number;
  restoredIteration?: number;
}

interface ReplayResponse {
  ok: boolean;
  sessionId: string;
  messageCount?: number;
}

const timeAgo = (date: string): string => {
  if (!date) return '--';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

@customElement('crowclaw-checkpoint-panel')
export class CrowClawCheckpointPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .panel {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 320px;
      background: var(--bg-secondary, #13131a);
      border-left: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.5));
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      z-index: 50;
    }

    :host([open]) .panel {
      transform: translateX(0);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--sp-3, 12px) var(--sp-4, 16px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
    }

    .header-title {
      font-size: var(--text-sm, 13px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
    }

    .header-count {
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      font-family: var(--font-mono, 'SF Mono', monospace);
      margin-left: var(--sp-2, 8px);
    }

    .close-btn {
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: var(--text-secondary, #8e8e93);
      font-size: 16px;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      line-height: 1;
    }

    .close-btn:hover {
      color: var(--text-primary, #ededef);
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
    }

    .save-row {
      display: flex;
      gap: var(--sp-2, 8px);
      padding: var(--sp-3, 12px) var(--sp-4, 16px);
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      flex-shrink: 0;
    }

    .save-row input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: var(--bg-input, rgba(255, 255, 255, 0.04));
      color: var(--text-primary, #ededef);
      font-size: var(--text-xs, 11px);
      font-family: inherit;
      outline: none;
      border-radius: var(--radius-sm, 6px);
    }

    .save-row input:focus { border-color: var(--accent, #5b8def); }
    .save-row input::placeholder { color: var(--text-muted, #48484a); }

    .save-btn {
      padding: 6px 12px;
      border: 1px solid var(--accent, #5b8def);
      background: var(--accent-soft, rgba(224, 85, 69, 0.15));
      color: var(--accent-hover, #ff6b5b);
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
    }

    .save-btn:hover:not(:disabled) {
      background: rgba(224, 85, 69, 0.25);
    }

    .save-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: var(--sp-2, 8px);
    }

    .list-empty {
      padding: var(--sp-6, 24px) var(--sp-4, 16px);
      text-align: center;
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
    }

    .cp-row {
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: var(--surface-1, rgba(255, 255, 255, 0.03));
      border-radius: var(--radius-sm, 6px);
      margin-bottom: var(--sp-2, 8px);
    }

    .cp-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }

    .cp-label {
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
      font-family: var(--font-mono, 'SF Mono', monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .cp-trigger {
      flex-shrink: 0;
      padding: 1px 6px;
      font-size: 9px;
      font-weight: 600;
      font-family: var(--font-mono, 'SF Mono', monospace);
      color: var(--text-secondary, #8e8e93);
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-left: var(--sp-1, 4px);
    }

    .cp-meta {
      font-size: 10px;
      color: var(--text-muted, #48484a);
      font-family: var(--font-mono, 'SF Mono', monospace);
      margin-bottom: var(--sp-2, 8px);
    }

    .cp-actions {
      display: flex;
      gap: 4px;
    }

    .cp-actions button {
      flex: 1;
      padding: 3px 6px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      background: transparent;
      color: var(--text-secondary, #8e8e93);
      font-size: 10px;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .cp-actions button:hover:not(:disabled) {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .cp-actions button.confirm-restore {
      background: rgba(255, 214, 10, 0.12);
      border-color: rgba(255, 214, 10, 0.3);
      color: var(--warning, #ffd60a);
    }

    .cp-actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `;

  /** Visible state — toggled by parent. */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** Session id whose checkpoints we're managing. */
  @property({ type: String, attribute: 'session-id' })
  sessionId = '';

  @state()
  private _checkpoints: CheckpointInfo[] = [];

  @state()
  private _saveLabel = '';

  @state()
  private _saving = false;

  @state()
  private _busyId: string | null = null;

  /**
   * Per-checkpoint two-step confirm: first click flips `_confirmingId`,
   * second click on the same row commits the restore. Cheaper than a
   * dedicated modal and matches the inline-confirm pattern used by the
   * compact toolbar in chat-view.
   */
  @state()
  private _confirmingId: string | null = null;

  /** Re-fetch when the panel opens, the session changes, or the parent
   * view forwards a `session:compacted` lifecycle event. */
  updated(changed: Map<string, unknown>) {
    if ((changed.has('open') || changed.has('sessionId')) && this.open && this.sessionId) {
      void this._loadCheckpoints();
    }
  }

  /**
   * Public method the parent calls when the upstream EventBus emits
   * `session:compacted` for the current session — checkpoint ids may
   * point at messages that no longer exist after a compaction.
   */
  async refresh() {
    if (this.open && this.sessionId) {
      await this._loadCheckpoints();
    }
  }

  /** Number of checkpoints — used by the parent to label the toggle button. */
  get count(): number {
    return this._checkpoints.length;
  }

  render() {
    return html`
      <div class="panel" role="region" aria-label="Checkpoints">
        <div class="header">
          <div>
            <span class="header-title">Checkpoints</span>
            <span class="header-count">(${this._checkpoints.length})</span>
          </div>
          <button class="close-btn" @click=${this._close} aria-label="Close checkpoints">&#215;</button>
        </div>

        <div class="save-row">
          <input
            placeholder="Optional label..."
            .value=${this._saveLabel}
            ?disabled=${this._saving}
            @input=${(e: InputEvent) => { this._saveLabel = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter') { e.preventDefault(); void this._save(); }
            }}
          >
          <button class="save-btn" @click=${this._save} ?disabled=${this._saving}
                  aria-label="Save checkpoint">
            ${this._saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        <div class="list">
          ${this._checkpoints.length === 0
            ? html`<div class="list-empty">No checkpoints yet — save one above.</div>`
            : this._checkpoints.map((cp) => this._renderRow(cp))}
        </div>
      </div>
    `;
  }

  private _renderRow(cp: CheckpointInfo) {
    const isConfirming = this._confirmingId === cp.id;
    const busy = this._busyId === cp.id;
    return html`
      <div class="cp-row">
        <div class="cp-top">
          <span class="cp-label" title="${cp.id}">
            ${cp.label || cp.id.slice(0, 12)}
          </span>
          ${cp.trigger ? html`<span class="cp-trigger">${cp.trigger}</span>` : nothing}
        </div>
        <div class="cp-meta">
          ${timeAgo(cp.createdAt)}${cp.messageCount !== undefined
            ? html` &middot; ${cp.messageCount} msgs`
            : nothing}${cp.iteration !== undefined
              ? html` &middot; iter ${cp.iteration}`
              : nothing}
        </div>
        <div class="cp-actions">
          <button
            class=${isConfirming ? 'confirm-restore' : ''}
            ?disabled=${busy}
            @click=${() => this._restoreClick(cp)}
            aria-label="${isConfirming ? 'Confirm restore' : 'Restore checkpoint'}"
          >${isConfirming ? 'Confirm?' : 'Restore'}</button>
          <button
            ?disabled=${busy}
            @click=${() => this._replay(cp)}
            aria-label="Replay checkpoint as new session"
          >Replay</button>
        </div>
      </div>
    `;
  }

  private _close() {
    this._confirmingId = null;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async _loadCheckpoints() {
    try {
      const data = await api<CheckpointListResponse>(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/checkpoints`,
      );
      this._checkpoints = data.checkpoints || [];
    } catch (err: unknown) {
      // Listing failure should not surface as a destructive toast — the
      // panel can still be used to save a new one. Log silently and
      // keep the existing list.
      const msg = err instanceof Error ? err.message : 'Failed to load checkpoints';
      showToast(msg, 'error');
    }
  }

  private async _save() {
    if (this._saving || !this.sessionId) return;
    this._saving = true;
    const label = this._saveLabel.trim();
    try {
      const data = await api<SaveResponse>(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/checkpoint`,
        {
          method: 'POST',
          body: JSON.stringify(label ? { label } : {}),
        },
      );
      showToast(`Checkpoint saved${label ? `: ${label}` : ''}`, 'success');
      // Optimistically prepend so the row appears without a round-trip.
      if (data.checkpoint) {
        this._checkpoints = [data.checkpoint, ...this._checkpoints];
      } else {
        await this._loadCheckpoints();
      }
      this._saveLabel = '';
      this.dispatchEvent(new CustomEvent('saved', {
        detail: { label: label || undefined, checkpoint: data.checkpoint },
        bubbles: true,
        composed: true,
      }));
    } catch (err: unknown) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Save failed';
      showToast(msg, 'error');
    } finally {
      this._saving = false;
    }
  }

  private _restoreClick(cp: CheckpointInfo) {
    if (this._confirmingId !== cp.id) {
      // First click — flip into 'are you sure' state. Auto-revert after
      // 4 seconds so the operator can't accidentally double-click later.
      this._confirmingId = cp.id;
      setTimeout(() => {
        if (this._confirmingId === cp.id) this._confirmingId = null;
      }, 4000);
      return;
    }
    void this._restore(cp);
  }

  private async _restore(cp: CheckpointInfo) {
    if (this._busyId) return;
    this._busyId = cp.id;
    this._confirmingId = null;
    try {
      const data = await api<RestoreResponse>(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/restore`,
        { method: 'POST', body: JSON.stringify({ checkpointId: cp.id }) },
      );
      const target = data.restoredIteration !== undefined
        ? `iteration ${data.restoredIteration}`
        : (cp.label || cp.id.slice(0, 8));
      showToast(`Restored to ${target}`, 'success');
      this.dispatchEvent(new CustomEvent('restored', {
        detail: {
          checkpointId: cp.id,
          messageCount: data.messageCount,
          restoredIteration: data.restoredIteration,
        },
        bubbles: true,
        composed: true,
      }));
    } catch (err: unknown) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Restore failed';
      showToast(msg, 'error');
    } finally {
      this._busyId = null;
    }
  }

  private async _replay(cp: CheckpointInfo) {
    if (this._busyId) return;
    this._busyId = cp.id;
    try {
      const data = await api<ReplayResponse>(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/replay`,
        { method: 'POST', body: JSON.stringify({ checkpointId: cp.id }) },
      );
      showToast('Replay session opened', 'success');
      this.dispatchEvent(new CustomEvent('replay-opened', {
        detail: {
          sourceCheckpointId: cp.id,
          newSessionId: data.sessionId,
          messageCount: data.messageCount,
        },
        bubbles: true,
        composed: true,
      }));
    } catch (err: unknown) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Replay failed';
      showToast(msg, 'error');
    } finally {
      this._busyId = null;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-checkpoint-panel': CrowClawCheckpointPanel;
  }
}

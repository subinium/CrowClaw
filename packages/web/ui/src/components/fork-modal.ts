/**
 * Fork modal — clones a session into a new child with an optional task and
 * an optional toolset restriction. POSTs to `/api/sessions/:id/fork`
 * (shipped in v0.6.0 #146 + #84). On success emits `forked` so the parent
 * view can route to the new child + show a toast.
 *
 * Issue #194 (v0.7 sweep): the runtime route exists but the dashboard had
 * no UI affordance — the "$1 background analysis" workflow that motivated
 * #146 was inaccessible from the chat surface.
 *
 * UX:
 *   - Built on top of <crowclaw-modal> for consistent chrome.
 *   - Read-only parent preview (title + last assistant message excerpt).
 *   - 'New task' textarea — required; the child seeds with this user message.
 *   - Toolset multi-select — chips toggled via click; empty selection means
 *     'inherit parent toolsets' (matches the runtime's optional contract).
 *   - 'Fork' button calls POST and emits `forked` on success.
 *   - Cancel/close emits `close` so the parent can reset.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api.js';
import { showToast } from './toast.js';
import './modal.js';

interface ForkResponse {
  ok: boolean;
  forkSessionId: string;
  parentSessionId: string;
}

export interface ForkParentInfo {
  /** Parent session id (passed through to the route). */
  sessionId: string;
  /** Display title for the parent — '' falls back to truncated id. */
  title?: string;
  /** Last assistant snippet shown in the read-only preview. */
  preview?: string;
}

@customElement('crowclaw-fork-modal')
export class CrowClawForkModal extends LitElement {
  static styles = css`
    :host {
      display: contents;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    .parent-card {
      background: var(--bg-card, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: var(--sp-3, 12px);
      margin-bottom: var(--sp-4, 16px);
    }

    .parent-label {
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      color: var(--text-muted, #48484a);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: var(--sp-1, 4px);
    }

    .parent-title {
      font-size: var(--text-sm, 13px);
      color: var(--text-primary, #ededef);
      font-weight: 500;
      margin-bottom: var(--sp-1, 4px);
    }

    .parent-preview {
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      line-height: 1.4;
      max-height: 64px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }

    .field {
      margin-bottom: var(--sp-4, 16px);
    }

    .field-label {
      display: block;
      font-size: var(--text-xs, 11px);
      font-weight: 600;
      color: var(--text-secondary, #8e8e93);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: var(--sp-2, 8px);
    }

    .field-hint {
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      margin-top: var(--sp-1, 4px);
    }

    textarea {
      width: 100%;
      min-height: 80px;
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      background: var(--bg-input, rgba(255, 255, 255, 0.04));
      color: var(--text-primary, #ededef);
      font-size: var(--text-sm, 13px);
      font-family: inherit;
      outline: none;
      border-radius: var(--radius-sm, 6px);
      resize: vertical;
      line-height: 1.5;
      box-sizing: border-box;
    }

    textarea:focus { border-color: var(--accent, #e05545); }
    textarea::placeholder { color: var(--text-muted, #48484a); }

    .toolset-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2, 8px);
    }

    .chip {
      padding: 4px 10px;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      background: var(--glass-bg, rgba(255, 255, 255, 0.03));
      color: var(--text-secondary, #8e8e93);
      font-size: var(--text-xs, 11px);
      cursor: pointer;
      border-radius: 12px;
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
      user-select: none;
    }

    .chip:hover {
      border-color: rgba(255, 255, 255, 0.15);
      color: var(--text-primary, #ededef);
    }

    .chip.selected {
      background: var(--accent-soft, rgba(224, 85, 69, 0.15));
      border-color: var(--accent, #e05545);
      color: var(--accent-hover, #ff6b5b);
    }

    .toolsets-empty {
      font-size: var(--text-xs, 11px);
      color: var(--text-muted, #48484a);
      font-style: italic;
    }

    .footer-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--sp-2, 8px);
    }

    .footer-actions button {
      padding: 6px 14px;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      background: var(--glass-bg, rgba(255, 255, 255, 0.03));
      color: var(--text-secondary, #8e8e93);
      font-size: var(--text-sm, 13px);
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .footer-actions button:hover:not(:disabled) {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
    }

    .footer-actions button.primary {
      background: var(--accent, #e05545);
      border-color: var(--accent, #e05545);
      color: #fff;
    }

    .footer-actions button.primary:hover:not(:disabled) {
      background: var(--accent-hover, #ff6b5b);
    }

    .footer-actions button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `;

  /** Visible state — toggled by parent. */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** Parent session info — sessionId is required when `open=true`. */
  @property({ attribute: false })
  parent: ForkParentInfo | null = null;

  /**
   * Available toolsets shown as chips. The list is sourced from
   * `/api/agent/identity` by the parent view (already cached there) and
   * passed in to avoid duplicate fetching from the modal.
   */
  @property({ attribute: false })
  availableToolsets: string[] = [];

  @state()
  private _task = '';

  @state()
  private _selectedToolsets: Set<string> = new Set();

  @state()
  private _submitting = false;

  render() {
    return html`
      <crowclaw-modal
        ?open=${this.open}
        title="Fork session"
        size="md"
        @close=${this._close}
      >
        ${this.parent ? this._renderBody() : nothing}
        <div slot="footer" class="footer-actions">
          <button @click=${this._close} ?disabled=${this._submitting} aria-label="Cancel fork">
            Cancel
          </button>
          <button
            class="primary"
            @click=${this._submit}
            ?disabled=${this._submitting || !this._task.trim()}
            aria-label="Fork session"
          >
            ${this._submitting ? 'Forking...' : 'Fork'}
          </button>
        </div>
      </crowclaw-modal>
    `;
  }

  private _renderBody() {
    const p = this.parent!;
    const title = p.title || `Session ${p.sessionId.slice(0, 8)}`;
    return html`
      <div class="parent-card">
        <div class="parent-label">Forking from</div>
        <div class="parent-title">${title}</div>
        ${p.preview
          ? html`<div class="parent-preview">${p.preview}</div>`
          : nothing}
      </div>

      <div class="field">
        <label class="field-label" for="fork-task">New task</label>
        <textarea
          id="fork-task"
          placeholder="Describe what the child session should work on..."
          .value=${this._task}
          @input=${(e: InputEvent) => { this._task = (e.target as HTMLTextAreaElement).value; }}
        ></textarea>
        <div class="field-hint">
          The child inherits the full transcript of the parent and starts with this user message.
        </div>
      </div>

      <div class="field">
        <label class="field-label">Restrict child toolsets</label>
        ${this.availableToolsets.length === 0
          ? html`<div class="toolsets-empty">No toolsets configured — child will inherit parent.</div>`
          : html`
              <div class="toolset-chips" role="group" aria-label="Toolset selection">
                ${this.availableToolsets.map((name) => {
                  const selected = this._selectedToolsets.has(name);
                  return html`
                    <button
                      type="button"
                      class="chip ${selected ? 'selected' : ''}"
                      @click=${() => this._toggleToolset(name)}
                      aria-pressed=${selected}
                    >${name}</button>
                  `;
                })}
              </div>
            `}
        <div class="field-hint">
          Empty selection inherits parent toolsets. Select chips to restrict the child.
        </div>
      </div>
    `;
  }

  private _toggleToolset(name: string) {
    const next = new Set(this._selectedToolsets);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    this._selectedToolsets = next;
  }

  private _close() {
    if (this._submitting) return;
    this._task = '';
    this._selectedToolsets = new Set();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  private async _submit() {
    if (this._submitting) return;
    if (!this.parent?.sessionId) {
      showToast('No parent session selected', 'error');
      return;
    }
    const task = this._task.trim();
    if (!task) {
      showToast('Task is required', 'error');
      return;
    }
    this._submitting = true;
    const enabledToolsets = Array.from(this._selectedToolsets);
    const body: Record<string, unknown> = { task };
    if (enabledToolsets.length > 0) {
      body.enabledToolsets = enabledToolsets;
    }
    try {
      const data = await api<ForkResponse>(
        `/api/sessions/${encodeURIComponent(this.parent.sessionId)}/fork`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      const parentLabel = this.parent.title || this.parent.sessionId.slice(0, 8);
      showToast(`Forked from ${parentLabel}`, 'success');
      this.dispatchEvent(new CustomEvent('forked', {
        detail: {
          parentSessionId: data.parentSessionId,
          forkSessionId: data.forkSessionId,
        },
        bubbles: true,
        composed: true,
      }));
      this._task = '';
      this._selectedToolsets = new Set();
    } catch (err: unknown) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Fork failed';
      showToast(msg, 'error');
    } finally {
      this._submitting = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-fork-modal': CrowClawForkModal;
  }
}

/**
 * Steer composer — slide-up textarea for issuing mid-run course-correction
 * directives to a running session. Posts to `POST /api/sessions/:id/steer`
 * (shipped in v0.6.0 #145) and surfaces the result via toast + a `steered`
 * event the parent view consumes to insert a steer marker into the stream.
 *
 * Issue #193 (v0.7 sweep): the runtime route exists but the dashboard had
 * no UI affordance — `/steer` is the platform's headline differentiator
 * vs vanilla agents and was effectively invisible.
 *
 * Behavior:
 *   - Visible only when the parent passes `open=true` (toggled by chat-view
 *     when `session.status === 'running'`).
 *   - Submit on Enter (Shift+Enter for newline) or via the Send button.
 *   - Escape collapses the panel without sending.
 *   - On 409 (SESSION_NOT_ACTIVE) the toast surfaces the structured error.
 *   - Success emits `steered` with `{ directive, injectedPrompt }` so the
 *     chat-view can drop a 'pending' marker that flips to 'applied' once
 *     the EventBus `session:steered` event arrives.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { api, ApiError } from '../lib/api.js';
import { showToast } from './toast.js';

interface SteerResponse {
  ok: boolean;
  injectedPrompt: string;
}

@customElement('crowclaw-steer-composer')
export class CrowClawSteerComposer extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Inter', sans-serif);
    }

    /* The panel is rendered in a sticky bottom-of-stream position by the
       parent view. The slide animation is purely visual — actual DOM
       presence is governed by the "open" property. */
    .panel {
      border: 1px solid rgba(255, 214, 10, 0.25);
      background: rgba(255, 214, 10, 0.05);
      border-left: 3px solid var(--warning, #ffd60a);
      border-radius: var(--radius-md, 8px);
      padding: var(--sp-3, 12px);
      display: flex;
      flex-direction: column;
      gap: var(--sp-2, 8px);
      transform: translateY(8px);
      opacity: 0;
      transition:
        transform var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1)),
        opacity var(--duration-normal, 200ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    :host([open]) .panel {
      transform: translateY(0);
      opacity: 1;
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      font-size: var(--text-xs, 11px);
      color: var(--warning, #ffd60a);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }

    .header svg {
      width: 12px;
      height: 12px;
    }

    .header .hint {
      margin-left: auto;
      font-weight: 400;
      color: var(--text-muted, #48484a);
      text-transform: none;
      letter-spacing: 0;
    }

    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 120px;
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

    textarea:focus {
      border-color: var(--warning, #ffd60a);
    }

    textarea::placeholder {
      color: var(--text-muted, #48484a);
    }

    textarea:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .actions {
      display: flex;
      gap: var(--sp-2, 8px);
      justify-content: flex-end;
    }

    button {
      padding: 4px 10px;
      border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.08));
      background: var(--glass-bg, rgba(255, 255, 255, 0.03));
      color: var(--text-secondary, #8e8e93);
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm, 6px);
      transition: all var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    button:hover:not(:disabled) {
      background: var(--bg-card-hover, rgba(255, 255, 255, 0.07));
      color: var(--text-primary, #ededef);
    }

    button.send {
      background: rgba(255, 214, 10, 0.12);
      border-color: rgba(255, 214, 10, 0.3);
      color: var(--warning, #ffd60a);
    }

    button.send:hover:not(:disabled) {
      background: rgba(255, 214, 10, 0.18);
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  `;

  /** When true, the panel is rendered + animates in. */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** Session id the steer directive targets. */
  @property({ type: String, attribute: 'session-id' })
  sessionId = '';

  /** Internal: in-flight POST guards double-submit. */
  @state()
  private _sending = false;

  @query('textarea')
  private _textarea!: HTMLTextAreaElement;

  /**
   * Programmatically focus the textarea — chat-view calls this after
   * setting `open=true` so the operator can immediately type.
   */
  focusInput() {
    requestAnimationFrame(() => {
      this._textarea?.focus();
    });
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="panel" role="region" aria-label="Steer composer">
        <div class="header">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14"/>
            <path d="m12 5 7 7-7 7"/>
          </svg>
          <span>Steer</span>
          <span class="hint">Enter to send / Shift+Enter for newline / Esc to close</span>
        </div>
        <textarea
          rows="2"
          placeholder="Send mid-run guidance to the agent..."
          ?disabled=${this._sending}
          @keydown=${this._onKeydown}
        ></textarea>
        <div class="actions">
          <button @click=${this._cancel} ?disabled=${this._sending} aria-label="Cancel">
            Cancel
          </button>
          <button class="send" @click=${this._submit} ?disabled=${this._sending} aria-label="Send steer directive">
            ${this._sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    `;
  }

  private _onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this._submit();
    }
  }

  private _cancel() {
    if (this._sending) return;
    this.dispatchEvent(new CustomEvent('cancel', { bubbles: true, composed: true }));
  }

  private async _submit() {
    if (this._sending) return;
    const directive = this._textarea?.value.trim() ?? '';
    if (!directive) {
      showToast('Steer directive cannot be empty', 'error');
      return;
    }
    if (!this.sessionId) {
      showToast('No active session to steer', 'error');
      return;
    }
    this._sending = true;
    try {
      const data = await api<SteerResponse>(
        `/api/sessions/${encodeURIComponent(this.sessionId)}/steer`,
        { method: 'POST', body: JSON.stringify({ directive }) },
      );
      showToast('Steer sent — applying after next iteration', 'success');
      this.dispatchEvent(new CustomEvent('steered', {
        detail: { directive, injectedPrompt: data.injectedPrompt },
        bubbles: true,
        composed: true,
      }));
      // Reset textarea content for re-use without re-mounting.
      if (this._textarea) this._textarea.value = '';
    } catch (err: unknown) {
      // The runtime returns 409 SESSION_NOT_ACTIVE when the agent has already
      // finished its turn — surface the message verbatim so the operator
      // knows to run a normal message instead of a steer.
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Steer failed';
      showToast(msg, 'error');
    } finally {
      this._sending = false;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-steer-composer': CrowClawSteerComposer;
  }
}

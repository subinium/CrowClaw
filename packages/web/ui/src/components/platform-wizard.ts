/**
 * `<crowclaw-platform-wizard>` — multi-step setup wizard for Telegram, Slack,
 * and Discord (v0.8.4 #200).
 *
 * Closes the gap between "no in-dashboard wizard" and "<5 min time-to-first
 * gateway message" called out in the v0.7 platform polish audit.
 *
 * Steps:
 *   1. **External setup** — deeplinks to BotFather / api.slack.com / discord
 *      developer portal, with platform-specific copy.
 *   2. **Paste credentials** — bot token (Slack also takes a signing secret;
 *      Discord takes a webhook URL). The wizard validates the credential by
 *      POSTing to `/api/gateway/<platform>/validate-token` so we never store
 *      a token without first confirming it works.
 *   3. **Webhook auto-config** — for Telegram, calls `setWebhook` against the
 *      runtime; for Slack/Discord, prints the URL the user must paste into
 *      the platform portal. ngrok / cloudflared hint shown when localhost is
 *      detected.
 *   4. **Confirm + test** — user can fire a probe / send a test ping.
 *
 * The wizard reuses `<crowclaw-modal>` for the chrome — the parent view owns
 * an `open` flag and listens for the `wizard-complete` / `close` events.
 *
 * Pure helpers (`platformConfig`, `nextStep`, `prevStep`, `requiresLocalhost`,
 * `defaultWebhookUrl`, `defaultPublicUrlHint`) are exported so unit tests can
 * exercise step navigation and copy generation without standing up a DOM.
 */

import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { api } from '../lib/api.js';
import { showToast } from './toast.js';
import './modal.js';
import './button.js';
import './icon.js';
import './status-dot.js';

/* ------------------------------------------------------------------ */
/*  Types & pure helpers (exported for tests)                          */
/* ------------------------------------------------------------------ */

export type WizardPlatform = 'telegram' | 'slack' | 'discord';

export type WizardStep = 1 | 2 | 3 | 4;

export interface PlatformCopy {
  /** Platform name as shown in headings */
  name: string;
  /** External portal URL (Step 1 deeplink) */
  portalUrl: string;
  /** Short label for the portal CTA */
  portalLabel: string;
  /** One-liner describing what to do at the portal */
  portalHint: string;
  /** Token field label and placeholder */
  tokenLabel: string;
  tokenPlaceholder: string;
  /** Whether the platform needs a signing secret (Slack) */
  requiresSigningSecret: boolean;
  /** Whether the platform's primary credential is a webhook URL (Discord) */
  primaryFieldIsWebhookUrl: boolean;
  /** Whether the wizard can auto-register the webhook server-side */
  supportsAutoWebhook: boolean;
  /** Webhook path served by the runtime (used to build the public URL hint) */
  webhookPath: string;
  /** What to do at Step 3 if `supportsAutoWebhook` is false */
  webhookManualHint: string;
}

const PLATFORM_COPY: Record<WizardPlatform, PlatformCopy> = {
  telegram: {
    name: 'Telegram',
    portalUrl: 'https://t.me/BotFather?start',
    portalLabel: 'Open BotFather',
    portalHint:
      'Send /newbot to @BotFather, choose a display name and username, then copy the bot token (a string like 123456:ABCDEF...).',
    tokenLabel: 'Bot Token',
    tokenPlaceholder: '123456789:ABCdefGhIJK...',
    requiresSigningSecret: false,
    primaryFieldIsWebhookUrl: false,
    supportsAutoWebhook: true,
    webhookPath: '/webhooks/telegram',
    webhookManualHint:
      'CrowClaw will register this URL with Telegram via setWebhook automatically.',
  },
  slack: {
    name: 'Slack',
    portalUrl: 'https://api.slack.com/apps',
    portalLabel: 'Open Slack apps',
    portalHint:
      'Create an app, install it to your workspace, then copy the Bot User OAuth Token (xoxb-...) and the Signing Secret from "Basic Information".',
    tokenLabel: 'Bot User OAuth Token',
    tokenPlaceholder: 'xoxb-...',
    requiresSigningSecret: true,
    primaryFieldIsWebhookUrl: false,
    supportsAutoWebhook: false,
    webhookPath: '/webhooks/slack',
    webhookManualHint:
      'In Slack: open Event Subscriptions, paste the URL below into "Request URL", and subscribe to message.channels and app_mention bot events.',
  },
  discord: {
    name: 'Discord',
    portalUrl: 'https://discord.com/developers/applications',
    portalLabel: 'Open Discord apps',
    portalHint:
      'Create an application, open the Bot tab, copy the bot token, then create a channel webhook in your server and copy the webhook URL.',
    tokenLabel: 'Channel Webhook URL',
    tokenPlaceholder: 'https://discord.com/api/webhooks/...',
    requiresSigningSecret: false,
    primaryFieldIsWebhookUrl: true,
    supportsAutoWebhook: false,
    webhookPath: '/webhooks/discord',
    webhookManualHint:
      'Discord delivers messages by us POSTing to your webhook URL on each agent reply. The URL above is what the runtime listens on for inbound interactions; paste it under "Interactions Endpoint URL" if you also want slash-command callbacks.',
  },
};

/** Returns the copy block for a wizard platform (pure). */
export function platformConfig(platform: WizardPlatform): PlatformCopy {
  return PLATFORM_COPY[platform];
}

/** Compute the next step (capped at 4). */
export function nextStep(step: WizardStep): WizardStep {
  return (step < 4 ? (step + 1) : 4) as WizardStep;
}

/** Compute the previous step (capped at 1). */
export function prevStep(step: WizardStep): WizardStep {
  return (step > 1 ? (step - 1) : 1) as WizardStep;
}

/**
 * Returns true when the public URL is a localhost / loopback address — the
 * caller will need ngrok / cloudflared before any platform can reach the
 * runtime.
 *
 * Note: `URL.hostname` strips IPv6 brackets, so we normalise both forms.
 */
export function requiresLocalhost(publicUrl: string): boolean {
  if (!publicUrl) return true;
  try {
    const u = new URL(publicUrl);
    const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local')
    );
  } catch {
    return true;
  }
}

/**
 * Build the default public webhook URL the wizard should suggest. If the
 * caller provides a `publicUrlOverride`, use that; otherwise fall back to
 * the current document origin. The returned URL is guaranteed to end with
 * `/webhooks/<platform>` and to NOT have a trailing slash.
 */
export function defaultWebhookUrl(
  platform: WizardPlatform,
  origin: string,
  publicUrlOverride?: string,
): string {
  const base = (publicUrlOverride && publicUrlOverride.trim()) || origin;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}${PLATFORM_COPY[platform].webhookPath}`;
}

/** ngrok / cloudflared hint shown on Step 3 when the URL is a loopback. */
export function defaultPublicUrlHint(port: number = 8787): string {
  return `Run ngrok http ${port} (or cloudflared tunnel --url http://localhost:${port}) and paste the https URL into "Public URL" in Remote Access.`;
}

/* ------------------------------------------------------------------ */
/*  Network types                                                      */
/* ------------------------------------------------------------------ */

interface ValidateTokenResponse {
  ok: boolean;
  platform?: string;
  identity?: string;
  details?: Record<string, unknown>;
  error?: string;
}

interface SetWebhookResponse {
  ok: boolean;
  description?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-platform-wizard')
export class CrowClawPlatformWizard extends LitElement {
  static styles = css`
    :host {
      display: contents;
    }

    .stepper {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      margin-bottom: var(--sp-4, 16px);
    }

    .stepper .pill {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      transition: background var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }
    .stepper .pill.active {
      background: var(--accent, #5b8def);
    }
    .stepper .pill.done {
      background: var(--success, #30d158);
    }

    .step-title {
      font-size: var(--text-base, 14px);
      font-weight: 600;
      color: var(--text-primary, #ededef);
      margin: 0 0 var(--sp-2, 8px);
    }

    .step-help {
      font-size: var(--text-xs, 11px);
      color: var(--text-secondary, #8e8e93);
      line-height: 1.6;
      margin-bottom: var(--sp-3, 12px);
    }

    .form-group {
      margin-bottom: var(--sp-3, 12px);
    }

    .form-label {
      display: block;
      font-size: var(--text-xs, 11px);
      font-weight: 500;
      color: var(--text-secondary, #8e8e93);
      margin-bottom: var(--sp-1, 4px);
    }

    .form-input {
      width: 100%;
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #ededef);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
      font-size: var(--text-xs, 11px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border-radius: var(--radius-sm, 6px);
      outline: none;
      transition: border-color var(--duration-fast, 120ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
    }

    .form-input:focus {
      border-color: var(--accent, #5b8def);
    }

    .alert {
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      border-radius: var(--radius-sm, 6px);
      font-size: var(--text-xs, 11px);
      line-height: 1.6;
      margin-bottom: var(--sp-3, 12px);
    }
    .alert.ok {
      color: var(--success, #30d158);
      background: rgba(48, 209, 88, 0.08);
      border: 1px solid rgba(48, 209, 88, 0.2);
    }
    .alert.warn {
      color: var(--warning, #ffd60a);
      background: rgba(255, 214, 10, 0.08);
      border: 1px solid rgba(255, 214, 10, 0.2);
    }
    .alert.err {
      color: var(--error, #ff453a);
      background: rgba(255, 69, 58, 0.08);
      border: 1px solid rgba(255, 69, 58, 0.2);
    }

    .url-box {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      background: var(--surface-1, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      border-radius: var(--radius-sm, 6px);
      padding: var(--sp-2, 8px) var(--sp-3, 12px);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
      font-size: var(--text-xs, 11px);
      color: var(--text-primary, #ededef);
      word-break: break-all;
      margin-bottom: var(--sp-3, 12px);
    }
    .url-box .url {
      flex: 1;
    }

    .footer-actions {
      display: flex;
      gap: var(--sp-2, 8px);
      justify-content: space-between;
      align-items: center;
    }

    .footer-actions .right {
      display: flex;
      gap: var(--sp-2, 8px);
    }

    .identity-card {
      display: flex;
      align-items: center;
      gap: var(--sp-2, 8px);
      padding: var(--sp-3, 12px);
      background: rgba(48, 209, 88, 0.08);
      border: 1px solid rgba(48, 209, 88, 0.2);
      border-radius: var(--radius-sm, 6px);
      margin-bottom: var(--sp-3, 12px);
    }

    .identity-card .label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--success, #30d158);
      font-weight: 600;
    }

    .identity-card .value {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
      font-size: var(--text-sm, 13px);
      color: var(--text-primary, #ededef);
    }
  `;

  /** Which platform this wizard is configuring */
  @property({ type: String })
  platform: WizardPlatform = 'telegram';

  /** Whether the wizard modal is open */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** Public URL override from the parent (drives Step 3 hint) */
  @property({ type: String, attribute: 'public-url' })
  publicUrl = '';

  /** Current step in the wizard, 1..4 */
  @state() private step: WizardStep = 1;

  /** Token / webhook URL the user typed */
  @state() private token = '';

  /** Slack signing secret (only used when `requiresSigningSecret`) */
  @state() private signingSecret = '';

  /** Custom webhook URL on Step 3 (defaults to `defaultWebhookUrl`) */
  @state() private webhookUrl = '';

  /** Identity returned by validate-token on Step 2 */
  @state() private identity: string | null = null;

  /** Network state */
  @state() private validating = false;
  @state() private savingConfig = false;
  @state() private settingWebhook = false;
  @state() private testing = false;

  /** Last error from any of the network actions */
  @state() private errorMsg: string | null = null;

  /** True once webhook auto-config (Step 3) has succeeded */
  @state() private webhookRegistered = false;

  /** True once a final test has succeeded */
  @state() private testSucceeded = false;

  /** Reset state every time the wizard is opened on a new platform */
  willUpdate(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open) {
      this._resetState();
    }
  }

  private _resetState() {
    this.step = 1;
    this.token = '';
    this.signingSecret = '';
    this.webhookUrl = defaultWebhookUrl(this.platform, this._origin(), this.publicUrl);
    this.identity = null;
    this.validating = false;
    this.savingConfig = false;
    this.settingWebhook = false;
    this.testing = false;
    this.errorMsg = null;
    this.webhookRegistered = false;
    this.testSucceeded = false;
  }

  private _origin(): string {
    return typeof window !== 'undefined' && window.location ? window.location.origin : '';
  }

  /* ---- step actions ---- */

  private _goNext() {
    this.errorMsg = null;
    this.step = nextStep(this.step);
  }

  private _goBack() {
    this.errorMsg = null;
    this.step = prevStep(this.step);
  }

  private _emitClose = () => {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  };

  /** Step 2 — call validate-token, save config on success, advance. */
  private async _validateAndSave() {
    const cfg = platformConfig(this.platform);
    this.errorMsg = null;
    this.identity = null;

    // Discord stores its credential in `webhookUrl`, others in `token`
    const tokenValue = cfg.primaryFieldIsWebhookUrl ? this.token.trim() : this.token.trim();
    if (!tokenValue) {
      this.errorMsg = `${cfg.tokenLabel} is required.`;
      return;
    }
    if (cfg.requiresSigningSecret && !this.signingSecret.trim()) {
      this.errorMsg = 'Signing Secret is required for Slack.';
      return;
    }

    this.validating = true;
    try {
      const validateBody = cfg.primaryFieldIsWebhookUrl
        ? { webhookUrl: tokenValue }
        : { token: tokenValue };
      const validateResult = await api<ValidateTokenResponse>(
        `/api/gateway/${encodeURIComponent(this.platform)}/validate-token`,
        {
          method: 'POST',
          body: JSON.stringify(validateBody),
        },
      );
      if (!validateResult.ok) {
        this.errorMsg = validateResult.error ?? 'Token validation failed.';
        return;
      }
      this.identity = validateResult.identity ?? cfg.name;
    } catch (err: unknown) {
      this.errorMsg = err instanceof Error ? err.message : 'Token validation failed.';
      return;
    } finally {
      this.validating = false;
    }

    // On success, persist the credential so Step 3 / Step 4 can hit the real
    // platform endpoints without re-asking for it.
    this.savingConfig = true;
    try {
      const configBody: Record<string, unknown> = {
        enabled: true,
      };
      if (cfg.primaryFieldIsWebhookUrl) {
        configBody.webhookUrl = tokenValue;
      } else {
        configBody.token = tokenValue;
      }
      if (cfg.requiresSigningSecret) {
        configBody.webhookSecret = this.signingSecret.trim();
      }
      await api(`/api/gateway/${encodeURIComponent(this.platform)}/config`, {
        method: 'POST',
        body: JSON.stringify(configBody),
      });
      this._goNext();
    } catch (err: unknown) {
      this.errorMsg = err instanceof Error ? err.message : 'Failed to save config.';
    } finally {
      this.savingConfig = false;
    }
  }

  /** Step 3 — register the webhook server-side, or just advance if manual. */
  private async _autoConfigureWebhook() {
    const cfg = platformConfig(this.platform);
    this.errorMsg = null;

    if (!cfg.supportsAutoWebhook) {
      // Slack / Discord users paste the URL into the platform portal manually.
      this._goNext();
      return;
    }

    const targetUrl = (this.webhookUrl ?? '').trim();
    if (!targetUrl.startsWith('https://')) {
      this.errorMsg = 'Webhook URL must use HTTPS. Use ngrok / cloudflared for local dev.';
      return;
    }

    this.settingWebhook = true;
    try {
      // Telegram is the only platform that exposes a setWebhook endpoint
      // mounted on the runtime. Slack / Discord are config-only — they're
      // gated above by `supportsAutoWebhook` and never reach this branch.
      const result = await api<SetWebhookResponse>(
        '/api/gateway/telegram/webhook',
        {
          method: 'POST',
          body: JSON.stringify({ url: targetUrl }),
        },
      );
      if (!result.ok) {
        this.errorMsg = result.description ?? 'Webhook registration failed.';
        return;
      }
      this.webhookRegistered = true;
      this._goNext();
    } catch (err: unknown) {
      this.errorMsg = err instanceof Error ? err.message : 'Webhook registration failed.';
    } finally {
      this.settingWebhook = false;
    }
  }

  /** Step 4 — fire a probe (re-validate against the platform). */
  private async _runTest() {
    this.testing = true;
    this.errorMsg = null;
    try {
      const result = await api<{ ok?: boolean; error?: string; identity?: string }>(
        `/api/gateway/${encodeURIComponent(this.platform)}/probe`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      if (result.ok === false) {
        this.errorMsg = result.error ?? 'Probe failed.';
        return;
      }
      this.testSucceeded = true;
      showToast(`${platformConfig(this.platform).name} setup complete.`, 'success');
      // Notify parent so it can refresh status and close the modal.
      this.dispatchEvent(
        new CustomEvent('wizard-complete', {
          detail: { platform: this.platform, identity: this.identity },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (err: unknown) {
      this.errorMsg = err instanceof Error ? err.message : 'Test failed.';
    } finally {
      this.testing = false;
    }
  }

  /* ---- render ---- */

  render() {
    const cfg = platformConfig(this.platform);
    return html`
      <crowclaw-modal
        ?open=${this.open}
        title="${cfg.name} setup"
        size="md"
        @close=${this._emitClose}
      >
        ${this._renderStepper()}
        ${this._renderStepBody(cfg)}
        ${this.errorMsg
          ? html`<div class="alert err" role="alert" aria-live="polite">${this.errorMsg}</div>`
          : nothing}
        <div slot="footer" class="footer-actions">
          <crowclaw-button
            variant="ghost"
            size="sm"
            aria-label="Back"
            ?disabled=${this.step === 1 || this.validating || this.savingConfig || this.settingWebhook}
            @click=${this._goBack}
          >Back</crowclaw-button>
          <div class="right">
            <crowclaw-button
              variant="ghost"
              size="sm"
              aria-label="Cancel wizard"
              @click=${this._emitClose}
            >Cancel</crowclaw-button>
            ${this._renderPrimaryAction(cfg)}
          </div>
        </div>
      </crowclaw-modal>
    `;
  }

  private _renderStepper() {
    return html`
      <div class="stepper" aria-label="Setup progress">
        ${[1, 2, 3, 4].map((s) => {
          const cls = s < this.step ? 'pill done' : s === this.step ? 'pill active' : 'pill';
          return html`<div class=${cls} aria-current=${s === this.step ? 'step' : 'false'}></div>`;
        })}
      </div>
    `;
  }

  private _renderStepBody(cfg: PlatformCopy) {
    switch (this.step) {
      case 1:
        return this._renderStep1(cfg);
      case 2:
        return this._renderStep2(cfg);
      case 3:
        return this._renderStep3(cfg);
      case 4:
      default:
        return this._renderStep4(cfg);
    }
  }

  private _renderStep1(cfg: PlatformCopy) {
    return html`
      <h3 class="step-title">Step 1 — Create your bot</h3>
      <p class="step-help">${cfg.portalHint}</p>
      <crowclaw-button
        variant="primary"
        size="md"
        aria-label="${cfg.portalLabel}"
        @click=${() => window.open(cfg.portalUrl, '_blank', 'noopener,noreferrer')}
      >${cfg.portalLabel}</crowclaw-button>
      <p class="step-help" style="margin-top:var(--sp-3, 12px)">
        Already have a token? Click Next to paste it.
      </p>
    `;
  }

  private _renderStep2(cfg: PlatformCopy) {
    return html`
      <h3 class="step-title">Step 2 — Paste your credentials</h3>
      <p class="step-help">
        We validate the ${cfg.primaryFieldIsWebhookUrl ? 'webhook URL' : 'token'} against
        the ${cfg.name} API before storing it. Nothing is saved until validation succeeds.
      </p>
      <div class="form-group">
        <label class="form-label" for="wizard-token">${cfg.tokenLabel}</label>
        <input
          id="wizard-token"
          class="form-input"
          type=${cfg.primaryFieldIsWebhookUrl ? 'text' : 'password'}
          autocomplete="off"
          spellcheck="false"
          placeholder=${cfg.tokenPlaceholder}
          aria-label="${cfg.tokenLabel}"
          .value=${this.token}
          @input=${(e: InputEvent) => {
            this.token = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
      ${cfg.requiresSigningSecret
        ? html`
            <div class="form-group">
              <label class="form-label" for="wizard-signing-secret">Signing Secret</label>
              <input
                id="wizard-signing-secret"
                class="form-input"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="Slack Signing Secret (32 hex chars)"
                aria-label="Slack Signing Secret"
                .value=${this.signingSecret}
                @input=${(e: InputEvent) => {
                  this.signingSecret = (e.target as HTMLInputElement).value;
                }}
              />
            </div>
          `
        : nothing}
      ${this.identity
        ? html`
            <div class="identity-card">
              <crowclaw-status-dot status="ok"></crowclaw-status-dot>
              <div>
                <div class="label">Connected as</div>
                <div class="value">${this.identity}</div>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  private _renderStep3(cfg: PlatformCopy) {
    const localhost = requiresLocalhost(this.publicUrl || this._origin());
    return html`
      <h3 class="step-title">Step 3 — Webhook setup</h3>
      <p class="step-help">
        ${cfg.supportsAutoWebhook
          ? cfg.webhookManualHint
          : `Paste the URL below into the ${cfg.name} portal. ${cfg.webhookManualHint}`}
      </p>
      <div class="form-group">
        <label class="form-label" for="wizard-webhook">Public webhook URL</label>
        <input
          id="wizard-webhook"
          class="form-input"
          aria-label="Public webhook URL"
          .value=${this.webhookUrl}
          @input=${(e: InputEvent) => {
            this.webhookUrl = (e.target as HTMLInputElement).value;
          }}
        />
      </div>
      ${localhost
        ? html`
            <div class="alert warn" role="alert">
              ${defaultPublicUrlHint(8787)}
            </div>
          `
        : nothing}
      ${!cfg.supportsAutoWebhook
        ? html`
            <div class="url-box">
              <span class="url">${this.webhookUrl}</span>
              <crowclaw-button
                variant="ghost"
                size="sm"
                aria-label="Copy webhook URL"
                @click=${() => navigator.clipboard?.writeText(this.webhookUrl).catch(() => {})}
              >
                <crowclaw-icon slot="icon" name="copy" size="14"></crowclaw-icon>
                Copy
              </crowclaw-button>
            </div>
          `
        : nothing}
      ${this.webhookRegistered
        ? html`<div class="alert ok" role="status">Webhook registered successfully.</div>`
        : nothing}
    `;
  }

  private _renderStep4(cfg: PlatformCopy) {
    return html`
      <h3 class="step-title">Step 4 — Confirm and test</h3>
      <p class="step-help">
        Run a probe against the ${cfg.name} API to confirm everything is wired up.
        ${cfg.supportsAutoWebhook
          ? 'Your webhook is registered with the platform.'
          : `Make sure you pasted the webhook URL into ${cfg.name} before testing.`}
      </p>
      ${this.identity
        ? html`
            <div class="identity-card">
              <crowclaw-status-dot status="ok"></crowclaw-status-dot>
              <div>
                <div class="label">Connected as</div>
                <div class="value">${this.identity}</div>
              </div>
            </div>
          `
        : nothing}
      ${this.testSucceeded
        ? html`<div class="alert ok" role="status">Setup complete. You can close this wizard.</div>`
        : nothing}
    `;
  }

  private _renderPrimaryAction(cfg: PlatformCopy) {
    switch (this.step) {
      case 1:
        return html`
          <crowclaw-button
            variant="primary"
            size="sm"
            aria-label="Next"
            @click=${this._goNext}
          >Next</crowclaw-button>
        `;
      case 2: {
        const busy = this.validating || this.savingConfig;
        return html`
          <crowclaw-button
            variant="primary"
            size="sm"
            aria-label="Validate ${cfg.name} credentials"
            ?loading=${busy}
            ?disabled=${busy}
            @click=${this._validateAndSave}
          >${busy ? 'Validating' : 'Validate & Save'}</crowclaw-button>
        `;
      }
      case 3: {
        const busy = this.settingWebhook;
        const label = cfg.supportsAutoWebhook
          ? busy
            ? 'Registering'
            : 'Register Webhook'
          : 'Next';
        return html`
          <crowclaw-button
            variant="primary"
            size="sm"
            aria-label=${label}
            ?loading=${busy}
            ?disabled=${busy}
            @click=${this._autoConfigureWebhook}
          >${label}</crowclaw-button>
        `;
      }
      case 4:
      default: {
        const busy = this.testing;
        if (this.testSucceeded) {
          return html`
            <crowclaw-button
              variant="primary"
              size="sm"
              aria-label="Close wizard"
              @click=${this._emitClose}
            >Done</crowclaw-button>
          `;
        }
        return html`
          <crowclaw-button
            variant="primary"
            size="sm"
            aria-label="Run probe test"
            ?loading=${busy}
            ?disabled=${busy}
            @click=${this._runTest}
          >${busy ? 'Testing' : 'Send Test'}</crowclaw-button>
        `;
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-platform-wizard': CrowClawPlatformWizard;
  }
}

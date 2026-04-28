/**
 * First-run setup wizard (#174).
 *
 * Renders a 3-step horizontal stepper that walks a brand-new user through
 *
 *   1. picking + validating a provider key
 *   2. picking a tool preset (MCP+Skill+Tool bundle)
 *   3. sending their first chat
 *
 * The orchestrator (`app.ts`) decides whether to mount this view by calling
 * `shouldShowOnboarding(systemStatus)` against the `/api/system/status`
 * payload. Once the user reaches step 3 and the chat returns successfully,
 * we emit a `crowclaw:onboarding-complete` CustomEvent so the orchestrator
 * can swap back to the normal dashboard.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  buttonStyles,
  cardStyles,
  formStyles,
  sectionStyles,
} from '../lib/shared-styles.js';
import { api, ApiError } from '../lib/api.js';
import { showToast } from '../components/toast.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Subset of `/api/system/status` the wizard cares about. */
export interface OnboardingStatus {
  hasProvider?: boolean;
  hasPreset?: boolean;
  firstChatComplete?: boolean;
}

export type ProviderId =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'nvidia'
  | 'xai'
  | 'ollama';

interface ProviderOption {
  id: ProviderId;
  label: string;
  description: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  /** Ollama is local-only and doesn't need a key. */
  keyless?: boolean;
}

interface PresetOption {
  id: string;
  /** Preset name as known by the runtime (`/api/config-presets/switch`). */
  presetName: string;
  label: string;
  description: string;
  mcps: string[];
  skills: string[];
}

/* ------------------------------------------------------------------ */
/*  Static config                                                      */
/* ------------------------------------------------------------------ */

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter (free tier)',
    description: 'Easiest start — one key, dozens of models.',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Opus / Sonnet / Haiku.',
    defaultModel: 'claude-sonnet-4-5-20250929',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT-4o, GPT-4.1, o-series.',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    description: 'Hosted Llama / Mixtral / Nemotron.',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    description: 'Grok-2 family.',
    defaultModel: 'grok-2-latest',
    defaultBaseUrl: 'https://api.x.ai/v1',
  },
  {
    id: 'ollama',
    label: 'Local Ollama',
    description: 'Runs on your machine, no key needed.',
    defaultModel: 'llama3.1:8b',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyless: true,
  },
];

const PRESET_OPTIONS: PresetOption[] = [
  {
    id: 'coding',
    presetName: 'code-development',
    label: 'Coding Assistant',
    description: 'Write, review, and debug code with filesystem + GitHub access.',
    mcps: ['github', 'filesystem'],
    skills: ['code-review', 'write-tests', 'debug-error', 'refactor-module'],
  },
  {
    id: 'research',
    presetName: 'web-research',
    label: 'Web Researcher',
    description: 'Browse, scrape, and summarize web content.',
    mcps: ['braveSearch', 'playwright'],
    skills: ['web-research', 'summarize-article', 'web-scraping'],
  },
  {
    id: 'custom',
    presetName: 'minimal',
    label: 'Custom (start blank)',
    description: 'No MCPs, no skills — configure it yourself in Settings.',
    mcps: [],
    skills: [],
  },
];

const FIRST_CHAT_PROMPT = 'Tell me what you can do';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Decide whether the onboarding wizard should be rendered.
 *
 * Show the wizard whenever the runtime has not yet seen all three
 * milestones — we always start at the first unmet step so a partially
 * configured runtime resumes mid-flow rather than starting over.
 */
export const shouldShowOnboarding = (status: OnboardingStatus | null | undefined): boolean => {
  if (!status) return false;
  return !(status.hasProvider && status.hasPreset && status.firstChatComplete);
};

/**
 * Decide which step (1-3) the wizard should land on based on what
 * milestones the runtime has already recorded. Exported for tests.
 */
export const initialStepFromStatus = (status: OnboardingStatus | null | undefined): 1 | 2 | 3 => {
  if (!status?.hasProvider) return 1;
  if (!status?.hasPreset) return 2;
  return 3;
};

/**
 * Normalize an API key string. Returns `null` when the key looks empty
 * or obviously malformed (whitespace only, or below a sane min length
 * for the chosen provider).
 */
export const validateApiKey = (provider: ProviderId, raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Local Ollama uses an empty key — the field is hidden in that case
  // anyway, but keep this branch so callers can short-circuit safely.
  if (provider === 'ollama') return trimmed || 'ollama';
  // Every supported hosted provider issues keys >= 16 chars; reject
  // obvious typos before we round-trip them through `/api/providers/test`.
  if (trimmed.length < 16) return null;
  return trimmed;
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-onboarding')
export class CrowClawOnboarding extends LitElement {
  static styles = [
    buttonStyles,
    cardStyles,
    formStyles,
    sectionStyles,
    css`
      :host {
        display: block;
        width: 100%;
        padding: var(--sp-6) var(--sp-5);
        max-width: 880px;
        margin: 0 auto;
      }

      .hdr {
        text-align: center;
        margin-bottom: var(--sp-6);
      }

      .hdr h1 {
        font-size: var(--text-xl);
        font-weight: 600;
        margin: 0 0 var(--sp-2);
        color: var(--text-primary);
      }

      .hdr p {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }

      /* Stepper */
      .stepper {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--sp-2);
        margin-bottom: var(--sp-6);
      }

      .step {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-muted);
        background: var(--glass-bg);
      }

      .step.active {
        color: var(--text-primary);
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .step.done {
        color: var(--success);
        border-color: rgba(48, 209, 88, 0.35);
      }

      .step .num {
        display: inline-flex;
        width: 22px;
        height: 22px;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        font-family: var(--font-mono);
        font-size: 11px;
      }

      .step.active .num {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }

      .step.done .num {
        background: var(--success);
        border-color: var(--success);
        color: #0a0a0c;
      }

      .step-sep {
        width: 32px;
        height: 1px;
        background: var(--glass-border);
      }

      /* Panel */
      .panel {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        padding: var(--sp-6);
      }

      /* Provider radio cards */
      .provider-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
        gap: var(--sp-3);
        margin-bottom: var(--sp-5);
      }

      .provider-radio {
        cursor: pointer;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        transition: all var(--duration-fast) var(--ease-spring);
      }

      .provider-radio:hover {
        border-color: rgba(255, 255, 255, 0.18);
      }

      .provider-radio.sel {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .provider-radio input { display: none; }

      .provider-label {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 2px;
      }

      .provider-desc {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      /* Preset cards */
      .preset-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--sp-3);
      }

      .preset-card {
        cursor: pointer;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-4) var(--sp-5);
        transition: all var(--duration-fast) var(--ease-spring);
      }

      .preset-card:hover {
        border-color: rgba(255, 255, 255, 0.18);
      }

      .preset-card.sel {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .preset-title {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-1);
      }

      .preset-desc {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--sp-3);
      }

      .preset-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .preset-tag {
        font-family: var(--font-mono);
        font-size: 10px;
        padding: 2px 6px;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-sm);
        color: var(--text-muted);
      }

      /* Chat step */
      .chat-prompt {
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-4);
      }

      .chat-output {
        white-space: pre-wrap;
        font-size: var(--text-sm);
        color: var(--text-primary);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-4);
        min-height: 80px;
      }

      .done-banner {
        font-size: var(--text-sm);
        color: var(--success);
        background: rgba(48, 209, 88, 0.08);
        border: 1px solid rgba(48, 209, 88, 0.2);
        border-radius: var(--radius-md);
        padding: var(--sp-3) var(--sp-4);
        margin-bottom: var(--sp-4);
      }

      /* Footer actions */
      .actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: var(--sp-5);
      }

      .actions-right {
        display: flex;
        gap: var(--sp-2);
      }

      .skip {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: var(--text-xs);
        cursor: pointer;
        text-decoration: underline;
        padding: 0;
      }

      .skip:hover { color: var(--text-secondary); }

      .err {
        color: var(--error);
        font-size: var(--text-xs);
        margin-top: var(--sp-2);
      }
    `,
  ];

  /** Step the wizard is currently rendering (1, 2, or 3). */
  @state() private currentStep: 1 | 2 | 3 = 1;

  /* Step 1 state */
  @state() private selectedProvider: ProviderId = 'openrouter';
  @state() private apiKeyInput = '';
  @state() private modelInput = '';
  @state() private testingKey = false;
  @state() private keyValidated = false;
  @state() private step1Saving = false;
  @state() private step1Error: string | null = null;

  /* Step 2 state */
  @state() private selectedPreset: string | null = null;
  @state() private step2Saving = false;
  @state() private step2Error: string | null = null;

  /* Step 3 state */
  @state() private chatRunning = false;
  @state() private chatOutput = '';
  @state() private chatComplete = false;
  @state() private step3Error: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    // Default model field follows whatever provider is preselected.
    const opt = PROVIDER_OPTIONS.find((p) => p.id === this.selectedProvider);
    if (opt) this.modelInput = opt.defaultModel;
  }

  /**
   * Allow the orchestrator to resume mid-flow by passing in the latest
   * `/api/system/status` payload. Setting this attribute repositions the
   * stepper without rerunning any save calls.
   */
  setInitialStatus(status: OnboardingStatus): void {
    this.currentStep = initialStepFromStatus(status);
  }

  /* ---------------------------- Step 1 ---------------------------- */

  private _selectProvider(id: ProviderId): void {
    this.selectedProvider = id;
    const opt = PROVIDER_OPTIONS.find((p) => p.id === id);
    if (opt) this.modelInput = opt.defaultModel;
    // Selection invalidates any prior test result.
    this.keyValidated = false;
    this.step1Error = null;
  }

  private async _testKey(): Promise<void> {
    const opt = PROVIDER_OPTIONS.find((p) => p.id === this.selectedProvider);
    if (!opt) return;
    const apiKey = opt.keyless ? '' : validateApiKey(this.selectedProvider, this.apiKeyInput);
    if (!opt.keyless && !apiKey) {
      this.step1Error = 'Enter a valid API key (16+ characters).';
      return;
    }
    this.testingKey = true;
    this.step1Error = null;
    try {
      const res = await api<{ ok: boolean; error?: string }>('/api/providers/test', {
        method: 'POST',
        body: JSON.stringify({
          slot: 'primary',
          provider: opt.id,
          model: this.modelInput || opt.defaultModel,
          apiKey: apiKey ?? '',
          baseUrl: opt.defaultBaseUrl,
        }),
      });
      if (res.ok) {
        this.keyValidated = true;
        showToast('Provider key verified', 'success');
      } else {
        this.keyValidated = false;
        this.step1Error = res.error ?? 'Validation failed';
      }
    } catch (err: unknown) {
      this.keyValidated = false;
      this.step1Error =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Network error';
    } finally {
      this.testingKey = false;
    }
  }

  private async _saveProvider(): Promise<void> {
    const opt = PROVIDER_OPTIONS.find((p) => p.id === this.selectedProvider);
    if (!opt) return;
    const apiKey = opt.keyless ? 'ollama' : validateApiKey(this.selectedProvider, this.apiKeyInput);
    if (!opt.keyless && !apiKey) {
      this.step1Error = 'Enter a valid API key (16+ characters).';
      return;
    }
    this.step1Saving = true;
    this.step1Error = null;
    try {
      await api('/api/providers/config', {
        method: 'POST',
        body: JSON.stringify({
          primary: {
            name: 'primary',
            provider: opt.id,
            model: this.modelInput || opt.defaultModel,
            apiKey: apiKey ?? '',
            baseUrl: opt.defaultBaseUrl,
          },
        }),
      });
      showToast('Provider saved', 'success');
      this.currentStep = 2;
    } catch (err: unknown) {
      this.step1Error =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed';
    } finally {
      this.step1Saving = false;
    }
  }

  /* ---------------------------- Step 2 ---------------------------- */

  private _selectPreset(id: string): void {
    this.selectedPreset = id;
    this.step2Error = null;
  }

  private async _savePreset(): Promise<void> {
    const preset = PRESET_OPTIONS.find((p) => p.id === this.selectedPreset);
    if (!preset) {
      this.step2Error = 'Pick a preset to continue.';
      return;
    }
    this.step2Saving = true;
    this.step2Error = null;
    try {
      await api('/api/config-presets/switch', {
        method: 'POST',
        body: JSON.stringify({ name: preset.presetName }),
      });
      showToast(`${preset.label} activated`, 'success');
      this.currentStep = 3;
    } catch (err: unknown) {
      this.step2Error =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Save failed';
    } finally {
      this.step2Saving = false;
    }
  }

  /* ---------------------------- Step 3 ---------------------------- */

  private async _runFirstChat(): Promise<void> {
    this.chatRunning = true;
    this.chatOutput = '';
    this.step3Error = null;
    try {
      // Create a fresh session, then post the canned prompt to it. Using
      // the non-stream `action: 'message'` form keeps onboarding code
      // path-independent of the SSE plumbing — the wizard only needs the
      // turn to land successfully so we can flip `firstChatComplete`.
      const sessionRes = await api<{ ok: boolean; sessionId: string }>(
        '/api/sessions',
        { method: 'POST', body: JSON.stringify({}) },
      );
      const sid = sessionRes.sessionId;
      const turnRes = await api<{ ok: boolean; reply?: string; error?: string }>(
        `/api/sessions/${encodeURIComponent(sid)}`,
        {
          method: 'POST',
          body: JSON.stringify({ action: 'message', message: FIRST_CHAT_PROMPT }),
        },
      );
      if (turnRes.ok === false) {
        throw new Error(turnRes.error ?? 'Chat failed');
      }
      this.chatOutput = turnRes.reply ?? '(no reply)';
      this.chatComplete = true;
      showToast('First chat captured — try the Memory tab', 'success');
      this.dispatchEvent(
        new CustomEvent('crowclaw:onboarding-complete', { bubbles: true, composed: true }),
      );
    } catch (err: unknown) {
      this.step3Error =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Chat failed';
    } finally {
      this.chatRunning = false;
    }
  }

  private _skip(): void {
    this.dispatchEvent(
      new CustomEvent('crowclaw:onboarding-skip', { bubbles: true, composed: true }),
    );
  }

  /* ---------------------------- Render ---------------------------- */

  private _renderStepper() {
    const steps: Array<{ n: 1 | 2 | 3; label: string }> = [
      { n: 1, label: 'Provider key' },
      { n: 2, label: 'Tool preset' },
      { n: 3, label: 'First chat' },
    ];
    return html`
      <div class="stepper" role="navigation" aria-label="Setup progress">
        ${steps.map((s, idx) => {
          const cls = s.n === this.currentStep ? 'active' : s.n < this.currentStep ? 'done' : '';
          return html`
            <div class="step ${cls}" aria-current=${s.n === this.currentStep ? 'step' : nothing}>
              <span class="num">${s.n}</span>
              <span class="label">${s.label}</span>
            </div>
            ${idx < steps.length - 1 ? html`<div class="step-sep"></div>` : nothing}
          `;
        })}
      </div>
    `;
  }

  private _renderStep1() {
    const opt = PROVIDER_OPTIONS.find((p) => p.id === this.selectedProvider);
    return html`
      <div class="panel">
        <div class="provider-list" role="radiogroup" aria-label="Provider">
          ${PROVIDER_OPTIONS.map(
            (p) => html`
              <label
                class="provider-radio ${this.selectedProvider === p.id ? 'sel' : ''}"
                @click=${() => this._selectProvider(p.id)}
              >
                <input
                  type="radio"
                  name="provider"
                  .value=${p.id}
                  .checked=${this.selectedProvider === p.id}
                />
                <div class="provider-label">${p.label}</div>
                <div class="provider-desc">${p.description}</div>
              </label>
            `,
          )}
        </div>

        ${opt && !opt.keyless
          ? html`
              <div class="form-group">
                <label class="form-label" for="onb-key">API key</label>
                <input
                  id="onb-key"
                  class="form-input"
                  type="password"
                  autocomplete="off"
                  .value=${this.apiKeyInput}
                  @input=${(e: Event) => {
                    this.apiKeyInput = (e.target as HTMLInputElement).value;
                    this.keyValidated = false;
                  }}
                />
              </div>
            `
          : nothing}
        <div class="form-group">
          <label class="form-label" for="onb-model">Model</label>
          <input
            id="onb-model"
            class="form-input"
            type="text"
            .value=${this.modelInput}
            @input=${(e: Event) => (this.modelInput = (e.target as HTMLInputElement).value)}
          />
        </div>

        ${this.step1Error ? html`<div class="err">${this.step1Error}</div>` : nothing}

        <div class="actions">
          <button class="skip" @click=${this._skip}>I know what I'm doing — skip</button>
          <div class="actions-right">
            <button
              class="btn"
              ?disabled=${this.testingKey || this.step1Saving}
              @click=${this._testKey}
            >
              ${this.testingKey ? 'Testing…' : this.keyValidated ? 'Verified' : 'Test key'}
            </button>
            <button
              class="btn btn-p"
              ?disabled=${this.step1Saving}
              @click=${this._saveProvider}
            >
              ${this.step1Saving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderStep2() {
    return html`
      <div class="panel">
        <div class="preset-list">
          ${PRESET_OPTIONS.map(
            (p) => html`
              <div
                class="preset-card ${this.selectedPreset === p.id ? 'sel' : ''}"
                role="button"
                tabindex="0"
                @click=${() => this._selectPreset(p.id)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._selectPreset(p.id);
                  }
                }}
              >
                <div class="preset-title">${p.label}</div>
                <div class="preset-desc">${p.description}</div>
                <div class="preset-tags">
                  ${p.mcps.map((m) => html`<span class="preset-tag">mcp:${m}</span>`)}
                  ${p.skills.map((s) => html`<span class="preset-tag">skill:${s}</span>`)}
                  ${p.mcps.length === 0 && p.skills.length === 0
                    ? html`<span class="preset-tag">empty</span>`
                    : nothing}
                </div>
              </div>
            `,
          )}
        </div>

        ${this.step2Error ? html`<div class="err">${this.step2Error}</div>` : nothing}

        <div class="actions">
          <button class="skip" @click=${this._skip}>Skip</button>
          <div class="actions-right">
            <button
              class="btn"
              ?disabled=${this.step2Saving}
              @click=${() => (this.currentStep = 1)}
            >
              Back
            </button>
            <button
              class="btn btn-p"
              ?disabled=${this.step2Saving || !this.selectedPreset}
              @click=${this._savePreset}
            >
              ${this.step2Saving ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderStep3() {
    return html`
      <div class="panel">
        <div class="chat-prompt">${FIRST_CHAT_PROMPT}</div>
        ${this.chatOutput
          ? html`<div class="chat-output">${this.chatOutput}</div>`
          : html`<div class="chat-output">${this.chatRunning ? 'Talking to your model…' : ' '}</div>`}
        ${this.chatComplete
          ? html`<div class="done-banner">
              Try the Memory tab — your first conversation was captured.
            </div>`
          : nothing}
        ${this.step3Error ? html`<div class="err">${this.step3Error}</div>` : nothing}

        <div class="actions">
          <button class="skip" @click=${this._skip}>Skip</button>
          <div class="actions-right">
            <button
              class="btn"
              ?disabled=${this.chatRunning}
              @click=${() => (this.currentStep = 2)}
            >
              Back
            </button>
            ${this.chatComplete
              ? html`
                  <button class="btn btn-p" @click=${this._skip}>Open dashboard</button>
                `
              : html`
                  <button
                    class="btn btn-p"
                    ?disabled=${this.chatRunning}
                    @click=${this._runFirstChat}
                  >
                    ${this.chatRunning ? 'Sending…' : 'Send'}
                  </button>
                `}
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div class="hdr">
        <h1>Welcome to CrowClaw</h1>
        <p>Three quick steps to your first agent run.</p>
      </div>
      ${this._renderStepper()}
      ${this.currentStep === 1 ? this._renderStep1() : nothing}
      ${this.currentStep === 2 ? this._renderStep2() : nothing}
      ${this.currentStep === 3 ? this._renderStep3() : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-onboarding': CrowClawOnboarding;
  }
}

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  buttonStyles,
  cardStyles,
  tagStyles,
  formStyles,
  tabStyles,
  sectionStyles,
  searchStyles,
  gridStyles,
} from '../lib/shared-styles.js';
import { api } from '../lib/api.js';
import { showToast } from '../components/toast.js';
import '../components/toggle-switch.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Preset {
  id: string;
  name: string;
  description: string;
  type: 'persona' | 'toolset' | 'config';
  active?: boolean;
}

/** Raw shape returned by GET /api/presets — server fields differ per category. */
interface PresetsResponse {
  agents: Array<{ name: string; role?: string; goal?: string; backstory?: string }>;
  toolsets: Array<{ name: string; description?: string; toolNames?: string[] }>;
  activeAgent?: string | null;
  activeToolset?: string | null;
}

/** Raw shape returned by GET /api/personas (file-backed PersonaRegistry). */
interface PersonasResponse {
  personas: Array<{ name: string; active: boolean }>;
}

/** Raw shape returned by GET /api/tools. Each entry now exposes `disabled`. */
interface ToolEntry {
  name: string;
  description: string;
  disabled: boolean;
}

interface ToolsResponse {
  tools: ToolEntry[];
  count?: number;
}

/** Raw shape returned by GET /api/config-presets/list */
interface ConfigPresetsResponse {
  presets: Array<{ name: string; description?: string }>;
  active: string | null;
}

interface BackendSkill {
  slug: string;
  title: string;
  summary: string;
  triggerPhrases: string[];
  steps: string[];
  requiredTools: string[];
}

interface Skill {
  slug: string;
  title: string;
  summary: string;
  triggers: string[];
  steps: string[];
  tools: string[];
}

interface SkillsResponse {
  skills: BackendSkill[];
}

type IdentityTab = 'personas' | 'toolsets';

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('crowclaw-agent-view')
export class AgentView extends LitElement {
  static styles = [
    buttonStyles,
    cardStyles,
    tagStyles,
    formStyles,
    tabStyles,
    sectionStyles,
    searchStyles,
    gridStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
      }

      /* View header */
      .mh {
        padding: var(--sp-5) var(--sp-8) 0;
        flex-shrink: 0;
        background: linear-gradient(180deg, rgba(224, 85, 69, 0.02) 0%, transparent 100%);
      }

      .mh h2 {
        font-size: var(--text-xl);
        font-weight: 600;
        letter-spacing: -0.01em;
        background: linear-gradient(90deg, var(--text-primary) 0%, var(--text-secondary) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .mh p {
        font-size: var(--text-xs);
        color: var(--text-muted);
        font-weight: 500;
        margin-top: 1px;
      }

      .mb {
        flex: 1;
        overflow-y: auto;
        padding: var(--sp-4) var(--sp-8) var(--sp-8);
      }

      /* Card extensions */
      .card-name {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-1);
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }

      .card-desc {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.5;
        margin-bottom: var(--sp-3);
      }

      .badge-active {
        display: inline-block;
        padding: 1px 6px;
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--success);
        background: rgba(48, 209, 88, 0.08);
        border: 1px solid rgba(48, 209, 88, 0.2);
        border-radius: var(--radius-sm);
      }

      /* Skill card extras */
      .skill-triggers {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: var(--sp-2);
      }

      .skill-actions {
        display: flex;
        gap: var(--sp-2);
        margin-top: var(--sp-3);
        border-top: 1px solid var(--glass-border);
        padding-top: var(--sp-3);
      }

      /* Toolbar row */
      .toolbar {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        margin-bottom: var(--sp-4);
        flex-wrap: wrap;
      }

      .toolbar .srch {
        flex: 1;
        min-width: 200px;
        margin-bottom: 0;
      }

      /* Inline form */
      .inline-form {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: var(--sp-5);
        margin-bottom: var(--sp-5);
        border-radius: var(--radius-md);
      }

      .inline-form-title {
        font-size: var(--text-base);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-4);
      }

      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--sp-4);
      }

      .form-actions {
        display: flex;
        gap: var(--sp-2);
        margin-top: var(--sp-4);
        justify-content: flex-end;
      }

      /* Import area */
      .import-area {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        padding: var(--sp-5);
        margin-bottom: var(--sp-5);
        border-radius: var(--radius-md);
      }

      .import-area-title {
        font-size: var(--text-base);
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: var(--sp-3);
      }

      /* Edit mode highlight */
      .card.editing {
        border-color: var(--accent);
        background: rgba(224, 85, 69, 0.03);
      }

      /* Config preset activate button */
      .card-footer {
        display: flex;
        justify-content: flex-end;
        margin-top: var(--sp-3);
        padding-top: var(--sp-3);
        border-top: 1px solid var(--glass-border);
      }

      /* Loading spinner */
      .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--sp-8);
        color: var(--text-muted);
        font-size: var(--text-sm);
      }

      .loading::after {
        content: '';
        width: 16px;
        height: 16px;
        border: 2px solid var(--glass-border);
        border-top-color: var(--accent);
        border-radius: 50%;
        margin-left: var(--sp-2);
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* Empty state */
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: var(--sp-12) 0;
        gap: var(--sp-2);
        opacity: 0.5;
      }

      .empty-title {
        font-size: var(--text-base);
        font-weight: 600;
        color: #c8cdd6;
      }

      .empty-subtitle {
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      /* Responsive */
      @media (max-width: 768px) {
        .mb { padding: var(--sp-3); }
        .mh { padding: var(--sp-3) var(--sp-3) 0; }
        .form-row { grid-template-columns: 1fr; }
      }
    `,
  ];

  /* ---- Reactive state ---- */

  // Identity
  @state() private identityTab: IdentityTab = 'personas';
  @state() private personas: Preset[] = [];
  @state() private personasLoading = true;
  @state() private presetToolsets: Preset[] = [];
  @state() private presetsLoading = true;

  // Per-tool overrides (Issue #218)
  @state() private tools: ToolEntry[] = [];
  @state() private toolsLoading = true;

  // Skills
  @state() private skills: Skill[] = [];
  @state() private skillsLoading = true;
  @state() private skillSearch = '';
  @state() private showSkillForm = false;
  @state() private showImportForm = false;
  @state() private editingSkillSlug: string | null = null;

  // Skill form fields
  @state() private formTitle = '';
  @state() private formSummary = '';
  @state() private formTriggers = '';
  @state() private formSteps = '';
  @state() private formTools = '';

  // Import field
  @state() private importText = '';

  // Config presets
  @state() private configPresets: Preset[] = [];
  @state() private configPresetsLoading = true;

  /* ---- Lifecycle ---- */

  connectedCallback() {
    super.connectedCallback();
    this._fetchPresets();
    this._fetchPersonas();
    this._fetchTools();
    this._fetchSkills();
  }

  /* ---- Data fetching ---- */

  private async _fetchPresets() {
    this.presetsLoading = true;
    this.configPresetsLoading = true;
    try {
      const [data, configData] = await Promise.all([
        api<PresetsResponse>('/api/presets'),
        api<ConfigPresetsResponse>('/api/config-presets').catch(() => ({ presets: [], active: null } as ConfigPresetsResponse)),
      ]);
      const activeToolset = data.activeToolset ?? null;

      this.presetToolsets = (data.toolsets ?? []).map((t) => ({
        id: t.name,
        name: t.name,
        description: t.description ?? `${t.toolNames?.length ?? 0} tools`,
        type: 'toolset',
        active: t.name === activeToolset,
      }));

      // Config presets are bundled MCP+Skill+Tool configurations from the dedicated endpoint
      this.configPresets = (configData.presets ?? []).map((p) => ({
        id: p.name,
        name: p.name,
        description: p.description ?? 'Bundled configuration',
        type: 'config',
        active: p.name === configData.active,
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to fetch presets', 'error');
      }
    } finally {
      this.presetsLoading = false;
      this.configPresetsLoading = false;
    }
  }

  /**
   * Issue #217: Personas tab now reads from the file-backed PersonaRegistry
   * (`/api/personas`) instead of the removed hardcoded `agentPresets`.
   */
  private async _fetchPersonas() {
    this.personasLoading = true;
    try {
      const data = await api<PersonasResponse>('/api/personas');
      this.personas = (data.personas ?? []).map((p) => ({
        id: p.name,
        name: p.name,
        description: p.active ? 'Currently active persona' : 'Registered persona',
        type: 'persona',
        active: p.active,
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to fetch personas', 'error');
      }
    } finally {
      this.personasLoading = false;
    }
  }

  /**
   * Issue #218: per-tool override list. Fetches the configured tool registry
   * with each entry's current `disabled` flag.
   */
  private async _fetchTools() {
    this.toolsLoading = true;
    try {
      const data = await api<ToolsResponse>('/api/tools');
      this.tools = (data.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? '',
        disabled: Boolean(t.disabled),
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to fetch tools', 'error');
      }
    } finally {
      this.toolsLoading = false;
    }
  }

  private async _toggleTool(tool: ToolEntry, nextDisabled: boolean) {
    try {
      await api(`/api/tools/${encodeURIComponent(tool.name)}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ disabled: nextDisabled }),
      });
      await this._fetchTools();
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast(`Failed to toggle ${tool.name}`, 'error');
      }
    }
  }

  private async _fetchSkills() {
    this.skillsLoading = true;
    try {
      const data = await api<SkillsResponse>('/api/skills');
      this.skills = (data.skills ?? []).map((s) => ({
        slug: s.slug,
        title: s.title,
        summary: s.summary,
        triggers: s.triggerPhrases ?? [],
        steps: s.steps ?? [],
        tools: s.requiredTools ?? [],
      }));
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to fetch skills', 'error');
      }
    } finally {
      this.skillsLoading = false;
    }
  }

  /* ---- Skill CRUD ---- */

  private async _createSkill() {
    const title = this.formTitle.trim();
    const summary = this.formSummary.trim();
    if (!title) return;

    const triggers = this._splitLines(this.formTriggers);
    const steps = this._splitLines(this.formSteps);
    const tools = this._splitLines(this.formTools);

    try {
      await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ title, summary, triggerPhrases: triggers, steps, requiredTools: tools }),
      });
      this._resetForm();
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to create skill', 'error');
      }
    }
  }

  private async _updateSkill(slug: string) {
    const title = this.formTitle.trim();
    const summary = this.formSummary.trim();
    if (!title) return;

    const triggers = this._splitLines(this.formTriggers);
    const steps = this._splitLines(this.formSteps);
    const tools = this._splitLines(this.formTools);

    try {
      await api(`/api/skills/${slug}`, {
        method: 'PUT',
        body: JSON.stringify({ title, summary, triggerPhrases: triggers, steps, requiredTools: tools }),
      });
      this._resetForm();
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to update skill', 'error');
      }
    }
  }

  private async _deleteSkill(slug: string) {
    try {
      await api(`/api/skills/${slug}`, { method: 'DELETE' });
      this.skills = this.skills.filter((s) => s.slug !== slug);
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to delete skill', 'error');
      }
    }
  }

  private _editSkill(skill: Skill) {
    this.editingSkillSlug = skill.slug;
    this.formTitle = skill.title;
    this.formSummary = skill.summary;
    this.formTriggers = skill.triggers.join('\n');
    this.formSteps = skill.steps.join('\n');
    this.formTools = skill.tools.join('\n');
    this.showSkillForm = true;
    this.showImportForm = false;
  }

  private async _importSkillMd() {
    const text = this.importText.trim();
    if (!text) return;

    // Parse SKILL.md format: extract title, summary, triggers, steps, tools
    const parsed = this._parseSkillMd(text);
    if (!parsed.title) return;

    try {
      await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({
          title: parsed.title,
          summary: parsed.summary,
          triggerPhrases: parsed.triggers,
          steps: parsed.steps,
          requiredTools: parsed.tools,
        }),
      });
      this.importText = '';
      this.showImportForm = false;
      await this._fetchSkills();
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to import skill', 'error');
      }
    }
  }

  /* ---- Config preset actions ---- */

  private async _activatePreset(preset: Preset) {
    const endpointMap: Partial<Record<Preset['type'], string>> = {
      persona: '/api/persona/switch',
      toolset: '/api/toolset/select',
      config: '/api/config-presets/switch',
    };
    const endpoint = endpointMap[preset.type];
    if (!endpoint) {
      showToast(`Activation not supported for ${preset.type} presets`, 'error');
      return;
    }

    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ name: preset.name }),
      });
      // Refresh both lists since persona/toolset/config affect different fetchers.
      await Promise.all([this._fetchPresets(), this._fetchPersonas()]);
    } catch (error: unknown) {
      if (error instanceof Error) {
        showToast('Failed to activate preset', 'error');
      }
    }
  }

  /* ---- Helpers ---- */

  private _splitLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private _parseSkillMd(md: string): { title: string; summary: string; triggers: string[]; steps: string[]; tools: string[] } {
    const result = { title: '', summary: '', triggers: [] as string[], steps: [] as string[], tools: [] as string[] };

    // Extract title: first # heading
    const titleMatch = md.match(/^#\s+(.+)$/m);
    if (titleMatch) result.title = titleMatch[1].trim();

    // Extract sections by heading
    const sections = new Map<string, string>();
    const sectionRegex = /^##\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    const headings: { name: string; index: number }[] = [];

    while ((match = sectionRegex.exec(md)) !== null) {
      headings.push({ name: match[1].trim().toLowerCase(), index: match.index + match[0].length });
    }

    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index - headings[i + 1].name.length - 3 : md.length;
      sections.set(headings[i].name, md.slice(start, end).trim());
    }

    // Summary: text between title and first ## or first paragraph
    if (!titleMatch) {
      result.summary = md.slice(0, 100);
    } else {
      const afterTitle = md.slice((titleMatch.index ?? 0) + titleMatch[0].length);
      const nextHeading = afterTitle.indexOf('\n##');
      const summaryBlock = nextHeading > -1 ? afterTitle.slice(0, nextHeading) : afterTitle.slice(0, 200);
      result.summary = summaryBlock.trim().split('\n')[0] ?? '';
    }

    // Extract list items from sections
    const extractListItems = (text: string): string[] =>
      text
        .split('\n')
        .filter((l) => l.match(/^[-*]\s/))
        .map((l) => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);

    for (const [name, content] of sections) {
      if (name.includes('trigger')) result.triggers = extractListItems(content);
      else if (name.includes('step')) result.steps = extractListItems(content);
      else if (name.includes('tool')) result.tools = extractListItems(content);
    }

    return result;
  }

  private _resetForm() {
    this.formTitle = '';
    this.formSummary = '';
    this.formTriggers = '';
    this.formSteps = '';
    this.formTools = '';
    this.showSkillForm = false;
    this.editingSkillSlug = null;
  }

  private get _filteredSkills(): Skill[] {
    const q = this.skillSearch.toLowerCase();
    if (!q) return this.skills;
    return this.skills.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.triggers.some((t) => t.toLowerCase().includes(q)),
    );
  }

  private get _identityLoading(): boolean {
    return this.identityTab === 'personas' ? this.personasLoading : this.presetsLoading;
  }

  /* ---- Render ---- */

  render() {
    return html`
      <div class="mh">
        <h2>Agent</h2>
        <p>Identity, skills, and configuration presets</p>
      </div>
      <div class="mb">
        ${this._renderIdentitySection()}
        ${this._renderSkillsSection()}
        ${this._renderConfigPresetsSection()}
      </div>
    `;
  }

  /* ---- Section: Identity ---- */

  private _renderIdentitySection() {
    return html`
      <div class="section-block">
        <div class="section-header">Identity</div>
        <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--sp-3)">Manage agent personas and toolset overrides. (MCP servers in Connect.)</p>
        <div class="tabs">
          <div class="tab ${this.identityTab === 'personas' ? 'active' : ''}"
               @click=${() => { this.identityTab = 'personas'; }}>Personas</div>
          <div class="tab ${this.identityTab === 'toolsets' ? 'active' : ''}"
               @click=${() => { this.identityTab = 'toolsets'; }}>Toolsets</div>
        </div>
        ${this._renderIdentityTabContent()}
        <p class="hint" style="font-size:var(--text-xs);color:var(--text-muted);margin-top:var(--sp-4)">MCP servers are managed in <a href="#connect">Connect → MCP Servers</a>.</p>
      </div>
    `;
  }

  private _renderIdentityTabContent() {
    if (this._identityLoading) {
      return html`<div class="loading">Loading ${this.identityTab}</div>`;
    }

    if (this.identityTab === 'personas') {
      return this._renderPersonasTab();
    }

    return this._renderToolsetsTab();
  }

  /** Issue #217: Personas tab — file-backed PersonaRegistry only. */
  private _renderPersonasTab() {
    if (this.personas.length === 0) {
      return html`<crowclaw-empty
        icon="memory"
        title="No personas yet"
        description="Create a persona file under your config directory to get started."
        cta-label="View documentation"
        cta-href="https://github.com/subinium/CrowClaw#personas"
      ></crowclaw-empty>`;
    }
    return html`
      <div class="grid">
        ${this.personas.map((p) => this._renderPresetCard(p))}
      </div>
    `;
  }

  /** Issue #218: Toolsets tab — bundle activation + per-tool overrides. */
  private _renderToolsetsTab() {
    return html`
      ${this.presetToolsets.length === 0
        ? html`<div class="empty">
            <div class="empty-title">No toolsets</div>
            <div class="empty-subtitle">No toolset bundles configured yet.</div>
          </div>`
        : html`
            <div class="grid">
              ${this.presetToolsets.map((p) => this._renderPresetCard(p))}
            </div>
          `}
      ${this._renderToolOverrides()}
    `;
  }

  private _renderToolOverrides() {
    return html`
      <div class="section-header" style="margin-top:var(--sp-5)">Individual tool overrides</div>
      ${this.toolsLoading
        ? html`<div class="loading">Loading tools</div>`
        : this.tools.length === 0
          ? html`<div class="empty">
              <div class="empty-title">No tools registered</div>
              <div class="empty-subtitle">Activate a toolset or config preset to populate the tool registry.</div>
            </div>`
          : html`
              <div class="grid">
                ${this.tools.map((tool) => this._renderToolRow(tool))}
              </div>
            `}
    `;
  }

  private _renderToolRow(tool: ToolEntry) {
    const enabled = !tool.disabled;
    return html`
      <div class="card">
        <div class="card-name">
          ${tool.name}
          ${enabled ? nothing : html`<span class="tag">Disabled</span>`}
        </div>
        <div class="card-desc">${tool.description || 'No description'}</div>
        <div class="card-footer">
          <crowclaw-toggle
            .checked=${enabled}
            aria-label="Toggle tool ${tool.name}"
            @change=${(e: CustomEvent<boolean>) => this._toggleTool(tool, !e.detail)}
          ></crowclaw-toggle>
        </div>
      </div>
    `;
  }

  private _renderPresetCard(preset: Preset) {
    return html`
      <div class="card">
        <div class="card-name">
          ${preset.name}
          ${preset.active ? html`<span class="badge-active">Active</span>` : nothing}
        </div>
        <div class="card-desc">${preset.description || 'No description'}</div>
        <div class="card-footer">
          ${preset.active
            ? html`<span class="tag ok">Activated</span>`
            : html`<button class="btn btn-p" @click=${() => this._activatePreset(preset)}>Activate</button>`}
        </div>
      </div>
    `;
  }

  /* ---- Section: Skills ---- */

  private _renderSkillsSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Skills</div>
        <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--sp-3)">Reusable skill definitions that map trigger phrases to tool execution steps.</p>

        <div class="toolbar">
          <input class="srch"
                 type="text"
                 placeholder="Search skills..."
                 aria-label="Search skills"
                 .value=${this.skillSearch}
                 @input=${(e: InputEvent) => { this.skillSearch = (e.target as HTMLInputElement).value; }}>
          <button class="btn btn-p"
                  aria-label="Create skill"
                  @click=${() => { this._resetForm(); this.showSkillForm = true; this.showImportForm = false; }}>
            Create Skill
          </button>
          <button class="btn"
                  aria-label="Import skill from markdown"
                  @click=${() => { this.showImportForm = !this.showImportForm; this.showSkillForm = false; this._resetForm(); }}>
            Import SKILL.md
          </button>
        </div>

        ${this.showImportForm ? this._renderImportForm() : nothing}
        ${this.showSkillForm ? this._renderSkillForm() : nothing}

        ${this.skillsLoading
          ? html`<div class="loading">Loading skills</div>`
          : this._filteredSkills.length === 0
            ? this.skills.length === 0
              ? html`<crowclaw-empty
                  icon="skills"
                  title="No skills loaded"
                  description="Skills map trigger phrases to tool execution steps. Browse the OpenClaw catalog or drop SKILL.md files into .crowclaw/skills/."
                  cta-label="Browse the catalog"
                  cta-href="https://github.com/subinium/openclaw"
                ></crowclaw-empty>`
              : html`<div class="empty">
                  <div class="empty-title">No matching skills</div>
                  <div class="empty-subtitle">Try a different search term.</div>
                </div>`
            : html`
                <div class="grid">
                  ${this._filteredSkills.map((s) => this._renderSkillCard(s))}
                </div>
              `}
      </div>
    `;
  }

  private _renderSkillCard(skill: Skill) {
    return html`
      <div class="card ${this.editingSkillSlug === skill.slug ? 'editing' : ''}">
        <div class="card-name">${skill.title}</div>
        <div class="card-desc">${skill.summary || 'No summary'}</div>
        ${skill.triggers.length > 0
          ? html`
              <div class="skill-triggers">
                ${skill.triggers.map((t) => html`<span class="tag">${t}</span>`)}
              </div>
            `
          : nothing}
        <div class="skill-actions">
          <button class="btn" aria-label="Edit skill" @click=${() => this._editSkill(skill)}>Edit</button>
          <button class="btn btn-danger" aria-label="Delete skill" @click=${() => this._deleteSkill(skill.slug)}>Delete</button>
        </div>
      </div>
    `;
  }

  private _renderSkillForm() {
    const isEdit = this.editingSkillSlug !== null;

    return html`
      <div class="inline-form">
        <div class="inline-form-title">${isEdit ? 'Edit Skill' : 'Create Skill'}</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Title</label>
            <input class="form-input"
                   type="text"
                   placeholder="e.g. Web Search"
                   .value=${this.formTitle}
                   @input=${(e: InputEvent) => { this.formTitle = (e.target as HTMLInputElement).value; }}>
          </div>
          <div class="form-group">
            <label class="form-label">Summary</label>
            <input class="form-input"
                   type="text"
                   placeholder="Brief description of the skill"
                   .value=${this.formSummary}
                   @input=${(e: InputEvent) => { this.formSummary = (e.target as HTMLInputElement).value; }}>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Trigger Phrases</label>
          <textarea class="form-input"
                    placeholder="One trigger phrase per line"
                    .value=${this.formTriggers}
                    @input=${(e: InputEvent) => { this.formTriggers = (e.target as HTMLTextAreaElement).value; }}></textarea>
          <div class="form-hint">One phrase per line. These are used to match user intent.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Steps</label>
          <textarea class="form-input"
                    placeholder="One step per line"
                    .value=${this.formSteps}
                    @input=${(e: InputEvent) => { this.formSteps = (e.target as HTMLTextAreaElement).value; }}></textarea>
          <div class="form-hint">Ordered execution steps for this skill.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Tools</label>
          <input class="form-input"
                 type="text"
                 placeholder="Tool names, one per line or comma-separated"
                 .value=${this.formTools}
                 @input=${(e: InputEvent) => { this.formTools = (e.target as HTMLInputElement).value; }}>
          <div class="form-hint">Tools required by this skill (e.g. web.search, fs.read).</div>
        </div>
        <div class="form-actions">
          <button class="btn" @click=${() => this._resetForm()}>Cancel</button>
          ${isEdit
            ? html`<button class="btn btn-p" @click=${() => this._updateSkill(this.editingSkillSlug!)}>Save Changes</button>`
            : html`<button class="btn btn-p" @click=${this._createSkill}>Create</button>`}
        </div>
      </div>
    `;
  }

  private _renderImportForm() {
    return html`
      <div class="import-area">
        <div class="import-area-title">Import SKILL.md</div>
        <div class="form-group">
          <textarea class="form-input"
                    rows="10"
                    placeholder="Paste the contents of a SKILL.md file here..."
                    .value=${this.importText}
                    @input=${(e: InputEvent) => { this.importText = (e.target as HTMLTextAreaElement).value; }}></textarea>
        </div>
        <div class="form-actions">
          <button class="btn" @click=${() => { this.showImportForm = false; this.importText = ''; }}>Cancel</button>
          <button class="btn btn-p" @click=${this._importSkillMd}>Import</button>
        </div>
      </div>
    `;
  }

  /* ---- Section: Config Presets ---- */

  private _renderConfigPresetsSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Config Presets</div>
        <p style="font-size:var(--text-xs);color:var(--text-muted);margin-bottom:var(--sp-3)">Bundled configurations that combine MCP servers, skills, and tools into a single activatable preset.</p>
        ${this.configPresetsLoading
          ? html`<div class="loading">Loading config presets</div>`
          : this.configPresets.length === 0
            ? html`<div class="empty">
                <div class="empty-title">No config presets</div>
                <div class="empty-subtitle">Config presets bundle MCP servers, skills, and tools together.</div>
              </div>`
            : html`
                <div class="grid">
                  ${this.configPresets.map((p) => this._renderConfigPresetCard(p))}
                </div>
              `}
      </div>
    `;
  }

  private _renderConfigPresetCard(preset: Preset) {
    return html`
      <div class="card">
        <div class="card-name">
          ${preset.name}
          ${preset.active ? html`<span class="badge-active">Active</span>` : nothing}
        </div>
        <div class="card-desc">${preset.description || 'No description'}</div>
        <div class="card-footer">
          ${preset.active
            ? html`<span class="tag ok">Activated</span>`
            : html`<button class="btn btn-p" @click=${() => this._activatePreset(preset)}>Activate</button>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-agent-view': AgentView;
  }
}

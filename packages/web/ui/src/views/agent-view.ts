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

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Preset {
  id: string;
  name: string;
  description: string;
  type: string;
  active?: boolean;
}

interface PresetsResponse {
  agents: Preset[];
  toolsets: Preset[];
  mcp: Preset[];
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

type IdentityTab = 'personas' | 'toolsets' | 'mcp';

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
  @state() private presetAgents: Preset[] = [];
  @state() private presetToolsets: Preset[] = [];
  @state() private presetMcp: Preset[] = [];
  @state() private presetsLoading = true;

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
    this._fetchSkills();
  }

  /* ---- Data fetching ---- */

  private async _fetchPresets() {
    this.presetsLoading = true;
    this.configPresetsLoading = true;
    try {
      const data = await api<PresetsResponse>('/api/presets');
      this.presetAgents = data.agents ?? [];
      this.presetToolsets = data.toolsets ?? [];
      this.presetMcp = data.mcp ?? [];

      // Config presets are those with type "config" across all categories
      const all = [...this.presetAgents, ...this.presetToolsets, ...this.presetMcp];
      this.configPresets = all.filter((p) => p.type === 'config');
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to fetch presets:', error.message);
      }
    } finally {
      this.presetsLoading = false;
      this.configPresetsLoading = false;
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
        console.error('Failed to fetch skills:', error.message);
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
        console.error('Failed to create skill:', error.message);
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
        console.error('Failed to update skill:', error.message);
      }
    }
  }

  private async _deleteSkill(slug: string) {
    try {
      await api(`/api/skills/${slug}`, { method: 'DELETE' });
      this.skills = this.skills.filter((s) => s.slug !== slug);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to delete skill:', error.message);
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
        console.error('Failed to import skill:', error.message);
      }
    }
  }

  /* ---- Config preset actions ---- */

  private async _activatePreset(preset: Preset) {
    const endpointMap: Record<string, string> = {
      agent: '/api/agent/preset',
      toolset: '/api/toolset/select',
    };
    const endpoint = endpointMap[preset.type] ?? '/api/config-presets/switch';

    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ preset: preset.name }),
      });
      await this._fetchPresets();
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Failed to activate preset:', error.message);
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

  private get _identityPresets(): Preset[] {
    switch (this.identityTab) {
      case 'personas':
        return this.presetAgents;
      case 'toolsets':
        return this.presetToolsets;
      case 'mcp':
        return this.presetMcp;
      default:
        return [];
    }
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
        <div class="tabs">
          <div class="tab ${this.identityTab === 'personas' ? 'active' : ''}"
               @click=${() => { this.identityTab = 'personas'; }}>Personas</div>
          <div class="tab ${this.identityTab === 'toolsets' ? 'active' : ''}"
               @click=${() => { this.identityTab = 'toolsets'; }}>Toolsets</div>
          <div class="tab ${this.identityTab === 'mcp' ? 'active' : ''}"
               @click=${() => { this.identityTab = 'mcp'; }}>MCP</div>
        </div>
        ${this.presetsLoading
          ? html`<div class="loading">Loading presets</div>`
          : this._identityPresets.length === 0
            ? html`<div class="empty">
                <div class="empty-title">No ${this.identityTab}</div>
                <div class="empty-subtitle">No ${this.identityTab} presets configured yet.</div>
              </div>`
            : html`
                <div class="grid">
                  ${this._identityPresets.map((p) => this._renderPresetCard(p))}
                </div>
              `}
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
      </div>
    `;
  }

  /* ---- Section: Skills ---- */

  private _renderSkillsSection() {
    return html`
      <div class="section-block">
        <div class="section-header">Skills</div>

        <div class="toolbar">
          <input class="srch"
                 type="text"
                 placeholder="Search skills..."
                 .value=${this.skillSearch}
                 @input=${(e: InputEvent) => { this.skillSearch = (e.target as HTMLInputElement).value; }}>
          <button class="btn btn-p"
                  @click=${() => { this._resetForm(); this.showSkillForm = true; this.showImportForm = false; }}>
            Create Skill
          </button>
          <button class="btn"
                  @click=${() => { this.showImportForm = !this.showImportForm; this.showSkillForm = false; this._resetForm(); }}>
            Import SKILL.md
          </button>
        </div>

        ${this.showImportForm ? this._renderImportForm() : nothing}
        ${this.showSkillForm ? this._renderSkillForm() : nothing}

        ${this.skillsLoading
          ? html`<div class="loading">Loading skills</div>`
          : this._filteredSkills.length === 0
            ? html`<div class="empty">
                <div class="empty-title">${this.skills.length ? 'No matching skills' : 'No skills'}</div>
                <div class="empty-subtitle">${this.skills.length ? 'Try a different search term.' : 'Create a skill or import from SKILL.md.'}</div>
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
          <button class="btn" @click=${() => this._editSkill(skill)}>Edit</button>
          <button class="btn btn-danger" @click=${() => this._deleteSkill(skill.slug)}>Delete</button>
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

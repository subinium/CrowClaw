import type { ParsedSkillFile } from '@crowclaw/core';
import type { StoredSkillDraft, SkillStore } from './index.js';

export type SkillSource = 'builtin' | 'learned' | 'local' | 'installed';

export interface SkillRegistryOptions {
  skillStore?: SkillStore;
  localSkillDirs?: string[];
  disabledSlugs?: Set<string>;
}

export class SkillRegistry {
  private builtInSkills: ParsedSkillFile[] = [];
  private learnedSkills: ParsedSkillFile[] = [];
  private localSkills: ParsedSkillFile[] = [];
  private disabledSlugs: Set<string>;
  private readonly skillStore?: SkillStore;
  private titleMap = new Map<string, string>();
  private statusMap = new Map<string, string>();

  constructor(options: SkillRegistryOptions = {}) {
    this.skillStore = options.skillStore;
    this.disabledSlugs = options.disabledSlugs ?? new Set();
  }

  /** Load built-in skills from StoredSkillDraft[] */
  loadBuiltIn(drafts: StoredSkillDraft[]): void {
    this.builtInSkills = drafts
      .filter(d => d.status === 'published' || !d.status)
      .map(d => draftToSkillFile(d, 'builtin'));
    for (const d of drafts) {
      this.titleMap.set(d.slug, d.title);
      this.statusMap.set(d.slug, d.status ?? 'published');
    }
  }

  /** Refresh learned skills from skill store */
  async refreshLearned(): Promise<void> {
    if (!this.skillStore) return;
    const all = await this.skillStore.list();
    this.learnedSkills = all
      .filter(d => d.status === 'published')
      .map(d => draftToSkillFile(d, 'learned'));
    for (const d of all) {
      this.titleMap.set(d.slug, d.title);
      this.statusMap.set(d.slug, d.status);
    }
  }

  /** Add a single published skill (called when LearningPipeline publishes) */
  addPublishedSkill(draft: StoredSkillDraft): void {
    const existing = this.learnedSkills.findIndex(
      s => s.manifest.name === draft.slug
    );
    const parsed = draftToSkillFile(draft, 'learned');
    if (existing >= 0) {
      this.learnedSkills[existing] = parsed;
    } else {
      this.learnedSkills.push(parsed);
    }
    this.titleMap.set(draft.slug, draft.title);
    this.statusMap.set(draft.slug, draft.status);
  }

  /** Remove a learned skill (unpublish) */
  removeLearnedSkill(slug: string): void {
    this.learnedSkills = this.learnedSkills.filter(
      s => s.manifest.name !== slug
    );
  }

  /** Set local filesystem skills */
  setLocalSkills(skills: ParsedSkillFile[]): void {
    this.localSkills = skills;
    // Populate title/status metadata for local skills
    for (const skill of skills) {
      const slug = skill.manifest.name;
      if (!this.titleMap.has(slug)) {
        // Derive display title from slug: 'deploy-vercel' → 'Deploy Vercel'
        this.titleMap.set(slug, slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
      }
      if (!this.statusMap.has(slug)) {
        this.statusMap.set(slug, 'published');
      }
    }
  }

  /** Enable/disable a skill */
  toggleSkill(slug: string, enabled: boolean): void {
    if (enabled) {
      this.disabledSlugs.delete(slug);
    } else {
      this.disabledSlugs.add(slug);
    }
  }

  /** Resolve all enabled skills into ParsedSkillFile[] for AgentLoop */
  resolve(): ParsedSkillFile[] {
    const all = [...this.builtInSkills, ...this.learnedSkills, ...this.localSkills];
    // Deduplicate by name (learned overrides built-in)
    const seen = new Map<string, ParsedSkillFile>();
    // Local > Learned > Built-in (later sources override)
    for (const skill of all) {
      seen.set(skill.manifest.name, skill);
    }
    return [...seen.values()].filter(
      s => !this.disabledSlugs.has(s.manifest.name)
    );
  }

  /** Resolve all skills (including disabled) with their enabled state */
  resolveAll(): Array<{ skill: ParsedSkillFile; enabled: boolean }> {
    const all = [...this.builtInSkills, ...this.learnedSkills, ...this.localSkills];
    const seen = new Map<string, ParsedSkillFile>();
    for (const skill of all) {
      seen.set(skill.manifest.name, skill);
    }
    return [...seen.values()].map((s) => ({
      skill: s,
      enabled: !this.disabledSlugs.has(s.manifest.name),
    }));
  }

  /** Get the display title for a skill slug (falls back to undefined) */
  getDisplayTitle(slug: string): string | undefined {
    return this.titleMap.get(slug);
  }

  /** Get the status for a skill slug (falls back to undefined) */
  getStatus(slug: string): string | undefined {
    return this.statusMap.get(slug);
  }

  /** Get stats */
  stats(): { builtin: number; learned: number; local: number; disabled: number; total: number } {
    const resolved = this.resolve();
    return {
      builtin: this.builtInSkills.length,
      learned: this.learnedSkills.length,
      local: this.localSkills.length,
      disabled: this.disabledSlugs.size,
      total: resolved.length,
    };
  }
}

/** Convert StoredSkillDraft to ParsedSkillFile */
function draftToSkillFile(draft: StoredSkillDraft, source: SkillSource): ParsedSkillFile {
  return {
    manifest: {
      name: draft.slug,
      description: draft.summary,
      triggers: draft.triggerPhrases,
      tools: [],
      category: source,
    },
    instructions: draft.steps.join('\n'),
    raw: draft.markdown || '',
  };
}

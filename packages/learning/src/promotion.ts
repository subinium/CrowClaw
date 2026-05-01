/**
 * SkillPromotionEngine (v0.8.0 #238).
 *
 * Closes the self-improvement loop: drafts that recur N times in the same
 * workspace, or are tagged with explicit "remember this" language, get
 * auto-promoted into a real SKILL.md the registry can pick up on its next
 * refresh.
 *
 * Decoupled from runtime-node and the EventBus type by accepting a plain
 * `{ emit }` shape — keeps `@crowclaw/learning` runtime-agnostic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { LearningPipeline, StoredSkillDraft } from './index.js';
import type { SkillRegistry } from './skill-registry.js';
import { renderSkillFile, type SkillManifest } from '@crowclaw/core';

export interface PromotionCriteria {
  /** Same fingerprint seen this many times → auto-promote. Default 3. */
  recurrenceThreshold: number;
  /** User said one of these (case-insensitive substring) → instant promote. */
  explicitTriggers: string[];
  /** Skip auto-promote when the draft involves no tools (probably trivial). Default 1. */
  minToolCount: number;
}

const DEFAULT_CRITERIA: PromotionCriteria = {
  recurrenceThreshold: 3,
  explicitTriggers: ['remember this', 'save this as a skill', 'skill this', 'save this'],
  minToolCount: 1,
};

export interface PromotionEventBus {
  emit(type: string, data: Record<string, unknown>): void;
}

export interface PromotionInput {
  /** The persisted draft returned by `LearningPipeline.captureDraft` / `autoCapture`. */
  draft: StoredSkillDraft;
  /** Stable fingerprint computed by `buildAutoCaptureDigest`. */
  fingerprint: string;
  /** Tool sequence — used to gate against `minToolCount`. */
  toolSequence: string[];
  /** Original user message for explicit-trigger detection. */
  userMessage: string;
}

/**
 * In-memory recurrence counter. Production runtimes can pass a custom
 * `PromotionStateStore` to persist counts across restarts; tests use the
 * default in-memory implementation.
 */
export interface PromotionStateStore {
  increment(fingerprint: string): Promise<number>;
  reset(fingerprint: string): Promise<void>;
}

export class InMemoryPromotionStateStore implements PromotionStateStore {
  private readonly counts = new Map<string, number>();

  async increment(fingerprint: string): Promise<number> {
    const next = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, next);
    return next;
  }

  async reset(fingerprint: string): Promise<void> {
    this.counts.delete(fingerprint);
  }
}

export interface SkillPromotionEngineOptions {
  /** Override where promoted skills are written. Default: ~/.crowclaw/skills/auto */
  autoSkillDir?: string;
  /** Override the recurrence-count store. Default: in-memory. */
  stateStore?: PromotionStateStore;
  /** Promotion thresholds & explicit triggers. */
  criteria?: Partial<PromotionCriteria>;
}

export class SkillPromotionEngine {
  private readonly criteria: PromotionCriteria;
  private readonly stateStore: PromotionStateStore;
  private readonly autoSkillDir: string;

  constructor(
    private readonly learning: LearningPipeline,
    private readonly skillRegistry: SkillRegistry,
    private readonly eventBus: PromotionEventBus | undefined,
    options: SkillPromotionEngineOptions = {},
  ) {
    this.criteria = { ...DEFAULT_CRITERIA, ...(options.criteria ?? {}) };
    this.stateStore = options.stateStore ?? new InMemoryPromotionStateStore();
    this.autoSkillDir = options.autoSkillDir ?? path.join(os.homedir(), '.crowclaw', 'skills', 'auto');
  }

  /**
   * Decide whether the just-captured draft should be promoted to a real skill.
   * Returns `true` iff promotion happened (so the caller can refresh state).
   */
  async evaluate(input: PromotionInput): Promise<boolean> {
    // 1. Explicit user trigger — promote immediately, regardless of recurrence.
    const lower = input.userMessage.toLowerCase();
    if (this.criteria.explicitTriggers.some((t) => lower.includes(t.toLowerCase()))) {
      await this.promote(input.draft, 'explicit');
      await this.stateStore.reset(input.fingerprint);
      return true;
    }

    // 2. Skip drafts with too few tools (likely trivial chat replies).
    if (input.toolSequence.length < this.criteria.minToolCount) {
      return false;
    }

    // 3. Recurrence-based auto-promotion.
    const count = await this.stateStore.increment(input.fingerprint);
    if (count >= this.criteria.recurrenceThreshold) {
      await this.promote(input.draft, 'recurrence');
      await this.stateStore.reset(input.fingerprint);
      return true;
    }
    return false;
  }

  /**
   * Convert a stored draft into a SKILL.md on disk and refresh the registry.
   * Two side-effects: a publish through the LearningPipeline (so the existing
   * draft row is marked published + visible in the dashboard's skills list),
   * and a SKILL.md write (so future runtimes that load `~/.crowclaw/skills`
   * pick it up without going through the JSON store).
   */
  private async promote(
    draft: StoredSkillDraft,
    source: 'explicit' | 'recurrence',
  ): Promise<void> {
    const manifest: SkillManifest = {
      name: draft.slug,
      description: draft.summary,
      triggers: draft.triggerPhrases,
      tools: draft.requiredTools,
      category: 'auto-promoted',
      version: String(draft.version ?? 1),
    };
    const instructions = draft.steps.length > 0
      ? draft.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : draft.markdown || draft.summary;
    const skillMarkdown = renderSkillFile(manifest, instructions);

    await fs.promises.mkdir(this.autoSkillDir, { recursive: true });
    const filePath = path.join(this.autoSkillDir, `${draft.slug}.md`);
    await fs.promises.writeFile(filePath, skillMarkdown, 'utf-8');

    // Publish the underlying draft so the registry's learned-skill cache
    // includes it on the next refresh. publishDraft already calls
    // skillRegistry.addPublishedSkill internally.
    try {
      await this.learning.publishDraft(draft.id);
    } catch {
      // If publish fails (e.g. draft already published), still emit so the
      // dashboard sees the promotion event. The SKILL.md write is the
      // authoritative artifact.
    }

    // Best-effort registry refresh — picks up the new SKILL.md if the
    // skill-dir loader is wired, and ensures the published draft is reflected.
    try {
      await this.skillRegistry.refreshLearned();
    } catch {
      /* registry refresh is best-effort */
    }

    this.eventBus?.emit('learning:draft_promoted', {
      draftId: draft.id,
      skillSlug: draft.slug,
      source,
      filePath,
    });
  }
}

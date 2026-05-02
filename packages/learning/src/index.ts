import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ConversationMessage } from '@crowclaw/core';

export interface CompletionSignal {
  completed: boolean;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
}

export interface SkillDraft {
  slug: string;
  title: string;
  summary: string;
  triggerPhrases: string[];
  steps: string[];
  sourceMessages: number;
}

export interface StoredSkillDraft extends SkillDraft {
  id: string;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  markdown: string;
  version?: number;
  ratings?: { helpful: number; unhelpful: number };
  pitfalls?: string[];
  verificationSteps?: string[];
  /** Tool names this skill needs (e.g., ['web.search', 'workspace.read']) */
  requiredTools?: string[];
}

export interface SkillStore {
  list(): Promise<StoredSkillDraft[]>;
  save(draft: StoredSkillDraft): Promise<void>;
  get(id: string): Promise<StoredSkillDraft | null>;
  /** Returns true if a draft with the given id exists. Used by upsert paths. */
  has?(id: string): Promise<boolean>;
}

export interface SkillMatch {
  skill: StoredSkillDraft;
  relevance: number;
  matchedTrigger?: string;
}

export class InMemorySkillStore implements SkillStore {
  private readonly drafts = new Map<string, StoredSkillDraft>();

  async list(): Promise<StoredSkillDraft[]> {
    return [...this.drafts.values()];
  }

  async save(draft: StoredSkillDraft): Promise<void> {
    this.drafts.set(draft.id, draft);
  }

  async get(id: string): Promise<StoredSkillDraft | null> {
    return this.drafts.get(id) ?? null;
  }

  async has(id: string): Promise<boolean> {
    return this.drafts.has(id);
  }
}

/**
 * Disk-based skill store that persists skills as JSON files.
 * Each skill is saved as `{basePath}/{id}.json`.
 */
export class FileSkillStore implements SkillStore {
  constructor(private readonly basePath: string) {}

  async list(): Promise<StoredSkillDraft[]> {
    try {
      const entries = await fs.promises.readdir(this.basePath);
      const jsonFiles = entries.filter((e: string) => e.endsWith('.json'));
      const results: StoredSkillDraft[] = [];
      for (const file of jsonFiles) {
        const content = await fs.promises.readFile(
          path.join(this.basePath, file),
          'utf-8',
        );
        try {
          results.push(JSON.parse(content) as StoredSkillDraft);
        } catch {
          // Skip malformed files
        }
      }
      return results;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async save(draft: StoredSkillDraft): Promise<void> {
    await fs.promises.mkdir(this.basePath, { recursive: true });
    const filePath = path.join(this.basePath, `${draft.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(draft, null, 2), 'utf-8');
  }

  async get(id: string): Promise<StoredSkillDraft | null> {
    const filePath = path.join(this.basePath, `${id}.json`);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as StoredSkillDraft;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async has(id: string): Promise<boolean> {
    const filePath = path.join(this.basePath, `${id}.json`);
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function mergeSkillDrafts(existing: StoredSkillDraft, incoming: SkillDraft): StoredSkillDraft {
  const merged: StoredSkillDraft = {
    ...existing,
    title: existing.title || incoming.title,
    summary: incoming.summary.length > existing.summary.length ? incoming.summary : existing.summary,
    triggerPhrases: unique([...existing.triggerPhrases, ...incoming.triggerPhrases]),
    steps: unique([...existing.steps, ...incoming.steps]),
    sourceMessages: existing.sourceMessages + incoming.sourceMessages,
    updatedAt: new Date().toISOString(),
    version: (existing.version ?? 1) + 1,
  };
  merged.markdown = renderSkillMarkdown(merged);
  return merged;
}

export function detectTaskCompletion(messages: ConversationMessage[]): CompletionSignal {
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const final = assistantMessages.at(-1)?.content.toLowerCase() ?? '';

  let score = 0;
  const signals: string[] = [];

  // Strong completion signals (+3 each)
  const strongPatterns = [
    'task complete',
    'successfully completed',
    'i\'ve finished',
    'all done',
    'here\'s the result',
    'the changes have been applied',
  ];
  for (const pattern of strongPatterns) {
    if (final.includes(pattern)) {
      score += 3;
      signals.push(pattern);
    }
  }

  // Medium signals (+2 each)
  const mediumPatterns = ['done', 'completed', 'finished', 'here you go', 'let me know if'];
  for (const pattern of mediumPatterns) {
    if (final.includes(pattern)) {
      score += 2;
      signals.push(pattern);
    }
  }

  // Weak signals (+1 each)
  if (assistantMessages.some((m) => m.content.includes('tool') && m.content.includes('returned'))) {
    score += 1;
    signals.push('tool-returned');
  }
  if (assistantMessages.length >= 3 && !final.includes('?')) {
    score += 1;
    signals.push('multi-turn-no-question');
  }

  // Negative signals (-2 each)
  if (final.includes('?') && !final.includes('let me know')) {
    score -= 2;
    signals.push('ends-with-question');
  }
  if (final.includes('error') || final.includes('failed')) {
    score -= 2;
    signals.push('error-signal');
  }
  if (final.includes('working on') || final.includes('in progress')) {
    score -= 2;
    signals.push('in-progress');
  }

  const confidence = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';
  return {
    completed: score >= 2,
    confidence,
    reason: `Score ${score}: ${signals.join(', ')}`,
  };
}

/**
 * Scores each skill against a query using trigger phrase matching and
 * title/summary word overlap. Returns top matches sorted by relevance.
 */
export function matchSkills(
  query: string,
  skills: StoredSkillDraft[],
  limit = 5,
): SkillMatch[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  const matches: SkillMatch[] = [];

  for (const skill of skills) {
    let relevance = 0;
    let matchedTrigger: string | undefined;

    // Check trigger phrases — exact substring match scores highest
    for (const trigger of skill.triggerPhrases) {
      const triggerLower = trigger.toLowerCase();
      if (queryLower.includes(triggerLower)) {
        relevance += 10;
        matchedTrigger = trigger;
      } else if (triggerLower.includes(queryLower)) {
        relevance += 8;
        matchedTrigger = trigger;
      } else {
        // Partial word overlap between trigger and query
        const triggerWords = triggerLower.split(/\s+/).filter((w) => w.length > 2);
        const overlap = queryWords.filter((w) => triggerWords.includes(w)).length;
        if (overlap > 0) {
          const overlapScore = (overlap / Math.max(queryWords.length, 1)) * 6;
          if (overlapScore > relevance) {
            relevance = Math.max(relevance, overlapScore);
            matchedTrigger = trigger;
          }
        }
      }
    }

    // Title word overlap
    const titleWords = skill.title.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const titleOverlap = queryWords.filter((w) => titleWords.includes(w)).length;
    relevance += (titleOverlap / Math.max(queryWords.length, 1)) * 4;

    // Summary word overlap (lower weight)
    const summaryWords = skill.summary.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const summaryOverlap = queryWords.filter((w) => summaryWords.includes(w)).length;
    relevance += (summaryOverlap / Math.max(queryWords.length, 1)) * 2;

    if (relevance > 0) {
      matches.push({ skill, relevance, matchedTrigger });
    }
  }

  matches.sort((a, b) => b.relevance - a.relevance);
  return matches.slice(0, limit);
}

export function extractSkillDraft(messages: ConversationMessage[], title = 'Generated CrowClaw Skill'): SkillDraft {
  const userPhrases = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter(Boolean);
  const assistantPhrases = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter(Boolean);

  const triggerPhrases = unique(userPhrases.slice(0, 5));
  const steps = unique([
    ...userPhrases.map((phrase, index) => `User intent ${index + 1}: ${phrase}`),
    ...assistantPhrases.slice(0, 5).map((phrase, index) => `Assistant response ${index + 1}: ${phrase}`),
  ]);

  const summarySource = [...assistantPhrases, ...userPhrases].join(' ').slice(0, 220);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'generated-skill';

  return {
    slug,
    title,
    summary: `Skill draft based on conversation: ${summarySource}`,
    triggerPhrases,
    steps,
    sourceMessages: messages.length,
  };
}

export function renderSkillMarkdown(draft: SkillDraft): string {
  return [
    `# ${draft.title}`,
    '',
    `Slug: ${draft.slug}`,
    '',
    '## Summary',
    draft.summary,
    '',
    '## Trigger phrases',
    ...draft.triggerPhrases.map((phrase) => `- ${phrase}`),
    '',
    '## Steps',
    ...draft.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Source messages: ${draft.sourceMessages}`,
  ].join('\n');
}

export { getBuiltInSkills, loadBuiltInSkills } from './built-in-skills.js';
export { SkillRegistry, type SkillSource, type SkillRegistryOptions } from './skill-registry.js';

import { SkillRegistry } from './skill-registry.js';
import type { SkillExtractionProvider } from './refinement.js';

export interface LearningPipelineOptions {
  extractionProvider?: SkillExtractionProvider;
  /** Number of unhelpful ratings before auto-unpublishing. Default: 3. */
  unpublishThreshold?: number;
}

export class LearningPipeline {
  private registry?: SkillRegistry;
  private readonly extractionProvider?: SkillExtractionProvider;
  private readonly unpublishThreshold: number;

  constructor(
    private readonly store: SkillStore,
    options?: LearningPipelineOptions,
  ) {
    this.extractionProvider = options?.extractionProvider;
    this.unpublishThreshold = options?.unpublishThreshold ?? 3;
  }

  setRegistry(registry: SkillRegistry): void {
    this.registry = registry;
  }

  /**
   * Compute a deterministic draft id from the title + message content fingerprint.
   * Same conversation + title → same id, so retried/double-invoked autoCapture
   * calls upsert into the same row instead of producing duplicate drafts (#36).
   */
  private computeDeterministicId(messages: ConversationMessage[], title: string, trigger?: string): string {
    const fingerprint = messages
      .map((m) => `${m.role}:${m.content}`)
      .join('\n');
    const key = `${title}:${trigger ?? 'auto'}:${fingerprint}`;
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 12);
    return `draft-${hash}`;
  }

  async captureDraft(
    messages: ConversationMessage[],
    title: string,
    options?: { trigger?: string },
  ): Promise<StoredSkillDraft> {
    const draftId = this.computeDeterministicId(messages, title, options?.trigger);
    const existing = await this.getExistingDraft(draftId);
    const now = new Date().toISOString();

    // Use LLM extraction if provider is available
    if (this.extractionProvider) {
      const llmDraft = await this.extractionProvider.extractSkill(messages);
      if (llmDraft) {
        const merged: StoredSkillDraft = {
          ...llmDraft,
          id: draftId,
          createdAt: existing?.createdAt ?? llmDraft.createdAt ?? now,
          updatedAt: now,
          status: existing?.status ?? llmDraft.status ?? 'draft',
          ratings: existing?.ratings ?? llmDraft.ratings ?? { helpful: 0, unhelpful: 0 },
          version: (existing?.version ?? llmDraft.version ?? 0) + (existing ? 1 : 0) || 1,
        };
        await this.store.save(merged);
        return merged;
      }
    }

    // Fall back to heuristic extraction
    const draft = extractSkillDraft(messages, title);
    const stored: StoredSkillDraft = {
      ...draft,
      id: draftId,
      status: existing?.status ?? 'draft',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      markdown: renderSkillMarkdown(draft),
      version: existing ? (existing.version ?? 1) + 1 : 1,
      ratings: existing?.ratings ?? { helpful: 0, unhelpful: 0 },
    };
    await this.store.save(stored);
    return stored;
  }

  /** Look up an existing draft by id, falling back to has()+get() on stores
   *  that don't implement has(). */
  private async getExistingDraft(id: string): Promise<StoredSkillDraft | null> {
    if (this.store.has) {
      const exists = await this.store.has(id);
      if (!exists) return null;
    }
    return this.store.get(id);
  }

  async publishDraft(id: string): Promise<StoredSkillDraft> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new Error(`Skill draft not found: ${id}`);
    }
    const published: StoredSkillDraft = {
      ...existing,
      status: 'published',
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(published);
    this.registry?.addPublishedSkill(published);
    return published;
  }

  async unpublishDraft(id: string): Promise<StoredSkillDraft> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new Error(`Skill draft not found: ${id}`);
    }
    const unpublished: StoredSkillDraft = {
      ...existing,
      status: 'draft',
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(unpublished);
    this.registry?.removeLearnedSkill(unpublished.slug);
    return unpublished;
  }

  async rateSkill(slug: string, rating: 'helpful' | 'unhelpful'): Promise<void> {
    const all = await this.store.list();
    const skill = all.find((s) => s.slug === slug);
    if (!skill) {
      throw new Error(`Skill not found: ${slug}`);
    }

    const ratings = skill.ratings ?? { helpful: 0, unhelpful: 0 };
    ratings[rating] += 1;

    const updated: StoredSkillDraft = {
      ...skill,
      ratings,
      updatedAt: new Date().toISOString(),
    };

    // Auto-unpublish if unhelpful ratings exceed threshold
    if (updated.status === 'published' && ratings.unhelpful >= this.unpublishThreshold) {
      updated.status = 'draft';
      this.registry?.removeLearnedSkill(updated.slug);
    }

    await this.store.save(updated);
  }

  async autoCapture(
    messages: ConversationMessage[],
    title?: string,
    options?: { trigger?: string },
  ): Promise<StoredSkillDraft | null> {
    const signal = detectTaskCompletion(messages);
    if (!signal.completed || signal.confidence === 'low') return null;
    return this.captureDraft(messages, title ?? 'auto-captured-skill', options);
  }

  async refineDraft(id: string, newMessages: ConversationMessage[]): Promise<StoredSkillDraft> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new Error(`Skill draft not found: ${id}`);
    }

    let refined: StoredSkillDraft;
    if (this.extractionProvider) {
      refined = await this.extractionProvider.refineSkill(existing, newMessages);
      // If LLM refinement returned unchanged draft, fall back to heuristic merge
      if (refined.version === existing.version && refined.steps.length === existing.steps.length) {
        const heuristic = extractSkillDraft(newMessages, existing.title);
        refined = mergeSkillDrafts(existing, heuristic);
      }
    } else {
      const heuristic = extractSkillDraft(newMessages, existing.title);
      refined = mergeSkillDrafts(existing, heuristic);
    }

    refined.id = existing.id;
    refined.slug = existing.slug || refined.slug;
    refined.status = existing.status;
    refined.createdAt = existing.createdAt;
    refined.ratings = existing.ratings ?? { helpful: 0, unhelpful: 0 };
    if (!refined.markdown) {
      refined.markdown = renderSkillMarkdown(refined);
    }

    await this.store.save(refined);
    if (refined.status === 'published') {
      this.registry?.addPublishedSkill(refined);
    }
    return refined;
  }

  listDrafts(): Promise<StoredSkillDraft[]> {
    return this.store.list();
  }

  async findRelevantSkills(query: string, limit?: number): Promise<SkillMatch[]> {
    const skills = await this.store.list();
    const published = skills.filter((s) => s.status === 'published');
    return matchSkills(query, published, limit);
  }
}

export {
  evaluateExpectedOutput,
  parseJsonlPrompts,
  runBatch,
  type BatchAssertionResult,
  type BatchExpectedOutput,
  type BatchPrompt,
  type BatchRunConfig,
  type BatchProgress,
  type BatchRunResult,
  type BatchRunSummary,
  type AgentRunFn as BatchAgentRunFn,
} from './batch-runner.js';

export {
  batchToTrajectories,
  resultToTrajectory,
  exportTrajectoryJsonl,
  exportShareGpt,
  trajectoryStats,
  type TrajectoryEntry,
  type TrajectoryTurn,
  type TrajectoryToolUsage,
  type TrajectoryExportOptions,
} from './trajectory.js';

export {
  buildExtractionPrompt,
  buildRefinementPrompt,
  parseSkillResponse,
  createLlmSkillExtractor,
  type SkillExtractionProvider,
} from './refinement.js';

export {
  compressTrajectory,
  type CompressionStrategy,
  type CompressedTrajectory,
} from './trajectory-compressor.js';

export {
  scoreTrajectory,
  type TrajectoryScore,
} from './trajectory-scorer.js';

export {
  exportDPO,
  exportSFT,
  filterByScore,
  rankByScore,
} from './rl-export.js';

export {
  AtroposEnv,
  defaultAtroposReward,
  type AtroposEnvConfig,
  type AtroposPrompt,
  type AtroposRegistration,
  type AtroposRewardFn,
  type AtroposRollout,
  type AtroposSubmitResult,
} from './atropos-env.js';

export {
  SkillMetricsTracker,
  type SkillUsageRecord,
  type SkillMetrics,
} from './skill-metrics.js';

export {
  skillSimilarity,
  findDuplicates,
  mergeSkills,
  type DedupResult,
} from './skill-dedup.js';

export {
  generateImprovementPlan,
  detectCompletionEnhanced,
  type ImprovementAction,
  type ImprovementPlan,
} from './auto-improver.js';

// v0.8.0 (#238) — self-improvement loop
export {
  buildAutoCaptureDigest,
  extractTriggerPhrases,
  abstractToolSequence,
  detectSuccessMarker,
  computeDraftFingerprint,
  type AutoCaptureDigest,
} from './auto-capture.js';

export {
  SkillPromotionEngine,
  InMemoryPromotionStateStore,
  type PromotionCriteria,
  type PromotionEventBus,
  type PromotionInput,
  type PromotionStateStore,
  type SkillPromotionEngineOptions,
} from './promotion.js';

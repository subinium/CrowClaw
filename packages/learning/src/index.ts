import * as fs from 'node:fs';
import * as path from 'node:path';
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
}

export interface SkillStore {
  list(): Promise<StoredSkillDraft[]>;
  save(draft: StoredSkillDraft): Promise<void>;
  get(id: string): Promise<StoredSkillDraft | null>;
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
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

export class LearningPipeline {
  private registry?: SkillRegistry;

  constructor(private readonly store: SkillStore) {}

  setRegistry(registry: SkillRegistry): void {
    this.registry = registry;
  }

  async captureDraft(messages: ConversationMessage[], title: string): Promise<StoredSkillDraft> {
    const draft = extractSkillDraft(messages, title);
    const now = new Date().toISOString();
    const stored: StoredSkillDraft = {
      ...draft,
      id: crypto.randomUUID(),
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      markdown: renderSkillMarkdown(draft),
    };
    await this.store.save(stored);
    return stored;
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

  async autoCapture(messages: ConversationMessage[], title?: string): Promise<StoredSkillDraft | null> {
    const signal = detectTaskCompletion(messages);
    if (!signal.completed || signal.confidence === 'low') return null;
    return this.captureDraft(messages, title ?? 'auto-captured-skill');
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
  parseJsonlPrompts,
  runBatch,
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

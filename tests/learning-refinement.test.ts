import { describe, it, expect } from 'vitest';
import type { ConversationMessage } from '@crowclaw/core';
import {
  buildExtractionPrompt,
  buildRefinementPrompt,
  parseSkillResponse,
  createLlmSkillExtractor,
  InMemorySkillStore,
  LearningPipeline,
  type StoredSkillDraft,
} from '../packages/learning/src/index.js';

const now = new Date().toISOString();

function msg(role: ConversationMessage['role'], content: string): ConversationMessage {
  return { role, content, createdAt: now };
}

const sampleMessages: ConversationMessage[] = [
  msg('user', 'deploy my Next.js app to Vercel'),
  msg('assistant', 'I ran vercel deploy and configured the environment variables. The deployment is live.'),
];

const validSkillJson = JSON.stringify({
  slug: 'deploy-nextjs-vercel',
  title: 'Deploy Next.js to Vercel',
  summary: 'Deploy a Next.js application to Vercel with environment variables.',
  triggerPhrases: ['deploy to vercel', 'vercel deployment', 'deploy next.js'],
  steps: ['Run vercel login', 'Configure env vars', 'Run vercel deploy'],
  pitfalls: ['Forgetting to set NODE_ENV', 'Missing build command in vercel.json'],
  verificationSteps: ['Check deployment URL returns 200', 'Verify env vars in dashboard'],
});

describe('buildExtractionPrompt', () => {
  it('produces a prompt containing conversation messages', () => {
    const prompt = buildExtractionPrompt(sampleMessages);
    expect(prompt).toContain('[user]: deploy my Next.js app to Vercel');
    expect(prompt).toContain('[assistant]:');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('slug');
    expect(prompt).toContain('triggerPhrases');
    expect(prompt).toContain('pitfalls');
    expect(prompt).toContain('verificationSteps');
  });

  it('handles empty conversation', () => {
    const prompt = buildExtractionPrompt([]);
    expect(prompt).toContain('Conversation:');
    expect(prompt).toContain('JSON');
  });
});

describe('buildRefinementPrompt', () => {
  it('includes existing skill and new conversation', () => {
    const existing: StoredSkillDraft = {
      id: 'test-id',
      slug: 'deploy-vercel',
      title: 'Deploy to Vercel',
      summary: 'Deploy apps to Vercel',
      triggerPhrases: ['deploy vercel'],
      steps: ['Run vercel deploy'],
      pitfalls: ['Check env vars'],
      verificationSteps: ['Verify URL'],
      sourceMessages: 2,
      status: 'published',
      createdAt: now,
      updatedAt: now,
      markdown: '',
    };

    const newMessages: ConversationMessage[] = [
      msg('user', 'also set up preview deployments'),
      msg('assistant', 'I configured preview branches in vercel.json.'),
    ];

    const prompt = buildRefinementPrompt(existing, newMessages);
    expect(prompt).toContain('deploy-vercel');
    expect(prompt).toContain('Run vercel deploy');
    expect(prompt).toContain('[user]: also set up preview deployments');
    expect(prompt).toContain('Merge');
  });
});

describe('parseSkillResponse', () => {
  it('parses valid JSON', () => {
    const result = parseSkillResponse(validSkillJson);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('deploy-nextjs-vercel');
    expect(result!.title).toBe('Deploy Next.js to Vercel');
    expect(result!.triggerPhrases).toHaveLength(3);
    expect(result!.steps).toHaveLength(3);
    expect(result!.pitfalls).toHaveLength(2);
    expect(result!.verificationSteps).toHaveLength(2);
    expect(result!.status).toBe('draft');
    expect(result!.version).toBe(1);
    expect(result!.ratings).toEqual({ helpful: 0, unhelpful: 0 });
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const wrapped = '```json\n' + validSkillJson + '\n```';
    const result = parseSkillResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('deploy-nextjs-vercel');
  });

  it('parses JSON in plain code fences (no json tag)', () => {
    const wrapped = '```\n' + validSkillJson + '\n```';
    const result = parseSkillResponse(wrapped);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe('deploy-nextjs-vercel');
  });

  it('returns null for invalid JSON', () => {
    expect(parseSkillResponse('not json at all')).toBeNull();
  });

  it('returns null for explicit null response', () => {
    expect(parseSkillResponse('null')).toBeNull();
  });

  it('returns null for null inside code fences', () => {
    expect(parseSkillResponse('```json\nnull\n```')).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    const incomplete = JSON.stringify({ slug: 'test', title: 'Test' });
    expect(parseSkillResponse(incomplete)).toBeNull();
  });

  it('handles missing optional fields gracefully', () => {
    const minimal = JSON.stringify({
      slug: 'minimal-skill',
      title: 'Minimal Skill',
      summary: 'A minimal skill',
      triggerPhrases: ['do the thing'],
      steps: ['Step one'],
    });
    const result = parseSkillResponse(minimal);
    expect(result).not.toBeNull();
    expect(result!.pitfalls).toEqual([]);
    expect(result!.verificationSteps).toEqual([]);
  });
});

describe('createLlmSkillExtractor', () => {
  it('extracts a skill using mock LLM', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => validSkillJson;

    const extractor = createLlmSkillExtractor(mockLlm);
    const result = await extractor.extractSkill(sampleMessages);

    expect(result).not.toBeNull();
    expect(result!.slug).toBe('deploy-nextjs-vercel');
    expect(result!.sourceMessages).toBe(sampleMessages.length);
    expect(result!.markdown).toContain('# Deploy Next.js to Vercel');
  });

  it('returns null when LLM returns null', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => 'null';

    const extractor = createLlmSkillExtractor(mockLlm);
    const result = await extractor.extractSkill(sampleMessages);

    expect(result).toBeNull();
  });

  it('returns null when LLM returns invalid response', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => 'I cannot extract a skill from this.';

    const extractor = createLlmSkillExtractor(mockLlm);
    const result = await extractor.extractSkill(sampleMessages);

    expect(result).toBeNull();
  });

  it('refines an existing skill with new messages', async () => {
    const refinedJson = JSON.stringify({
      slug: 'deploy-nextjs-vercel',
      title: 'Deploy Next.js to Vercel',
      summary: 'Deploy and configure a Next.js application on Vercel with preview branches.',
      triggerPhrases: ['deploy to vercel', 'vercel deployment', 'setup preview deploys'],
      steps: ['Run vercel login', 'Configure env vars', 'Run vercel deploy', 'Configure preview branches'],
      pitfalls: ['Forgetting NODE_ENV', 'Missing vercel.json config'],
      verificationSteps: ['Check deployment URL', 'Verify preview branch deploys'],
    });

    const mockLlm = async (_prompt: string): Promise<string> => refinedJson;

    const extractor = createLlmSkillExtractor(mockLlm);

    const existing: StoredSkillDraft = {
      id: 'existing-id',
      slug: 'deploy-nextjs-vercel',
      title: 'Deploy Next.js to Vercel',
      summary: 'Deploy a Next.js application to Vercel.',
      triggerPhrases: ['deploy to vercel'],
      steps: ['Run vercel login', 'Run vercel deploy'],
      sourceMessages: 3,
      status: 'published',
      createdAt: now,
      updatedAt: now,
      markdown: '',
      version: 1,
    };

    const newMessages: ConversationMessage[] = [
      msg('user', 'add preview branch support'),
      msg('assistant', 'Configured preview branches in vercel.json.'),
    ];

    const refined = await extractor.refineSkill(existing, newMessages);

    expect(refined.id).toBe('existing-id');
    expect(refined.status).toBe('published');
    expect(refined.version).toBe(2);
    expect(refined.steps).toHaveLength(4);
    expect(refined.triggerPhrases).toContain('setup preview deploys');
    expect(refined.sourceMessages).toBe(5);
    expect(refined.markdown).toContain('# Deploy Next.js to Vercel');
  });

  it('returns existing skill unchanged when refinement LLM fails', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => 'invalid response';

    const extractor = createLlmSkillExtractor(mockLlm);

    const existing: StoredSkillDraft = {
      id: 'existing-id',
      slug: 'test-skill',
      title: 'Test Skill',
      summary: 'A test skill',
      triggerPhrases: ['test'],
      steps: ['Step 1'],
      sourceMessages: 2,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      markdown: '',
      version: 1,
    };

    const refined = await extractor.refineSkill(existing, [msg('user', 'hello')]);

    expect(refined).toBe(existing);
  });
});

describe('rateSkill', () => {
  it('accumulates helpful ratings', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const draft = await pipeline.captureDraft(sampleMessages, 'Test Skill');
    await pipeline.publishDraft(draft.id);

    await pipeline.rateSkill(draft.slug, 'helpful');
    await pipeline.rateSkill(draft.slug, 'helpful');

    const all = await pipeline.listDrafts();
    const skill = all.find((s) => s.slug === draft.slug);
    expect(skill!.ratings!.helpful).toBe(2);
    expect(skill!.ratings!.unhelpful).toBe(0);
    expect(skill!.status).toBe('published');
  });

  it('accumulates unhelpful ratings', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const draft = await pipeline.captureDraft(sampleMessages, 'Test Skill');
    await pipeline.publishDraft(draft.id);

    await pipeline.rateSkill(draft.slug, 'unhelpful');
    await pipeline.rateSkill(draft.slug, 'unhelpful');

    const all = await pipeline.listDrafts();
    const skill = all.find((s) => s.slug === draft.slug);
    expect(skill!.ratings!.unhelpful).toBe(2);
    expect(skill!.status).toBe('published');
  });

  it('auto-unpublishes after threshold unhelpful ratings', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store, { unpublishThreshold: 3 });

    const draft = await pipeline.captureDraft(sampleMessages, 'Test Skill');
    await pipeline.publishDraft(draft.id);

    await pipeline.rateSkill(draft.slug, 'unhelpful');
    await pipeline.rateSkill(draft.slug, 'unhelpful');
    await pipeline.rateSkill(draft.slug, 'unhelpful');

    const all = await pipeline.listDrafts();
    const skill = all.find((s) => s.slug === draft.slug);
    expect(skill!.status).toBe('draft');
  });

  it('auto-unpublishes with custom threshold', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store, { unpublishThreshold: 2 });

    const draft = await pipeline.captureDraft(sampleMessages, 'Test Skill');
    await pipeline.publishDraft(draft.id);

    await pipeline.rateSkill(draft.slug, 'unhelpful');
    // Still published after 1
    let all = await pipeline.listDrafts();
    expect(all.find((s) => s.slug === draft.slug)!.status).toBe('published');

    await pipeline.rateSkill(draft.slug, 'unhelpful');
    // Unpublished after 2
    all = await pipeline.listDrafts();
    expect(all.find((s) => s.slug === draft.slug)!.status).toBe('draft');
  });

  it('throws for nonexistent skill', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    await expect(pipeline.rateSkill('nonexistent', 'helpful')).rejects.toThrow('Skill not found');
  });
});

describe('LearningPipeline with LLM extraction provider', () => {
  it('uses LLM provider when available', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => validSkillJson;
    const extractor = createLlmSkillExtractor(mockLlm);

    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store, { extractionProvider: extractor });

    const draft = await pipeline.captureDraft(sampleMessages, 'Ignored Title');

    // LLM-extracted skill uses LLM output, not heuristic
    expect(draft.slug).toBe('deploy-nextjs-vercel');
    expect(draft.title).toBe('Deploy Next.js to Vercel');
    expect(draft.pitfalls).toHaveLength(2);
    expect(draft.verificationSteps).toHaveLength(2);
  });

  it('falls back to heuristic when LLM returns null', async () => {
    const mockLlm = async (_prompt: string): Promise<string> => 'null';
    const extractor = createLlmSkillExtractor(mockLlm);

    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store, { extractionProvider: extractor });

    const draft = await pipeline.captureDraft(sampleMessages, 'Heuristic Title');

    // Fell back to heuristic — uses the title we passed
    expect(draft.title).toBe('Heuristic Title');
    expect(draft.slug).toBe('heuristic-title');
  });

  it('falls back to heuristic when no provider is set', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const draft = await pipeline.captureDraft(sampleMessages, 'Heuristic Only');

    expect(draft.title).toBe('Heuristic Only');
    expect(draft.slug).toBe('heuristic-only');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildAutoCaptureDigest,
  computeDraftFingerprint,
  detectSuccessMarker,
  extractTriggerPhrases,
  abstractToolSequence,
  InMemoryPromotionStateStore,
  InMemorySkillStore,
  LearningPipeline,
  SkillPromotionEngine,
  SkillRegistry,
  type StoredSkillDraft,
} from '../packages/learning/src/index.js';
import { createLearningProposeSkillTool } from '../packages/tools/src/learning-propose-skill.js';
import { createLearningReviseSkillTool } from '../packages/tools/src/learning-revise-skill.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { parseSkillFile } from '../packages/core/src/skill-manifest.js';
import type { ToolExecutionContext } from '../packages/core/src/index.js';


class TestEventBus {
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  emit(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, data });
  }
}

const ts = (i = 0) => new Date(Date.now() + i).toISOString();
const ctx = (sessionId = 'test-session'): ToolExecutionContext => ({
  agentId: 'a',
  sessionId,
});

describe('self-improvement: auto-capture digest', () => {
  it('extracts trigger phrases skipping stop words', () => {
    const phrases = extractTriggerPhrases('Please deploy the CrowClaw service to Vercel for me');
    expect(phrases.length).toBeGreaterThan(0);
    // Should include a bi-gram involving distinctive tokens
    expect(phrases.some((p) => p.includes('crowclaw') || p.includes('vercel'))).toBe(true);
    // Stop words should not lead a phrase
    expect(phrases.every((p) => !p.startsWith('the ') && !p.startsWith('please '))).toBe(true);
  });

  it('abstracts tool sequence and collapses adjacent duplicates', () => {
    const sequence = abstractToolSequence([
      { name: 'web.fetch' },
      { name: 'web.fetch' },
      { name: 'workspace.write' },
      { name: 'web.fetch' },
    ]);
    expect(sequence).toEqual(['web.fetch', 'workspace.write', 'web.fetch']);
  });

  it('detects success markers in the last assistant turn', () => {
    expect(detectSuccessMarker([
      { role: 'user', content: 'do it', createdAt: ts() },
      { role: 'assistant', content: 'All done. Task completed successfully.', createdAt: ts(1) },
    ])).toBe(true);
    expect(detectSuccessMarker([
      { role: 'user', content: 'do it', createdAt: ts() },
      { role: 'assistant', content: 'Working on it...', createdAt: ts(1) },
    ])).toBe(false);
  });

  it('produces stable fingerprints regardless of trigger order', () => {
    const a = computeDraftFingerprint(['deploy crowclaw', 'verify build'], ['terminal.exec', 'web.fetch']);
    const b = computeDraftFingerprint(['verify build', 'deploy crowclaw'], ['terminal.exec', 'web.fetch']);
    expect(a).toBe(b);
    const c = computeDraftFingerprint(['deploy crowclaw'], ['terminal.exec', 'web.fetch']);
    expect(c).not.toBe(a);
  });

  it('builds a digest from messages + tool calls', () => {
    const digest = buildAutoCaptureDigest({
      messages: [
        { role: 'user', content: 'deploy crowclaw to vercel', createdAt: ts() },
        { role: 'assistant', content: 'All done. Deployed successfully.', createdAt: ts(1) },
      ],
      toolCalls: [{ name: 'terminal.exec' }, { name: 'web.fetch' }],
    });
    expect(digest.successMarker).toBe(true);
    expect(digest.toolSequence).toEqual(['terminal.exec', 'web.fetch']);
    expect(digest.fingerprint.length).toBeGreaterThan(0);
    expect(digest.userMessage).toBe('deploy crowclaw to vercel');
  });
});

describe('self-improvement: SkillPromotionEngine', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowclaw-promo-'));
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function makeDraft(pipeline: LearningPipeline, slug: string): Promise<StoredSkillDraft> {
    return pipeline.captureDraft([
      { role: 'user', content: `do ${slug}`, createdAt: ts() },
      { role: 'assistant', content: 'all done', createdAt: ts(1) },
    ], slug);
  }

  it('auto-promotes after 3 recurrences of the same fingerprint', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);
    const registry = new SkillRegistry({ skillStore: store });
    pipeline.setRegistry(registry);

    const eventBus = new TestEventBus();
    const engine = new SkillPromotionEngine(pipeline, registry, eventBus, {
      autoSkillDir: tempDir,
      criteria: { recurrenceThreshold: 3, explicitTriggers: [], minToolCount: 1 },
    });

    const draft = await makeDraft(pipeline, 'recurring-task');
    const fingerprint = 'fp-recurring-1';
    const toolSequence = ['web.fetch'];

    const r1 = await engine.evaluate({ draft, fingerprint, toolSequence, userMessage: 'do task' });
    const r2 = await engine.evaluate({ draft, fingerprint, toolSequence, userMessage: 'do task' });
    expect(r1).toBe(false);
    expect(r2).toBe(false);

    const r3 = await engine.evaluate({ draft, fingerprint, toolSequence, userMessage: 'do task' });
    expect(r3).toBe(true);

    // SKILL.md should now exist
    const skillFile = path.join(tempDir, `${draft.slug}.md`);
    expect(fs.existsSync(skillFile)).toBe(true);
    const content = fs.readFileSync(skillFile, 'utf-8');
    expect(content).toContain(`name: ${draft.slug}`);

    // Event emitted
    const promoted = eventBus.events.find((e) => e.type === 'learning:draft_promoted');
    expect(promoted).toBeDefined();
    expect(promoted?.data.skillSlug).toBe(draft.slug);
    expect(promoted?.data.source).toBe('recurrence');
  });

  it('promotes immediately on explicit trigger', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);
    const registry = new SkillRegistry({ skillStore: store });
    pipeline.setRegistry(registry);

    const eventBus = new TestEventBus();
    const engine = new SkillPromotionEngine(pipeline, registry, eventBus, {
      autoSkillDir: tempDir,
      criteria: { recurrenceThreshold: 3, explicitTriggers: ['save this as a skill'], minToolCount: 1 },
    });

    const draft = await makeDraft(pipeline, 'instant-task');
    const result = await engine.evaluate({
      draft,
      fingerprint: 'fp-instant',
      toolSequence: ['web.fetch'],
      userMessage: 'great, save this as a skill for next time',
    });
    expect(result).toBe(true);
    const promoted = eventBus.events.find((e) => e.type === 'learning:draft_promoted');
    expect(promoted?.data.source).toBe('explicit');
  });

  it('skips promotion when toolSequence is below minToolCount', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);
    const registry = new SkillRegistry({ skillStore: store });
    pipeline.setRegistry(registry);

    const engine = new SkillPromotionEngine(pipeline, registry, undefined, {
      autoSkillDir: tempDir,
      stateStore: new InMemoryPromotionStateStore(),
      criteria: { recurrenceThreshold: 1, explicitTriggers: [], minToolCount: 1 },
    });

    const draft = await makeDraft(pipeline, 'trivial');
    const result = await engine.evaluate({
      draft,
      fingerprint: 'fp-trivial',
      toolSequence: [], // no tools → skip
      userMessage: 'just chatting',
    });
    expect(result).toBe(false);
  });
});

describe('self-improvement: agent-authored skill tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowclaw-tools-'));
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('learning.proposeSkill writes a SKILL.md draft and emits agent_proposed', async () => {
    const eventBus = new TestEventBus();
    const tool = createLearningProposeSkillTool({ draftDir: tempDir, eventBus });

    const result = await tool.execute({
      name: 'Build Weekly Report',
      description: 'Compile a weekly report from GitHub activity.',
      triggers: ['weekly report', 'compile report'],
      instructions: '1. Fetch recent commits.\n2. Summarize per author.\n3. Send to Slack.',
      tags: ['reporting'],
    }, ctx());

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Skill draft written');

    const filePath = path.join(tempDir, 'build-weekly-report.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = parseSkillFile(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed?.manifest.name).toBe('build-weekly-report');
    expect(parsed?.manifest.triggers).toContain('weekly report');
    expect(parsed?.instructions).toContain('Fetch recent commits');

    const event = eventBus.events.find((e) => e.type === 'learning:agent_proposed');
    expect(event).toBeDefined();
    expect(event?.data.slug).toBe('build-weekly-report');
  });

  it('learning.proposeSkill rejects missing required fields', async () => {
    const tool = createLearningProposeSkillTool({ draftDir: tempDir });
    const r1 = await tool.execute({ description: 'x', triggers: ['y'], instructions: 'z' }, ctx());
    expect(r1.ok).toBe(false);
    const r2 = await tool.execute({ name: 'x', description: 'y', triggers: [], instructions: 'z' }, ctx());
    expect(r2.ok).toBe(false);
  });

  it('learning.reviseSkill appends to an existing skill instructions and emits skill_revised', async () => {
    // Seed a skill via proposeSkill first
    const eventBus = new TestEventBus();
    const propose = createLearningProposeSkillTool({ draftDir: tempDir, eventBus });
    await propose.execute({
      name: 'Deploy CrowClaw',
      description: 'Deploy the runtime to Vercel.',
      triggers: ['deploy crowclaw'],
      instructions: 'Run vercel deploy --prod.',
    }, ctx());

    const revise = createLearningReviseSkillTool({ skillDirs: [tempDir], eventBus });
    const r = await revise.execute({
      slug: 'deploy-crowclaw',
      instructionsDelta: 'Verify the deployment URL responds with 200 OK.',
      mode: 'append',
    }, ctx());

    expect(r.ok).toBe(true);
    const filePath = path.join(tempDir, 'deploy-crowclaw.md');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Run vercel deploy --prod.');
    expect(content).toContain('Verify the deployment URL responds with 200 OK.');

    const revised = eventBus.events.find((e) => e.type === 'learning:skill_revised');
    expect(revised?.data.slug).toBe('deploy-crowclaw');
    expect(revised?.data.mode).toBe('append');
  });

  it('learning.reviseSkill replaces instructions when mode is replace', async () => {
    const propose = createLearningProposeSkillTool({ draftDir: tempDir });
    await propose.execute({
      name: 'Sample Skill',
      description: 'Sample.',
      triggers: ['sample'],
      instructions: 'Old instructions.',
    }, ctx());

    const revise = createLearningReviseSkillTool({ skillDirs: [tempDir] });
    const r = await revise.execute({
      slug: 'sample-skill',
      instructionsDelta: 'Brand new instructions.',
      mode: 'replace',
    }, ctx());
    expect(r.ok).toBe(true);

    const content = fs.readFileSync(path.join(tempDir, 'sample-skill.md'), 'utf-8');
    expect(content).not.toContain('Old instructions.');
    expect(content).toContain('Brand new instructions.');
  });

  it('learning.reviseSkill returns an error when the slug is unknown', async () => {
    const revise = createLearningReviseSkillTool({ skillDirs: [tempDir] });
    const r = await revise.execute({
      slug: 'no-such-skill',
      instructionsDelta: 'something',
    }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output.toLowerCase()).toContain('not found');
  });
});

describe('self-improvement: dashboard endpoints', () => {
  it('GET /api/learning/drafts/pending returns pending drafts only', async () => {
    const runtime = createNodeRuntime();

    // Capture two drafts; publish one so it should be excluded from pending.
    const create1 = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Pending Draft',
        messages: [
          { role: 'user', content: 'do thing one' },
          { role: 'assistant', content: 'done' },
        ],
      }),
    }));
    const created1 = await create1.json() as { id: string };

    const create2 = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Promoted Draft',
        messages: [
          { role: 'user', content: 'do thing two' },
          { role: 'assistant', content: 'done' },
        ],
      }),
    }));
    const created2 = await create2.json() as { id: string };

    // Promote draft 2 via the new endpoint
    const promote = await runtime.fetch(new Request(`http://localhost/api/learning/drafts/${created2.id}/promote`, {
      method: 'POST',
    }));
    expect(promote.status).toBe(200);
    const promoteBody = await promote.json() as { ok: boolean; slug: string };
    expect(promoteBody.ok).toBe(true);
    expect(promoteBody.slug).toBeTruthy();

    // GET pending should now only include draft 1
    const pendingResp = await runtime.fetch(new Request('http://localhost/api/learning/drafts/pending'));
    expect(pendingResp.status).toBe(200);
    const pendingBody = await pendingResp.json() as { drafts: Array<{ id: string; source?: string }> };
    expect(Array.isArray(pendingBody.drafts)).toBe(true);
    const ids = pendingBody.drafts.map((d) => d.id);
    expect(ids).toContain(created1.id);
    expect(ids).not.toContain(created2.id);
    expect(pendingBody.drafts[0]?.source).toBe('auto-capture');
  });

  it('POST /api/learning/drafts/:id/reject succeeds without removing draft from store', async () => {
    const runtime = createNodeRuntime();
    const create = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Rejectable Draft',
        messages: [
          { role: 'user', content: 'do something' },
          { role: 'assistant', content: 'done' },
        ],
      }),
    }));
    const created = await create.json() as { id: string };

    const reject = await runtime.fetch(new Request(`http://localhost/api/learning/drafts/${created.id}/reject`, {
      method: 'POST',
    }));
    expect(reject.status).toBe(200);
    const rejectBody = await reject.json() as { ok: boolean };
    expect(rejectBody.ok).toBe(true);

    // 404 path — unknown id
    const reject404 = await runtime.fetch(new Request('http://localhost/api/learning/drafts/no-such-id/reject', {
      method: 'POST',
    }));
    expect(reject404.status).toBe(404);
  });
});

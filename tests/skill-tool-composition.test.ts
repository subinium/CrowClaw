import { describe, it, expect } from 'vitest';
import {
  getBuiltInSkills,
  InMemorySkillStore,
  LearningPipeline,
  type StoredSkillDraft,
} from '../packages/learning/src/index.js';
import { SkillRegistry } from '../packages/learning/src/skill-registry.js';

describe('StoredSkillDraft requiredTools field', () => {
  it('accepts requiredTools as an optional field', () => {
    const draft: StoredSkillDraft = {
      id: 'test-1',
      slug: 'test-skill',
      title: 'Test Skill',
      summary: 'A test skill',
      triggerPhrases: ['test'],
      steps: ['step 1'],
      sourceMessages: 0,
      status: 'published',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      markdown: '# Test',
      requiredTools: ['workspace.read', 'terminal.exec'],
    };

    expect(draft.requiredTools).toEqual(['workspace.read', 'terminal.exec']);
  });

  it('works without requiredTools (backward compatible)', () => {
    const draft: StoredSkillDraft = {
      id: 'test-2',
      slug: 'legacy-skill',
      title: 'Legacy Skill',
      summary: 'A skill without requiredTools',
      triggerPhrases: ['legacy'],
      steps: ['step 1'],
      sourceMessages: 0,
      status: 'published',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      markdown: '# Legacy',
    };

    expect(draft.requiredTools).toBeUndefined();
  });
});

describe('built-in skills requiredTools', () => {
  it('has requiredTools populated on at least 15 skills', () => {
    const skills = getBuiltInSkills();
    const withTools = skills.filter(s => s.requiredTools && s.requiredTools.length > 0);

    expect(withTools.length).toBeGreaterThanOrEqual(15);
  });

  it('all requiredTools entries are non-empty strings', () => {
    const skills = getBuiltInSkills();
    for (const skill of skills) {
      if (skill.requiredTools) {
        for (const tool of skill.requiredTools) {
          expect(typeof tool).toBe('string');
          expect(tool.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('code-review skill requires workspace.read, workspace.search, and git.diff', () => {
    const skills = getBuiltInSkills();
    const codeReview = skills.find(s => s.slug === 'code-review');
    expect(codeReview).toBeDefined();
    expect(codeReview!.requiredTools).toContain('workspace.read');
    expect(codeReview!.requiredTools).toContain('workspace.search');
    expect(codeReview!.requiredTools).toContain('git.diff');
  });

  it('deploy-vercel skill requires terminal.exec and workspace.read', () => {
    const skills = getBuiltInSkills();
    const deploy = skills.find(s => s.slug === 'deploy-vercel');
    expect(deploy).toBeDefined();
    expect(deploy!.requiredTools).toContain('terminal.exec');
    expect(deploy!.requiredTools).toContain('workspace.read');
  });

  it('write-tests skill requires workspace.read, workspace.write, and terminal.exec', () => {
    const skills = getBuiltInSkills();
    const writeTests = skills.find(s => s.slug === 'write-tests');
    expect(writeTests).toBeDefined();
    expect(writeTests!.requiredTools).toContain('workspace.read');
    expect(writeTests!.requiredTools).toContain('workspace.write');
    expect(writeTests!.requiredTools).toContain('terminal.exec');
  });

  it('debug-error skill requires workspace.read, workspace.search, and terminal.exec', () => {
    const skills = getBuiltInSkills();
    const debug = skills.find(s => s.slug === 'debug-error');
    expect(debug).toBeDefined();
    expect(debug!.requiredTools).toContain('workspace.read');
    expect(debug!.requiredTools).toContain('workspace.search');
    expect(debug!.requiredTools).toContain('terminal.exec');
  });

  it('web-scraping skill requires web tools', () => {
    const skills = getBuiltInSkills();
    const scraping = skills.find(s => s.slug === 'web-scraping');
    expect(scraping).toBeDefined();
    expect(scraping!.requiredTools).toContain('web.fetch');
    expect(scraping!.requiredTools).toContain('web.crawl');
    expect(scraping!.requiredTools).toContain('web.search');
  });
});

describe('SkillRegistry.getRequiredTools()', () => {
  it('returns a deduplicated sorted list of tools from all enabled skills', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'skill-a',
        slug: 'skill-a',
        title: 'Skill A',
        summary: 'First skill',
        triggerPhrases: ['a'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['workspace.read', 'terminal.exec'],
      },
      {
        id: 'skill-b',
        slug: 'skill-b',
        title: 'Skill B',
        summary: 'Second skill',
        triggerPhrases: ['b'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['terminal.exec', 'workspace.write'],
      },
    ]);

    const tools = registry.getRequiredTools();

    // Should be deduplicated and sorted
    expect(tools).toEqual(['terminal.exec', 'workspace.read', 'workspace.write']);
  });

  it('excludes tools from disabled skills', () => {
    const registry = new SkillRegistry({ disabledSlugs: new Set(['skill-b']) });
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'skill-a',
        slug: 'skill-a',
        title: 'Skill A',
        summary: 'First',
        triggerPhrases: ['a'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['workspace.read'],
      },
      {
        id: 'skill-b',
        slug: 'skill-b',
        title: 'Skill B',
        summary: 'Second',
        triggerPhrases: ['b'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['terminal.exec'],
      },
    ]);

    const tools = registry.getRequiredTools();
    expect(tools).toEqual(['workspace.read']);
    expect(tools).not.toContain('terminal.exec');
  });

  it('returns empty array when no skills have requiredTools', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'skill-no-tools',
        slug: 'skill-no-tools',
        title: 'No Tools',
        summary: 'Skill without required tools',
        triggerPhrases: ['x'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
      },
    ]);

    expect(registry.getRequiredTools()).toEqual([]);
  });

  it('merges requiredTools from multiple skill sources (builtin + learned)', async () => {
    const store = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore: store });
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'builtin-1',
        slug: 'builtin-1',
        title: 'Built-in Skill',
        summary: 'A built-in skill',
        triggerPhrases: ['builtin'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['workspace.read'],
      },
    ]);

    // Save and refresh a learned skill
    const learnedSkill: StoredSkillDraft = {
      id: 'learned-1',
      slug: 'learned-1',
      title: 'Learned Skill',
      summary: 'A learned skill',
      triggerPhrases: ['learned'],
      steps: ['step'],
      sourceMessages: 0,
      status: 'published',
      createdAt: now,
      updatedAt: now,
      markdown: '',
      requiredTools: ['web.fetch', 'workspace.read'],
    };
    await store.save(learnedSkill);
    await registry.refreshLearned();

    const tools = registry.getRequiredTools();
    expect(tools).toContain('workspace.read');
    expect(tools).toContain('web.fetch');
    // workspace.read should appear only once despite being in both
    expect(tools.filter(t => t === 'workspace.read')).toHaveLength(1);
  });
});

describe('draftToSkillFile includes requiredTools in manifest', () => {
  it('converts requiredTools to manifest.tools', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'test-1',
        slug: 'test-skill',
        title: 'Test Skill',
        summary: 'A skill with tools',
        triggerPhrases: ['test'],
        steps: ['step 1', 'step 2'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '# Test',
        requiredTools: ['workspace.read', 'terminal.exec'],
      },
    ]);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].manifest.tools).toEqual(['workspace.read', 'terminal.exec']);
  });

  it('produces empty tools array when requiredTools is undefined', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'test-2',
        slug: 'no-tools-skill',
        title: 'No Tools',
        summary: 'No tools defined',
        triggerPhrases: ['no-tools'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
      },
    ]);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].manifest.tools).toEqual([]);
  });

  it('includes tools in the full round-trip: draft -> registry -> resolve -> manifest', () => {
    const registry = new SkillRegistry();
    const skills = getBuiltInSkills();
    registry.loadBuiltIn(skills);

    const resolved = registry.resolve();
    const codeReview = resolved.find(s => s.manifest.name === 'code-review');
    expect(codeReview).toBeDefined();
    expect(codeReview!.manifest.tools).toContain('workspace.read');
    expect(codeReview!.manifest.tools).toContain('workspace.search');
    expect(codeReview!.manifest.tools).toContain('git.diff');
  });
});

describe('backward compatibility', () => {
  it('skills without requiredTools work in LearningPipeline', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const stored = await pipeline.captureDraft([
      { role: 'user', content: 'do something', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'done', createdAt: new Date().toISOString() },
    ], 'Legacy Skill');

    expect(stored.requiredTools).toBeUndefined();
    expect(stored.status).toBe('draft');

    const published = await pipeline.publishDraft(stored.id);
    expect(published.status).toBe('published');
  });

  it('skills without requiredTools resolve correctly in registry', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'legacy',
        slug: 'legacy',
        title: 'Legacy',
        summary: 'No tools',
        triggerPhrases: ['legacy'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        // No requiredTools field at all
      },
    ]);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].manifest.name).toBe('legacy');
    expect(resolved[0].manifest.tools).toEqual([]);
  });

  it('getRequiredTools ignores skills with no requiredTools', () => {
    const registry = new SkillRegistry();
    const now = new Date().toISOString();

    registry.loadBuiltIn([
      {
        id: 'with-tools',
        slug: 'with-tools',
        title: 'With Tools',
        summary: 'Has tools',
        triggerPhrases: ['with'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
        requiredTools: ['workspace.read'],
      },
      {
        id: 'without-tools',
        slug: 'without-tools',
        title: 'Without Tools',
        summary: 'No tools',
        triggerPhrases: ['without'],
        steps: ['step'],
        sourceMessages: 0,
        status: 'published',
        createdAt: now,
        updatedAt: now,
        markdown: '',
      },
    ]);

    const tools = registry.getRequiredTools();
    expect(tools).toEqual(['workspace.read']);
  });
});

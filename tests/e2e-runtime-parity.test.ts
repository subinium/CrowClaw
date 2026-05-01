/**
 * E2E Runtime: Hermes Parity Features via Node Runtime HTTP
 *
 * Unlike e2e-hermes-parity.test.ts (which tests library-level semantics with
 * in-memory stores and fake providers), this file exercises parity features
 * through the actual createNodeRuntime() fetch handler — the same HTTP surface
 * that real clients hit.
 *
 * Covered:
 * 1. Scheduler tick via HTTP
 * 2. Skills API — source and enabled fields
 * 3. Learning loop: draft → publish → skills API reflects learned skill
 * 4. Skill toggle via HTTP
 * 5. Checkpoint save/list/restore/replay via HTTP (routes pending — tests marked .todo)
 */
import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(url: string, body?: unknown, method?: string): Request {
  if (body === undefined) {
    return new Request(url, { method: method ?? 'GET' });
  }
  return new Request(url, {
    method: method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. Scheduler tick via HTTP
// ---------------------------------------------------------------------------

describe('E2E runtime: scheduler tick via HTTP', () => {
  it('creates a job and ticks — returns ok with results array', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Create a scheduled job
    const createRes = await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'rt-tick-job',
        everyMinutes: 1,
        task: 'say hello',
      }),
    );
    const created = await createRes.json() as { id: string; schedule: string; task: string };
    expect(created.id).toBe('rt-tick-job');
    expect(created.task).toBe('say hello');

    // The job was just created with nextRunAt in the future, so tick should
    // return empty results (no jobs are due yet).
    const tickRes = await runtime.fetch(
      json('http://localhost/api/scheduler/tick', {}, 'POST'),
    );
    const tickData = await tickRes.json() as { ok: boolean; results: unknown[] };
    expect(tickData.ok).toBe(true);
    expect(Array.isArray(tickData.results)).toBe(true);

    // Force the job to be due by directly manipulating the store
    const jobs = await runtime.schedulerStore.listJobs();
    const job = jobs.find((j) => j.id === 'rt-tick-job')!;
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await runtime.schedulerStore.saveJob(job);

    // Tick again — now it should execute
    const tick2Res = await runtime.fetch(
      json('http://localhost/api/scheduler/tick', {}, 'POST'),
    );
    const tick2Data = await tick2Res.json() as {
      ok: boolean;
      results: Array<{ jobId: string; ok: boolean; response?: string; executedAt: string }>;
    };
    expect(tick2Data.ok).toBe(true);
    expect(tick2Data.results.length).toBe(1);
    expect(tick2Data.results[0].jobId).toBe('rt-tick-job');
    expect(tick2Data.results[0].ok).toBe(true);
    expect(typeof tick2Data.results[0].executedAt).toBe('string');
  });

  it('lists jobs through GET /api/scheduler/jobs', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'list-job-1',
        everyMinutes: 5,
        task: 'first task',
      }),
    );
    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'list-job-2',
        everyMinutes: 10,
        task: 'second task',
      }),
    );

    const listRes = await runtime.fetch(new Request('http://localhost/api/scheduler/jobs'));
    const jobs = await listRes.json() as Array<{ id: string; task: string }>;
    expect(jobs.length).toBe(2);
    expect(jobs.map((j) => j.id).sort()).toEqual(['list-job-1', 'list-job-2']);
  });
});

// ---------------------------------------------------------------------------
// 2. Skills API — source and enabled fields
// ---------------------------------------------------------------------------

describe('E2E runtime: skills API', () => {
  it('returns skills with source and enabled fields', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/skills'));
    const data = await res.json() as {
      skills: Array<{ slug: string; source: string; enabled: boolean; status: string }>;
      count: number;
    };

    expect(data.count).toBeGreaterThan(0);
    expect(data.skills.length).toBe(data.count);

    // Every skill should have source field (builtin or learned)
    expect(data.skills.every((s) => s.source === 'builtin' || s.source === 'learned')).toBe(true);

    // Every skill should have boolean enabled field
    expect(data.skills.every((s) => typeof s.enabled === 'boolean')).toBe(true);

    // Built-in skills should be present
    const gitSkill = data.skills.find((s) => s.slug === 'git-commit-workflow');
    expect(gitSkill).toBeDefined();
    expect(gitSkill!.source).toBe('builtin');
    expect(gitSkill!.enabled).toBe(true);
  });

  it('skills include all expected built-in fields', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/skills'));
    const data = await res.json() as {
      skills: Array<{
        slug: string;
        title: string;
        summary: string;
        triggerPhrases: string[];
        steps: string[];
        status: string;
        source: string;
        enabled: boolean;
      }>;
    };

    const skill = data.skills[0];
    expect(typeof skill.slug).toBe('string');
    expect(typeof skill.title).toBe('string');
    expect(typeof skill.summary).toBe('string');
    expect(Array.isArray(skill.triggerPhrases)).toBe(true);
    expect(Array.isArray(skill.steps)).toBe(true);
    expect(typeof skill.status).toBe('string');
    expect(typeof skill.source).toBe('string');
    expect(typeof skill.enabled).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// 3. Learning loop: draft → publish → skills API reflects learned skill
// ---------------------------------------------------------------------------

describe('E2E runtime: learning loop via HTTP', () => {
  it('draft → publish → skills API shows learned skill', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Capture a draft via HTTP
    const draftRes = await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'auth-setup-flow',
        messages: [
          { role: 'user', content: 'set up auth flow with OAuth2' },
          { role: 'assistant', content: '1. Install next-auth\n2. Configure providers\n3. Add session wrapper\nAll done!' },
        ],
      }),
    );
    const draft = await draftRes.json() as {
      id: string;
      slug: string;
      status: string;
      title: string;
    };
    expect(draft.status).toBe('draft');
    expect(draft.slug).toBe('auth-setup-flow');
    expect(typeof draft.id).toBe('string');

    // Publish the draft
    const publishRes = await runtime.fetch(
      json(`http://localhost/api/learning/drafts/${draft.id}/publish`, {}, 'POST'),
    );
    const published = await publishRes.json() as { id: string; status: string };
    expect(published.status).toBe('published');
    expect(published.id).toBe(draft.id);

    // Skills API should now include the learned skill
    const skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    const skillsData = await skillsRes.json() as {
      skills: Array<{ slug: string; source: string; status: string }>;
    };
    const learnedSkills = skillsData.skills.filter((s) => s.source === 'learned');
    expect(learnedSkills.length).toBeGreaterThanOrEqual(1);

    const authSkill = skillsData.skills.find((s) => s.slug === 'auth-setup-flow');
    expect(authSkill).toBeDefined();
    expect(authSkill!.source).toBe('learned');
  });

  it('unpublish removes learned skill from skills API', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Create and publish a draft
    const draftRes = await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'temp-skill-rt',
        messages: [
          { role: 'user', content: 'do the thing' },
          { role: 'assistant', content: 'Done successfully.' },
        ],
      }),
    );
    const draft = await draftRes.json() as { id: string; slug: string };

    await runtime.fetch(
      json(`http://localhost/api/learning/drafts/${draft.id}/publish`, {}, 'POST'),
    );

    // Verify it's in skills
    let skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    let skills = (await skillsRes.json() as { skills: Array<{ slug: string; source: string }> }).skills;
    expect(skills.find((s) => s.slug === 'temp-skill-rt')).toBeDefined();

    // Unpublish
    await runtime.fetch(
      json(`http://localhost/api/learning/drafts/${draft.id}/unpublish`, {}, 'POST'),
    );

    // Verify it's either removed or reverted to draft status
    skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    skills = (await skillsRes.json() as { skills: Array<{ slug: string; source: string; status: string }> }).skills;
    const unpublished = skills.find((s) => s.slug === 'temp-skill-rt');
    // After unpublish, the draft still exists in learning store with status 'draft'
    // but it should be listed with draft status in skills (learned drafts are still listed)
    if (unpublished) {
      expect(unpublished.status).toBe('draft');
    }
  });

  it('list drafts returns all created drafts', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'draft-a',
        messages: [
          { role: 'user', content: 'task a' },
          { role: 'assistant', content: 'Done a.' },
        ],
      }),
    );
    await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'draft-b',
        messages: [
          { role: 'user', content: 'task b' },
          { role: 'assistant', content: 'Done b.' },
        ],
      }),
    );

    const listRes = await runtime.fetch(new Request('http://localhost/api/learning/drafts'));
    const drafts = await listRes.json() as Array<{ slug: string; status: string }>;
    expect(drafts.length).toBe(2);
    expect(drafts.map((d) => d.slug).sort()).toEqual(['draft-a', 'draft-b']);
  });
});

// ---------------------------------------------------------------------------
// 4. Skill toggle via HTTP
// ---------------------------------------------------------------------------

describe('E2E runtime: skill toggle via HTTP', () => {
  it('disabling a skill sets enabled=false in skills API', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Verify the skill starts enabled
    let skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    let data = await skillsRes.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    let gitSkill = data.skills.find((s) => s.slug === 'git-commit-workflow');
    expect(gitSkill?.enabled).toBe(true);

    // Disable the skill
    const toggleRes = await runtime.fetch(
      json('http://localhost/api/skills/git-commit-workflow/toggle', { enabled: false }),
    );
    const toggleData = await toggleRes.json() as { ok: boolean; slug: string; enabled: boolean };
    expect(toggleData.ok).toBe(true);
    expect(toggleData.slug).toBe('git-commit-workflow');
    expect(toggleData.enabled).toBe(false);

    // Verify through skills API
    skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    data = await skillsRes.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    gitSkill = data.skills.find((s) => s.slug === 'git-commit-workflow');
    expect(gitSkill?.enabled).toBe(false);
  });

  it('re-enabling a disabled skill restores enabled=true', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Disable
    await runtime.fetch(
      json('http://localhost/api/skills/code-review/toggle', { enabled: false }),
    );

    // Re-enable
    await runtime.fetch(
      json('http://localhost/api/skills/code-review/toggle', { enabled: true }),
    );

    // Verify
    const skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    const data = await skillsRes.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    const skill = data.skills.find((s) => s.slug === 'code-review');
    expect(skill?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Checkpoint save/list/restore/replay via HTTP
//    These routes don't exist in the runtime yet. Tests are written against
//    the planned API surface and marked .todo so they'll validate once the
//    routes are wired up.
// ---------------------------------------------------------------------------

describe('E2E runtime: checkpoint lifecycle via HTTP', () => {
  it('save checkpoint through runtime endpoint', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Seed a session
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-rt-e2e', { userMessage: 'first message' }),
    );

    // Save checkpoint
    const cpRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-rt-e2e/checkpoint', {
        label: 'before-change',
        trigger: 'manual',
      }),
    );
    const cpData = await cpRes.json() as { ok: boolean; checkpoint: { id: string } };
    expect(cpData.ok).toBe(true);
    expect(typeof cpData.checkpoint.id).toBe('string');
  });

  it('list checkpoints for a session', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Seed session and create checkpoint
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-list-e2e', { userMessage: 'msg' }),
    );
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-list-e2e/checkpoint', {
        label: 'cp-1',
        trigger: 'manual',
      }),
    );

    const listRes = await runtime.fetch(
      new Request('http://localhost/api/sessions/cp-list-e2e/checkpoints'),
    );
    const listData = await listRes.json() as { checkpoints: Array<{ id: string; label?: string }> };
    expect(listData.checkpoints.length).toBe(1);
  });

  it('restore checkpoint rolls back session state', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Seed session
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-restore-e2e', { userMessage: 'before' }),
    );

    // Save checkpoint
    const cpRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-restore-e2e/checkpoint', {
        label: 'snap',
        trigger: 'manual',
      }),
    );
    const cpData = await cpRes.json() as { ok: boolean; checkpoint: { id: string } };
    const cpId = cpData.checkpoint.id;

    // Advance session
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-restore-e2e', { userMessage: 'after' }),
    );

    // Restore
    const restoreRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-restore-e2e/restore', { checkpointId: cpId }),
    );
    const restoreData = await restoreRes.json() as { ok: boolean };
    expect(restoreData.ok).toBe(true);
  });

  it('replay creates a new session from checkpoint', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Seed + checkpoint
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-replay-e2e', { userMessage: 'base' }),
    );
    const cpRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-replay-e2e/checkpoint', {
        label: 'replay-point',
        trigger: 'manual',
      }),
    );
    const cpData = await cpRes.json() as { ok: boolean; checkpoint: { id: string } };

    // Replay
    const replayRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-replay-e2e/replay', {
        checkpointId: cpData.checkpoint.id,
        newSessionId: 'replayed-session',
      }),
    );
    const replayData = await replayRes.json() as { ok: boolean; sessionId: string };
    expect(replayData.ok).toBe(true);
    expect(replayData.sessionId).toBe('replayed-session');
  });
});

// ---------------------------------------------------------------------------
// 6. Integration: combined parity flow through runtime
// ---------------------------------------------------------------------------

describe('E2E runtime: combined parity flow', () => {
  it('session → learn → publish → toggle → verify through runtime HTTP', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // 1. Create a session (agent processes a message)
    const sessionRes = await runtime.fetch(
      json('http://localhost/api/sessions/parity-flow', { userMessage: 'deploy to kubernetes' }),
    );
    const sessionData = await sessionRes.json() as { finalResponse: string; session: { messages: unknown[] } };
    expect(sessionData.finalResponse).toBeTruthy();
    expect(sessionData.session.messages.length).toBeGreaterThan(0);

    // 2. Capture a learning draft from that conversation
    const draftRes = await runtime.fetch(
      json('http://localhost/api/learning/drafts', {
        title: 'k8s-deploy-runtime',
        messages: [
          { role: 'user', content: 'deploy to kubernetes' },
          { role: 'assistant', content: 'kubectl apply -f deployment.yaml done!' },
        ],
      }),
    );
    const draft = await draftRes.json() as { id: string; slug: string; status: string };
    expect(draft.status).toBe('draft');

    // 3. Publish the draft
    const publishRes = await runtime.fetch(
      json(`http://localhost/api/learning/drafts/${draft.id}/publish`, {}, 'POST'),
    );
    const published = await publishRes.json() as { status: string };
    expect(published.status).toBe('published');

    // 4. Verify it appears in skills
    let skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    let skillsData = await skillsRes.json() as { skills: Array<{ slug: string; source: string; enabled: boolean }> };
    const k8sSkill = skillsData.skills.find((s) => s.slug === 'k8s-deploy-runtime');
    expect(k8sSkill).toBeDefined();
    expect(k8sSkill!.source).toBe('learned');
    expect(k8sSkill!.enabled).toBe(true);

    // 5. Toggle the learned skill off
    await runtime.fetch(
      json('http://localhost/api/skills/k8s-deploy-runtime/toggle', { enabled: false }),
    );

    skillsRes = await runtime.fetch(new Request('http://localhost/api/skills'));
    skillsData = await skillsRes.json() as { skills: Array<{ slug: string; enabled: boolean }> };
    const disabled = skillsData.skills.find((s) => s.slug === 'k8s-deploy-runtime');
    expect(disabled?.enabled).toBe(false);

    // 6. Create a scheduled job and list
    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'parity-cron',
        everyMinutes: 30,
        task: 'run k8s health check',
      }),
    );
    const jobsRes = await runtime.fetch(new Request('http://localhost/api/scheduler/jobs'));
    const jobs = await jobsRes.json() as Array<{ id: string }>;
    expect(jobs.find((j) => j.id === 'parity-cron')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Scheduler execution overrides — skillSlugs, model, no state leakage
// ---------------------------------------------------------------------------

describe('E2E runtime: scheduler execution overrides', () => {
  it('scheduler tick does not mutate global configStore', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Set a global preset. Issue #217: the hardcoded `agentPresets` registry
    // is empty, so the preset is supplied inline (role/goal). The route
    // stores `name` verbatim regardless of whether it's a built-in entry.
    await runtime.fetch(
      json('http://localhost/api/agent/preset', {
        name: 'custom-coder',
        role: 'Coder',
        goal: 'Write code',
      }),
    );

    // Create a job with different preset override
    await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'override-test',
        everyMinutes: 1,
        task: 'run security scan',
      }),
    );

    // Tick
    const tick = await runtime.fetch(
      new Request('http://localhost/api/scheduler/tick', { method: 'POST' }),
    );
    const tickData = await tick.json() as { ok: boolean };
    expect(tickData.ok).toBe(true);

    // Global config should be unchanged
    const snapshot = await runtime.fetch(new Request('http://localhost/api/config/snapshot'));
    const config = await snapshot.json() as { activePreset: string | null };
    expect(config.activePreset).toBe('custom-coder');
  });

  it('multiple scheduler jobs run independently without state leakage', async () => {
    const { InMemorySchedulerStore } = await import('@crowclaw/scheduler');
    const schedulerStore = new InMemorySchedulerStore();
    const runtime = createNodeRuntime({ schedulerStore });

    // Create two jobs — manually set nextRunAt in the past so they're due
    const { createScheduledAgentJob } = await import('@crowclaw/scheduler');
    const jobA = createScheduledAgentJob({ id: 'job-a', schedule: 'every:1m', task: 'task a' });
    jobA.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await schedulerStore.saveJob(jobA);

    const jobB = createScheduledAgentJob({ id: 'job-b', schedule: 'every:1m', task: 'task b' });
    jobB.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await schedulerStore.saveJob(jobB);

    // Tick runs both
    const tick = await runtime.fetch(
      new Request('http://localhost/api/scheduler/tick', { method: 'POST' }),
    );
    const tickData = await tick.json() as { ok: boolean; results: Array<{ jobId: string; ok: boolean }> };
    expect(tickData.ok).toBe(true);
    expect(tickData.results.length).toBe(2);
    expect(tickData.results.every((r) => r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Rich scheduler job creation — all extended fields
// ---------------------------------------------------------------------------

describe('E2E runtime: rich scheduler job creation', () => {
  it('creates scheduler job with all rich fields via HTTP', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Issue #217: `agentPreset` on a job is now an opaque label — there is
    // no built-in registry to resolve it against. The job round-trips the
    // string through save/list intact regardless of whether the name maps
    // to anything.
    const res = await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'rich-job',
        schedule: 'every:30m',
        task: 'generate daily briefing',
        skillSlugs: ['git-commit-workflow', 'deploy-vercel'],
        toolsetPreset: 'minimal',
        agentPreset: 'custom-coder',
        model: 'gpt-4o-mini',
        maxRuns: 10,
        timeoutMs: 30000,
      }),
    );
    const job = await res.json() as {
      id: string;
      schedule: string;
      task: string;
      skillSlugs?: string[];
      toolsetPreset?: string;
      agentPreset?: string;
      model?: string;
      maxRuns?: number;
      timeoutMs?: number;
      enabled: boolean;
    };
    expect(job.id).toBe('rich-job');
    expect(job.schedule).toBe('every:30m');
    expect(job.task).toBe('generate daily briefing');
    expect(job.skillSlugs).toEqual(['git-commit-workflow', 'deploy-vercel']);
    expect(job.toolsetPreset).toBe('minimal');
    expect(job.agentPreset).toBe('custom-coder');
    expect(job.model).toBe('gpt-4o-mini');
    expect(job.maxRuns).toBe(10);
    expect(job.timeoutMs).toBe(30000);
    expect(job.enabled).toBe(true);

    // Verify GET returns same fields
    const listRes = await runtime.fetch(new Request('http://localhost/api/scheduler/jobs'));
    const jobs = await listRes.json() as Array<{
      id: string;
      skillSlugs?: string[];
      toolsetPreset?: string;
      agentPreset?: string;
      model?: string;
      maxRuns?: number;
    }>;
    const found = jobs.find((j) => j.id === 'rich-job');
    expect(found).toBeDefined();
    expect(found!.skillSlugs).toEqual(['git-commit-workflow', 'deploy-vercel']);
    expect(found!.toolsetPreset).toBe('minimal');
    expect(found!.agentPreset).toBe('custom-coder');
    expect(found!.model).toBe('gpt-4o-mini');
    expect(found!.maxRuns).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 9. Backward compatible everyMinutes format
// ---------------------------------------------------------------------------

describe('E2E runtime: scheduler backward compat', () => {
  it('scheduler still accepts legacy everyMinutes format', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    const res = await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'legacy-job',
        everyMinutes: 5,
        task: 'simple task',
      }),
    );
    const job = await res.json() as { id: string; schedule: string; task: string };
    expect(job.id).toBe('legacy-job');
    // everyMinutes: 5 should produce schedule: 'every:5m'
    expect(job.schedule).toBe('every:5m');
    expect(job.task).toBe('simple task');
  });

  it('schedule field takes precedence over everyMinutes when both provided', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    const res = await runtime.fetch(
      json('http://localhost/api/scheduler/jobs', {
        id: 'precedence-job',
        schedule: 'every:1h',
        everyMinutes: 10,
        task: 'which wins',
      }),
    );
    const job = await res.json() as { id: string; schedule: string };
    expect(job.id).toBe('precedence-job');
    expect(job.schedule).toBe('every:1h');
  });
});

// ---------------------------------------------------------------------------
// 10. Scheduler tick with job-level overrides — no config leakage
// ---------------------------------------------------------------------------

describe('E2E runtime: scheduler tick with overrides', () => {
  it('scheduler tick executes with job-level overrides (no config leakage)', async () => {
    const { InMemorySchedulerStore, createScheduledAgentJob } = await import('@crowclaw/scheduler');
    const schedulerStore = new InMemorySchedulerStore();
    const runtime = createNodeRuntime({ schedulerStore });

    // Set global preset. Issue #217: hardcoded `agentPresets` registry is
    // empty — the route accepts any name with inline role/goal and stores
    // the name verbatim.
    await runtime.fetch(
      json('http://localhost/api/agent/preset', {
        name: 'custom-researcher',
        role: 'Researcher',
        goal: 'Find info',
      }),
    );

    // Create job with different preset override label (just a string —
    // resolution against `agentPresets` is a no-op since the registry is
    // empty, but the job-level override is still recorded on the job).
    const job = createScheduledAgentJob({
      id: 'override-job',
      schedule: 'every:1m',
      task: 'run security scan',
      agentPreset: 'custom-auditor',
      skillSlugs: ['security-audit'],
    });
    job.nextRunAt = new Date(Date.now() - 60_000).toISOString();
    await schedulerStore.saveJob(job);

    // Tick
    const tickRes = await runtime.fetch(
      new Request('http://localhost/api/scheduler/tick', { method: 'POST' }),
    );
    const tickData = await tickRes.json() as {
      ok: boolean;
      results: Array<{ jobId: string; ok: boolean }>;
    };
    expect(tickData.ok).toBe(true);
    expect(tickData.results.length).toBe(1);
    expect(tickData.results[0].ok).toBe(true);

    // Global config unchanged
    const snapshot = await runtime.fetch(new Request('http://localhost/api/config/snapshot'));
    const config = await snapshot.json() as { activePreset: string | null };
    expect(config.activePreset).toBe('custom-researcher');
  });
});

// ---------------------------------------------------------------------------
// 11. Skills API returns SkillRegistry truth with stats
// ---------------------------------------------------------------------------

describe('E2E runtime: skills API registry truth', () => {
  it('/api/skills returns resolved skills with source, enabled, and stats', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    const res = await runtime.fetch(new Request('http://localhost/api/skills'));
    const data = await res.json() as {
      skills: Array<{
        slug: string;
        source: string;
        enabled: boolean;
        summary: string;
        title: string;
        triggerPhrases: string[];
        steps: string[];
        status: string;
      }>;
      count: number;
      stats: { builtin: number; learned: number; local: number; disabled: number; total: number };
    };

    // Has required shape
    expect(data.skills.length).toBeGreaterThan(0);
    expect(data.count).toBe(data.skills.length);

    const skill = data.skills[0];
    expect(skill).toHaveProperty('slug');
    expect(skill).toHaveProperty('source');
    expect(skill).toHaveProperty('enabled');
    expect(skill).toHaveProperty('summary');
    expect(skill).toHaveProperty('title');
    expect(skill).toHaveProperty('triggerPhrases');
    expect(skill).toHaveProperty('steps');
    expect(skill).toHaveProperty('status');

    // Has stats — 60 built-in skills
    expect(data.stats).toBeDefined();
    expect(data.stats.builtin).toBeGreaterThanOrEqual(50);

    // All skills have source field with valid values
    const sources = new Set(data.skills.map((s) => s.source));
    expect(sources.has('builtin')).toBe(true);

    // All enabled by default
    expect(data.skills.every((s) => s.enabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Provider withModel support — OpenAICompatibleProvider
// ---------------------------------------------------------------------------

describe('E2E runtime: provider withModel', () => {
  it('OpenAICompatibleProvider withModel returns new instance with different model', async () => {
    const { OpenAICompatibleProvider } = await import('@crowclaw/providers');

    const openai = new OpenAICompatibleProvider({
      apiKey: 'test',
      baseUrl: 'http://localhost',
      model: 'gpt-4o',
    });
    expect(openai.getModel()).toBe('gpt-4o');

    const overridden = openai.withModel('gpt-4o-mini');
    expect(overridden.getModel()).toBe('gpt-4o-mini');

    // Original unchanged (immutability)
    expect(openai.getModel()).toBe('gpt-4o');

    // Chained withModel
    const doubleOverride = overridden.withModel('gpt-3.5-turbo');
    expect(doubleOverride.getModel()).toBe('gpt-3.5-turbo');
    expect(overridden.getModel()).toBe('gpt-4o-mini');
    expect(openai.getModel()).toBe('gpt-4o');
  });

  it('withModel produces distinct provider instances', async () => {
    const { OpenAICompatibleProvider } = await import('@crowclaw/providers');

    const base = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      model: 'model-a',
    });

    const variant = base.withModel('model-b');

    // They are different objects
    expect(variant).not.toBe(base);
    expect(variant.getModel()).not.toBe(base.getModel());
  });
});

// ---------------------------------------------------------------------------
// 13. Checkpoint lifecycle regression — full save/list/restore/replay chain
// ---------------------------------------------------------------------------

describe('E2E runtime: checkpoint lifecycle regression', () => {
  it('checkpoint save/list/restore/replay still works after refactor', async () => {
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    // Create session
    await runtime.fetch(
      json('http://localhost/api/sessions/cp-verify', { userMessage: 'test' }),
    );

    // Save
    const cpRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-verify/checkpoint', { label: 'v1', trigger: 'manual' }),
    );
    const cp = await cpRes.json() as { ok: boolean; checkpoint: { id: string; label?: string } };
    expect(cp.ok).toBe(true);
    expect(typeof cp.checkpoint.id).toBe('string');

    // List
    const listRes = await runtime.fetch(
      new Request('http://localhost/api/sessions/cp-verify/checkpoints'),
    );
    const list = await listRes.json() as { checkpoints: Array<{ id: string; label?: string }> };
    expect(list.checkpoints.length).toBe(1);
    expect(list.checkpoints[0].id).toBe(cp.checkpoint.id);

    // Restore
    const restoreRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-verify/restore', { checkpointId: cp.checkpoint.id }),
    );
    const restoreData = await restoreRes.json() as { ok: boolean; restoredTo: string };
    expect(restoreData.ok).toBe(true);
    expect(restoreData.restoredTo).toBe(cp.checkpoint.id);

    // Replay
    const replayRes = await runtime.fetch(
      json('http://localhost/api/sessions/cp-verify/replay', {
        checkpointId: cp.checkpoint.id,
        newSessionId: 'cp-replay',
      }),
    );
    const replayData = await replayRes.json() as { ok: boolean; sessionId: string };
    expect(replayData.ok).toBe(true);
    expect(replayData.sessionId).toBe('cp-replay');
  });
});

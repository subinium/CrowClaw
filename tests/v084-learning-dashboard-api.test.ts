/**
 * v0.8.4 (#185) — /api/learning/dashboard contract.
 *
 * The dashboard view (automate-view.ts) consumes:
 *   - `metrics.stageCounts` for the loop diagram
 *   - `skillMetrics[]` for the per-skill metrics panel
 *   - `drafts[].stage` for the row-level status pill
 *
 * If any of these go missing, the loop diagram silently falls back to
 * the pending list, so we pin the contract here.
 */
import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('v0.8.4 #185 — learning dashboard endpoint contract', () => {
  it('returns stage, stageCounts, and skillMetrics with sane defaults', async () => {
    const runtime = createNodeRuntime();

    // Capture two drafts: one untouched (captured), one published.
    const created = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Untouched Draft',
        messages: [
          { role: 'user', content: 'do thing A' },
          { role: 'assistant', content: 'done.' },
        ],
      }),
    }));
    const createdJson = await created.json() as { id: string };
    expect(createdJson.id).toMatch(/^draft-/);

    const published = await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Will Publish',
        messages: [
          { role: 'user', content: 'do thing B' },
          { role: 'assistant', content: 'finished.' },
        ],
      }),
    }));
    const publishedJson = await published.json() as { id: string };
    await runtime.fetch(new Request(`http://localhost/api/learning/drafts/${publishedJson.id}`, {
      method: 'POST',
    }));

    const dash = await runtime.fetch(new Request('http://localhost/api/learning/dashboard'));
    const body = await dash.json() as {
      drafts: Array<{ id: string; stage: string; status: string; ratings?: { helpful: number; unhelpful: number } }>;
      skillMetrics: Array<{ slug: string; stage: string; activations: number; successRate: number | null }>;
      metrics: {
        totalDrafts: number;
        pendingDrafts: number;
        publishedDrafts: number;
        stageCounts?: Record<string, number>;
      };
    };

    // Drafts carry a derived `stage`.
    expect(body.drafts.length).toBeGreaterThanOrEqual(2);
    for (const d of body.drafts) {
      expect(['captured', 'reviewed', 'published', 'rejected']).toContain(d.stage);
      expect(d.ratings).toBeDefined();
    }

    // The freshly-published one shows up as `published`.
    const publishedRow = body.drafts.find((d) => d.id === publishedJson.id);
    expect(publishedRow?.stage).toBe('published');
    // The untouched one is `captured` (no ratings, updatedAt === createdAt at capture time).
    const capturedRow = body.drafts.find((d) => d.id === createdJson.id);
    expect(capturedRow?.stage).toBe('captured');

    // stageCounts adds up to drafts.length and contains all 4 keys.
    expect(body.metrics.stageCounts).toBeDefined();
    const counts = body.metrics.stageCounts!;
    expect(Object.keys(counts).sort()).toEqual(['captured', 'published', 'rejected', 'reviewed']);
    const sum = counts.captured + counts.reviewed + counts.published + counts.rejected;
    expect(sum).toBe(body.drafts.length);
    expect(counts.published).toBeGreaterThanOrEqual(1);
    expect(counts.captured).toBeGreaterThanOrEqual(1);

    // skillMetrics has one entry per draft and matches stage.
    expect(body.skillMetrics.length).toBe(body.drafts.length);
    for (const m of body.skillMetrics) {
      expect(['captured', 'reviewed', 'published', 'rejected']).toContain(m.stage);
      expect(typeof m.activations).toBe('number');
      // No ratings yet → successRate is null.
      expect(m.successRate).toBeNull();
    }
  });

  it('exposes stage on /api/learning/drafts/pending so the row pill can render without a second fetch', async () => {
    const runtime = createNodeRuntime();
    await runtime.fetch(new Request('http://localhost/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Pending stage check',
        messages: [
          { role: 'user', content: 'do another thing' },
          { role: 'assistant', content: 'done.' },
        ],
      }),
    }));

    const pendingResp = await runtime.fetch(new Request('http://localhost/api/learning/drafts/pending'));
    const pendingBody = await pendingResp.json() as { drafts: Array<{ stage: string; ratings: { helpful: number; unhelpful: number } }> };
    expect(pendingBody.drafts.length).toBeGreaterThanOrEqual(1);
    for (const d of pendingBody.drafts) {
      expect(['captured', 'reviewed', 'published', 'rejected']).toContain(d.stage);
      expect(d.ratings).toEqual({ helpful: 0, unhelpful: 0 });
    }
  });
});

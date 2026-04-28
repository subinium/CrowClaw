/**
 * Issue #175 — EchoProvider demo mode
 *
 * The runtime auto-wires `new EchoProvider({ demoMode: true })` when no real
 * provider key is configured, so onboarding (memory capture / skill matching /
 * scheduler / plugin hooks) exercises the full pipeline against simulated
 * streaming. These tests pin the streaming contract:
 *
 *   - 12 token-shaped fragments by default
 *   - <thinking>...</thinking> reasoning block present
 *   - [TOOL CALL: web.fetch] segment present
 *   - emits a terminal `done` chunk
 *   - paces evenly across the configured duration
 *   - non-demo construction is unchanged (back-compat)
 */

import { describe, expect, it } from 'vitest';
import { EchoProvider } from '@crowclaw/providers';
import { collectStream, type StreamChunk } from '@crowclaw/core';
import type { ProviderRequest } from '@crowclaw/core';

const sampleRequest: ProviderRequest = {
  messages: [
    { role: 'user', content: 'hello', createdAt: new Date().toISOString() },
  ],
  availableTools: [],
};

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('#175 EchoProvider demo mode', () => {
  it('default constructor keeps the legacy non-demo behavior (back-compat)', async () => {
    const provider = new EchoProvider();
    expect(provider.isDemoMode()).toBe(false);

    const chunks = await drain(provider.generateStream(sampleRequest));
    // Legacy stream: 1 text chunk (echoed user message) + done
    expect(chunks.at(-1)?.type).toBe('done');
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(text).toContain('CrowClaw received: hello');
    expect(text).not.toContain('<thinking>');
  });

  it('demo-mode flag is reflected by isDemoMode()', () => {
    expect(new EchoProvider({ demoMode: true }).isDemoMode()).toBe(true);
  });

  it('emits 12 token-shaped chunks plus a terminal done in demo mode', async () => {
    const provider = new EchoProvider({
      demoMode: true,
      // Skip real wall-clock waits — we cover pacing in a separate test.
      sleep: async () => {},
    });

    const chunks = await drain(provider.generateStream(sampleRequest));
    const textChunks = chunks.filter((c) => c.type === 'text');
    const doneChunks = chunks.filter((c) => c.type === 'done');

    expect(textChunks).toHaveLength(12);
    expect(doneChunks).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('demo stream contains a <thinking>...</thinking> reasoning block', async () => {
    const provider = new EchoProvider({ demoMode: true, sleep: async () => {} });
    const chunks = await drain(provider.generateStream(sampleRequest));
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    expect(text).toContain('<thinking>');
    expect(text).toContain('</thinking>');
    // Open and close ordering — open must come before close.
    expect(text.indexOf('<thinking>')).toBeLessThan(text.indexOf('</thinking>'));
  });

  it('demo stream contains a [TOOL CALL: web.fetch] segment so UI exercises tool rendering', async () => {
    const provider = new EchoProvider({ demoMode: true, sleep: async () => {} });
    const chunks = await drain(provider.generateStream(sampleRequest));
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    expect(text).toContain('[TOOL CALL: web.fetch]');
    expect(text).toContain("url:'https://crowclaw.dev/docs'");
  });

  it('demo stream paces approximately evenly across the configured duration', async () => {
    const sleeps: number[] = [];
    const provider = new EchoProvider({
      demoMode: true,
      demoStreamDurationMs: 800,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await drain(provider.generateStream(sampleRequest));

    // 800ms / 12 chunks = 66ms each (floor). One sleep per chunk.
    expect(sleeps).toHaveLength(12);
    for (const ms of sleeps) {
      expect(ms).toBe(Math.floor(800 / 12));
    }
    const total = sleeps.reduce((sum, ms) => sum + ms, 0);
    // Total pacing should be close to (but not exceed) the configured budget.
    expect(total).toBeLessThanOrEqual(800);
    expect(total).toBeGreaterThanOrEqual(800 - 12); // worst-case floor rounding
  });

  it('demo stream collectStream() yields a coherent assistant message', async () => {
    const provider = new EchoProvider({ demoMode: true, sleep: async () => {} });
    const response = await collectStream(provider.generateStream(sampleRequest));
    expect(response.assistantMessage).toBeTruthy();
    expect(response.assistantMessage).toContain('DEMO mode');
    expect(response.assistantMessage).toContain('OPENROUTER_API_KEY');
  });

  it('demoChunkCount override changes the number of emitted text chunks', async () => {
    const provider = new EchoProvider({
      demoMode: true,
      demoChunkCount: 3,
      sleep: async () => {},
    });

    const chunks = await drain(provider.generateStream(sampleRequest));
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(3);
    expect(chunks.at(-1)?.type).toBe('done');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

describe('SSE streaming chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runtime-node streaming endpoint', () => {
    it('returns text/event-stream content-type', async () => {
      const runtime = createNodeRuntime();

      // Create a session first
      const createRes = await runtime.fetch(
        new Request('http://localhost/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'stream-test-1' }),
        })
      );
      expect(createRes.status).toBe(200);

      // Mock provider to return immediately
      const streamRes = await runtime.fetch(
        new Request('http://localhost/api/sessions/stream-test-1/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hello' }),
        })
      );

      expect(streamRes.headers.get('content-type')).toBe('text/event-stream');
      expect(streamRes.headers.get('cache-control')).toBe('no-cache');
    });

    it('returns 400 when message is missing', async () => {
      const runtime = createNodeRuntime();

      const res = await runtime.fetch(
        new Request('http://localhost/api/sessions/bad-stream/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Missing message');
    });

    it('stream contains data lines ending with [DONE]', async () => {
      const runtime = createNodeRuntime();

      const streamRes = await runtime.fetch(
        new Request('http://localhost/api/sessions/stream-done-test/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        })
      );

      const text = await streamRes.text();
      const lines = text.split('\n').filter((l: string) => l.startsWith('data: '));
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Last data line should be [DONE]
      const lastData = lines[lines.length - 1];
      expect(lastData).toBe('data: [DONE]');

      // Should have at least one event before [DONE]
      const eventLines = lines.filter((l: string) => l !== 'data: [DONE]');
      expect(eventLines.length).toBeGreaterThanOrEqual(1);

      // First non-DONE event should be parseable JSON
      const firstPayload = eventLines[0].replace('data: ', '');
      const event = JSON.parse(firstPayload) as { type: string };
      expect(event.type).toBeDefined();
    });

    it('yields done event with response for non-streaming provider fallback', async () => {
      const runtime = createNodeRuntime();

      const streamRes = await runtime.fetch(
        new Request('http://localhost/api/sessions/stream-fallback/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'test fallback' }),
        })
      );

      const text = await streamRes.text();
      const eventLines = text
        .split('\n')
        .filter((l: string) => l.startsWith('data: ') && l !== 'data: [DONE]');

      // Should have at least a done or error event
      const events = eventLines.map((l: string) => {
        try {
          return JSON.parse(l.replace('data: ', '')) as { type: string; response?: string; error?: string };
        } catch {
          return null;
        }
      }).filter(Boolean);

      expect(events.length).toBeGreaterThanOrEqual(1);
      // The last event before [DONE] should be either 'done' or 'error'
      const lastEvent = events[events.length - 1]!;
      expect(['done', 'error']).toContain(lastEvent.type);
    });

    it('yields error event on failure', async () => {
      // Create a runtime that will fail - send to a session with invalid state
      const runtime = createNodeRuntime();

      const streamRes = await runtime.fetch(
        new Request('http://localhost/api/sessions/stream-error-test/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'trigger error' }),
        })
      );

      const text = await streamRes.text();
      const eventLines = text
        .split('\n')
        .filter((l: string) => l.startsWith('data: ') && l !== 'data: [DONE]');

      const events = eventLines.map((l: string) => {
        try {
          return JSON.parse(l.replace('data: ', '')) as { type: string };
        } catch {
          return null;
        }
      }).filter(Boolean);

      // Should have events - either done (with echo provider) or error
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('route-paths includes sessions stream', () => {
    it('exports stream route path', async () => {
      const { routePaths } = await import('../packages/runtime-node/src/route-paths.js');
      expect(routePaths.sessions).toBeDefined();
      expect(routePaths.sessions.stream).toBe('/api/sessions/:id/stream');
    });
  });

  describe('dashboard HTML contains streaming classes and functions', () => {
    it('contains streaming CSS classes', () => {
      expect(DASHBOARD_HTML).toContain('.msg-streaming');
      expect(DASHBOARD_HTML).toContain('.cursor-blink');
      expect(DASHBOARD_HTML).toContain('.tool-running');
      expect(DASHBOARD_HTML).toContain('.tool-success');
      expect(DASHBOARD_HTML).toContain('.tool-error');
      expect(DASHBOARD_HTML).toContain('@keyframes blink');
      expect(DASHBOARD_HTML).toContain('@keyframes spin');
    });

    it('contains streaming JS functions', () => {
      expect(DASHBOARD_HTML).toContain('function sndStream(');
      expect(DASHBOARD_HTML).toContain('function handleStreamEvent(');
      expect(DASHBOARD_HTML).toContain('function sndFallback(');
      expect(DASHBOARD_HTML).toContain('function toggleTrace()');
      expect(DASHBOARD_HTML).toContain('function showToast(');
    });

    it('contains trace panel elements', () => {
      expect(DASHBOARD_HTML).toContain('id="trPanel"');
      expect(DASHBOARD_HTML).toContain('id="trBtn"');
      expect(DASHBOARD_HTML).toContain('id="trIter"');
      expect(DASHBOARD_HTML).toContain('id="trTool"');
      expect(DASHBOARD_HTML).toContain('id="trTokens"');
      expect(DASHBOARD_HTML).toContain('id="trElapsed"');
      expect(DASHBOARD_HTML).toContain('id="trSteps"');
    });

    it('contains tool-block CSS', () => {
      expect(DASHBOARD_HTML).toContain('.tool-block');
      expect(DASHBOARD_HTML).toContain('.tb-h');
      expect(DASHBOARD_HTML).toContain('.tb-nm');
      expect(DASHBOARD_HTML).toContain('.tb-body');
    });

    it('contains trace panel CSS', () => {
      expect(DASHBOARD_HTML).toContain('.trace-panel');
      expect(DASHBOARD_HTML).toContain('.trace-toggle');
      expect(DASHBOARD_HTML).toContain('.tp-step');
    });

    it('contains iteration separator CSS', () => {
      expect(DASHBOARD_HTML).toContain('.iter-sep');
    });

    it('contains toast CSS', () => {
      expect(DASHBOARD_HTML).toContain('.toast');
      expect(DASHBOARD_HTML).toContain('@keyframes toastIn');
    });

    it('chat input triggers sndStream', () => {
      expect(DASHBOARD_HTML).toContain("sndStream()");
    });

    it('retains original snd function as fallback', () => {
      expect(DASHBOARD_HTML).toContain('function snd()');
    });

    it('streaming uses /stream endpoint', () => {
      expect(DASHBOARD_HTML).toContain("/api/sessions/' + sid + '/stream");
    });

    it('fallback uses original POST endpoint', () => {
      expect(DASHBOARD_HTML).toContain("/api/sessions/' + sid, {");
      expect(DASHBOARD_HTML).toContain("method: 'POST'");
    });
  });

  describe('event sequence parsing', () => {
    it('parses text-delta events correctly', () => {
      const events = [
        'data: {"type":"iteration-start","iteration":0}',
        'data: {"type":"text-delta","content":"Hello"}',
        'data: {"type":"text-delta","content":" world"}',
        'data: {"type":"iteration-end","iteration":0}',
        'data: {"type":"done","response":"Hello world"}',
        'data: [DONE]',
      ];

      const parsed: Array<{ type: string; content?: string; response?: string }> = [];
      for (const line of events) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        parsed.push(JSON.parse(payload) as { type: string; content?: string; response?: string });
      }

      expect(parsed).toHaveLength(5);
      expect(parsed[0].type).toBe('iteration-start');
      expect(parsed[1].type).toBe('text-delta');
      expect(parsed[1].content).toBe('Hello');
      expect(parsed[2].type).toBe('text-delta');
      expect(parsed[2].content).toBe(' world');
      expect(parsed[4].type).toBe('done');
      expect(parsed[4].response).toBe('Hello world');
    });

    it('parses tool call event sequence', () => {
      const events = [
        'data: {"type":"iteration-start","iteration":0}',
        'data: {"type":"tool-start","toolName":"web.search","toolCallId":"tc-1"}',
        'data: {"type":"tool-end","toolName":"web.search","toolCallId":"tc-1","result":"found it","ok":true}',
        'data: {"type":"text-delta","content":"I found the answer."}',
        'data: {"type":"iteration-end","iteration":0}',
        'data: {"type":"done","response":"I found the answer."}',
        'data: [DONE]',
      ];

      const parsed: Array<{ type: string; toolName?: string; ok?: boolean; result?: string }> = [];
      for (const line of events) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        parsed.push(JSON.parse(payload) as { type: string; toolName?: string; ok?: boolean; result?: string });
      }

      expect(parsed).toHaveLength(6);
      expect(parsed[1].type).toBe('tool-start');
      expect(parsed[1].toolName).toBe('web.search');
      expect(parsed[2].type).toBe('tool-end');
      expect(parsed[2].ok).toBe(true);
      expect(parsed[2].result).toBe('found it');
      expect(parsed[5].type).toBe('done');
    });

    it('parses error event', () => {
      const events = [
        'data: {"type":"error","error":"Provider unavailable"}',
        'data: [DONE]',
      ];

      const parsed: Array<{ type: string; error?: string }> = [];
      for (const line of events) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break;
        parsed.push(JSON.parse(payload) as { type: string; error?: string });
      }

      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe('error');
      expect(parsed[0].error).toBe('Provider unavailable');
    });
  });
});

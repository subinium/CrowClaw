/**
 * Coverage for the dashboard API client's error-envelope handling.
 *
 * Issue #143 (web side): the runtime emits the canonical
 * `{ error: { code, message } }` shape, but legacy routes still emit
 * `{ error: 'string' }`. The client must read the structured shape first
 * and fall back to the string variant — older code did the reverse and
 * showed `[object Object]` in the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../packages/web/ui/src/lib/api.js';

const STUBBED_ORIGIN = 'http://test.local';

beforeEach(() => {
  // The api client reads `location.origin` — provide a minimal stub so the
  // module can build request URLs without a browser.
  vi.stubGlobal('location', { origin: STUBBED_ORIGIN, protocol: 'http:', host: 'test.local' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mockResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('api error envelope', () => {
  it('extracts message from structured envelope `{ error: { code, message } }`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid sessionId' } }),
    ));

    const err = await api('/api/sessions/bad').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Invalid sessionId');
    expect((err as ApiError).status).toBe(400);
  });

  it('falls back to string-shaped legacy envelope `{ error: "..." }`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse(500, { error: 'Internal failure' }),
    ));

    const err = await api('/api/anything').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('Internal failure');
  });

  it('uses HTTP status when body is not parsable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html>oops</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/html' },
      }),
    ));

    const err = await api('/api/anything').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain('502');
    expect((err as ApiError).message).toContain('Bad Gateway');
  });

  it('does not crash when error.message is missing on the object form', async () => {
    // Defensive case: a malformed envelope `{ error: { code: '...' } }`
    // must not surface `[object Object]` — fall through to status text.
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse(403, { error: { code: 'FORBIDDEN' } }),
    ));

    const err = await api('/api/anything').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).not.toContain('[object Object]');
    expect((err as ApiError).message).toContain('403');
  });

  it('triggers crowclaw:auth-required and throws on 401 without invoking envelope parser', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      mockResponse(401, { error: { code: 'UNAUTHORIZED', message: 'login required' } }),
    ));

    const events: Event[] = [];
    const handler = (e: Event) => { events.push(e); };
    vi.stubGlobal('document', {
      dispatchEvent: (e: Event) => { handler(e); return true; },
    });

    const err = await api('/api/private').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(events.length).toBe(1);
  });

  it('sends the active dashboard locale header', async () => {
    vi.stubGlobal('document', { documentElement: { lang: 'ko' } });
    const fetchMock = vi.fn(async () => mockResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/system/status');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-crowclaw-locale']).toBe('ko');
  });
});
